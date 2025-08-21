#!/usr/bin/env python3
"""
Dynamic line-by-line data-flow analyzer.

Usage:
    python dyn_flow.py <target_python_file> <output_file>

Behavior:
- Executes the target Python program with tracing enabled (only code originating
  from the target file is analyzed; imported files are ignored).
- For each time each line is executed, it collects all variable names present
  on that line (both used and assigned, per AST of the target file).
- For each such variable v, it prints a separate line "l,e,v,d" for every
  dependency d of v at that moment. Dependencies include both direct and
  transitive variable dependencies (deduplicated). Builtins are ignored as
  dependencies.
- If v's value depends on no variables (e.g., v = 42), nothing is printed
  for that v on that execution.

Notes & limitations:
- This is dynamic *line-level* propagation based on names appearing on that line's AST.
  It does not introspect into called functions' internals.
- Multiple assignments on the same line are approximated by treating each target on
  that line as depending on the union of all RHS names from that line.
- Container mutation (e.g., a[i] = b) does not count as reassigning 'a'.
- Globals vs locals are handled best-effort; analysis keys dependencies by the current
  frame but outputs only the bare variable name.
"""

import ast
import sys
import os
import runpy
import types
from collections import defaultdict

def read_file_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

class LineVarCollector(ast.NodeVisitor):
    """
    Collects, per source line (1-based):
      - variables used (Load),
      - variables assigned (Store),
      - variables on the RHS of assignments / iterables of loops / with-exprs.
    """
    def __init__(self):
        self.used_by_line = defaultdict(set)       # line -> set[str]
        self.assigned_by_line = defaultdict(set)   # line -> set[str]
        self.rhs_by_line = defaultdict(set)        # line -> set[str]
        self.all_vars_by_line = defaultdict(set)   # line -> set[str]

    def _names_in(self, node, ctx_types):
        out = set()
        for n in ast.walk(node):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ctx_types):
                out.add(n.id)
        return out

    def _targets_names(self, target):
        # Collect all Name nodes that are in Store context within a target tree
        return self._names_in(target, (ast.Store,))

    def _value_names(self, value):
        # Collect all Name nodes that are in Load context within a value tree
        return self._names_in(value, (ast.Load,))

    # --- Statement visitors to improve rhs_by_line fidelity ---

    def visit_Assign(self, node: ast.Assign):
        line = node.lineno
        # Assigned
        assigned = set()
        for t in node.targets:
            assigned |= self._targets_names(t)
        if assigned:
            self.assigned_by_line[line] |= assigned
        # RHS names
        self.rhs_by_line[line] |= self._value_names(node.value)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign):
        # Only treat as assignment if it has a value (annotation-only has no value)
        if node.value is not None:
            line = node.lineno
            self.assigned_by_line[line] |= self._targets_names(node.target)
            self.rhs_by_line[line] |= self._value_names(node.value)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign):
        line = node.lineno
        # Target is assigned, but also read (x += y reads x)
        tnames = self._targets_names(node.target)
        self.assigned_by_line[line] |= tnames
        # RHS includes value names and the target name itself
        self.rhs_by_line[line] |= self._value_names(node.value)
        # Add target name(s) as also used on RHS
        # (Name target appears in Store context; add its id explicitly)
        for n in ast.walk(node.target):
            if isinstance(n, ast.Name):
                self.rhs_by_line[line].add(n.id)
        self.generic_visit(node)

    def visit_For(self, node: ast.For):
        line = node.lineno
        # for target in iter: target assigned from iter's value(s)
        self.assigned_by_line[line] |= self._targets_names(node.target)
        self.rhs_by_line[line] |= self._value_names(node.iter)
        self.generic_visit(node)

    def visit_With(self, node: ast.With):
        line = node.lineno
        for item in node.items:
            if item.optional_vars is not None:
                self.assigned_by_line[line] |= self._targets_names(item.optional_vars)
            if item.context_expr is not None:
                self.rhs_by_line[line] |= self._value_names(item.context_expr)
        self.generic_visit(node)

    # Fallback to collect used/assigned names anywhere
    def visit_Name(self, node: ast.Name):
        line = node.lineno
        if isinstance(node.ctx, ast.Load):
            self.used_by_line[line].add(node.id)
        elif isinstance(node.ctx, ast.Store):
            self.assigned_by_line[line].add(node.id)
        # (Del ctx ignored)
        self.generic_visit(node)

    def finalize(self):
        # Build union set of all variables seen on each line
        for line in set(self.used_by_line.keys()) | set(self.assigned_by_line.keys()):
            self.all_vars_by_line[line] = (
                set(self.used_by_line.get(line, set())) |
                set(self.assigned_by_line.get(line, set()))
            )

class Analyzer:
    def __init__(self, source_path: str, output_path: str):
        self.source_abspath = os.path.abspath(source_path)
        self.output_path = output_path
        self.records = []  # list of "l,e,v,d"
        self.line_exec_count = defaultdict(int)  # line -> count
        # Dependencies per frame (id(frame) -> {var: set(deps)})
        self.frame_deps = defaultdict(lambda: defaultdict(set))
        # Global deps (module level)
        self.global_deps = defaultdict(set)

        # Parse and collect line->names
        src = read_file_text(self.source_abspath)
        self.tree = ast.parse(src, filename=self.source_abspath)
        self.collector = LineVarCollector()
        self.collector.visit(self.tree)
        self.collector.finalize()

        # For quick access in tracer
        self.vars_by_line = self.collector.all_vars_by_line
        self.assigned_by_line = self.collector.assigned_by_line
        self.rhs_by_line = self.collector.rhs_by_line
        self.used_by_line = self.collector.used_by_line


    # -------- Dependency helpers --------

    def _is_builtin(self, name: str, frame) -> bool:
        try:
            builtins_dict = frame.f_builtins if hasattr(frame, "f_builtins") else __builtins__
            if isinstance(builtins_dict, dict):
                return name in builtins_dict
            return hasattr(builtins_dict, name)
        except Exception:
            return False

    def _get_current_deps_for(self, frame, var: str):
        """Get current dependency set for var in the given frame context."""
        fid = id(frame)
        is_module_level = frame.f_locals is frame.f_globals
        if var in frame.f_locals:
            # At module level, dependencies are tracked in global_deps
            if is_module_level:
                return set(self.global_deps.get(var, set()))
            # Inside a function, use the per-frame map
            return set(self.frame_deps[fid].get(var, set()))
        if var in frame.f_globals:
            return set(self.global_deps.get(var, set()))
        return set()


    def _set_deps_for_assignment(self, frame, targets, rhs_names):
        """Update dependencies for assigned vars in 'targets', using RHS names."""
        # Remove builtins from RHS consideration
        rhs_names = [n for n in rhs_names if not self._is_builtin(n, frame)]

        # Union of deps for all sources, plus the source names themselves
        union_deps = set()
        for src in rhs_names:
            union_deps |= self._get_current_deps_for(frame, src)
            union_deps.add(src)

        fid = id(frame)
        for tgt in targets:
            # Try to guess scope: update locals if we're in a function frame,
            # otherwise update globals (module-level: locals is globals).
            # We'll check module-level by comparing namespaces.
            is_module_level = frame.f_locals is frame.f_globals
            if is_module_level:
                self.global_deps[tgt] = set(union_deps)
            else:
                self.frame_deps[fid][tgt] = set(union_deps)

    # -------- Tracer --------

    def tracer(self, frame, event, arg):
        try:
            # Only analyze events originating from the target file
            if frame.f_code.co_filename != self.source_abspath:
                return self.tracer

            if event == "line":
                line = frame.f_lineno

                # Predict post-line assignments using static RHS names for this line
                assigned = self.assigned_by_line.get(line, set())
                rhs = self.rhs_by_line.get(line, set())
                if assigned:
                    self._set_deps_for_assignment(frame, assigned, list(rhs))

                # Increment per-line execution count
                self.line_exec_count[line] += 1
                ecount = self.line_exec_count[line]

                # Report all variables present on this line using *post*-line deps
                # Emit only for variables that are READ on this line,
                # plus targets that are also read (e.g., in AugAssign).
                emit_vars = set(self.used_by_line.get(line, set()))
                emit_vars |= (self.assigned_by_line.get(line, set()) & self.rhs_by_line.get(line, set()))

                for v in sorted(emit_vars):
                    deps = self._get_current_deps_for(frame, v)
                    for d in sorted(deps):
                        self.records.append(f"{frame.f_lineno},{ecount},{v},{d}")


            return self.tracer
        except Exception:
            # Never let tracer exceptions crash the target program.
            return self.tracer

    # -------- Run target and write output --------

    def run(self):
        prev_trace = sys.gettrace()
        try:
            sys.settrace(self.tracer)
            # Ensure the target directory is importable
            target_dir = os.path.dirname(self.source_abspath)
            if target_dir and target_dir not in sys.path:
                sys.path.insert(0, target_dir)

            # Execute the target as if it were run as a script
            runpy.run_path(self.source_abspath, run_name="__main__")
        finally:
            sys.settrace(prev_trace)
            # Always write results
            with open(self.output_path, "w", encoding="utf-8") as f:
                for rec in self.records:
                    f.write(rec + "\n")

def main(argv):
    if len(argv) != 3:
        print("Usage: python dyn_flow.py <source_file> <output_file>")
        sys.exit(1)
    
    source_file = argv[1]
    output_file = argv[2]

    analyzer = Analyzer(source_file, output_file)
    analyzer.run()

if __name__ == "__main__":
    main(sys.argv)
