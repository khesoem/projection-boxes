import type { DataFlowRecord } from "../types";
import { ensurePyodide } from "./python";

export async function runDataFlowAnalysis(codeToAnalyze: string): Promise<DataFlowRecord[]> {
  const pyodide = await ensurePyodide();
  
  // Embed the dyn_flow.py code directly instead of downloading it
  const tempCode = `
import tempfile
import os
import sys
import ast
import runpy
from collections import defaultdict

def read_file_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

class LineVarCollector(ast.NodeVisitor):
    def __init__(self):
        self.used_by_line = defaultdict(set)
        self.assigned_by_line = defaultdict(set)
        self.rhs_by_line = defaultdict(set)
        self.all_vars_by_line = defaultdict(set)

    def _names_in(self, node, ctx_types):
        out = set()
        for n in ast.walk(node):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ctx_types):
                out.add(n.id)
        return out

    def _targets_names(self, target):
        return self._names_in(target, (ast.Store,))

    def _value_names(self, value):
        return self._names_in(value, (ast.Load,))

    def visit_Assign(self, node: ast.Assign):
        line = node.lineno
        assigned = set()
        for t in node.targets:
            assigned |= self._targets_names(t)
        if assigned:
            self.assigned_by_line[line] |= assigned
        self.rhs_by_line[line] |= self._value_names(node.value)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign):
        if node.value is not None:
            line = node.lineno
            self.assigned_by_line[line] |= self._targets_names(node.target)
            self.rhs_by_line[line] |= self._value_names(node.value)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign):
        line = node.lineno
        tnames = self._targets_names(node.target)
        self.assigned_by_line[line] |= tnames
        self.rhs_by_line[line] |= self._value_names(node.value)
        for n in ast.walk(node.target):
            if isinstance(n, ast.Name):
                self.rhs_by_line[line].add(n.id)
        self.generic_visit(node)

    def visit_For(self, node: ast.For):
        line = node.lineno
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

    def visit_Name(self, node: ast.Name):
        line = node.lineno
        if isinstance(node.ctx, ast.Load):
            self.used_by_line[line].add(node.id)
        elif isinstance(node.ctx, ast.Store):
            self.assigned_by_line[line].add(node.id)
        self.generic_visit(node)

    def finalize(self):
        for line in set(self.used_by_line.keys()) | set(self.assigned_by_line.keys()):
            self.all_vars_by_line[line] = (
                set(self.used_by_line.get(line, set())) |
                set(self.assigned_by_line.get(line, set()))
            )

class Analyzer:
    def __init__(self, source_path: str):
        self.source_abspath = os.path.abspath(source_path)
        self.records = []
        self.line_exec_count = defaultdict(int)
        self.frame_deps = defaultdict(lambda: defaultdict(set))
        self.global_deps = defaultdict(set)

        src = read_file_text(self.source_abspath)
        self.tree = ast.parse(src, filename=self.source_abspath)
        self.collector = LineVarCollector()
        self.collector.visit(self.tree)
        self.collector.finalize()

        self.vars_by_line = self.collector.all_vars_by_line
        self.assigned_by_line = self.collector.assigned_by_line
        self.rhs_by_line = self.collector.rhs_by_line
        self.used_by_line = self.collector.used_by_line

    def _is_builtin(self, name: str, frame) -> bool:
        try:
            builtins_dict = frame.f_builtins if hasattr(frame, "f_builtins") else __builtins__
            if isinstance(builtins_dict, dict):
                return name in builtins_dict
            return hasattr(builtins_dict, name)
        except Exception:
            return False

    def _get_current_deps_for(self, frame, var: str):
        fid = id(frame)
        is_module_level = frame.f_locals is frame.f_globals
        if var in frame.f_locals:
            if is_module_level:
                return set(self.global_deps.get(var, set()))
            return set(self.frame_deps[fid].get(var, set()))
        if var in frame.f_globals:
            return set(self.global_deps.get(var, set()))
        return set()

    def _set_deps_for_assignment(self, frame, targets, rhs_names):
        cleaned_rhs = [n for n in rhs_names if not self._is_builtin(n, frame)]
        union_deps = set()
        for src in cleaned_rhs:
            union_deps |= self._get_current_deps_for(frame, src)
            # keep the source name itself (allows self-edge for s = s + x on later iters)
            union_deps.add(src)

        fid = id(frame)
        is_module_level = frame.f_locals is frame.f_globals
        for tgt in targets:
            if is_module_level:
                self.global_deps[tgt] = set(union_deps)
            else:
                self.frame_deps[fid][tgt] = set(union_deps)


    def tracer(self, frame, event, arg):
        try:
            if frame.f_code.co_filename != self.source_abspath:
                return self.tracer

            if event == "line":
                line = frame.f_lineno

                assigned = self.assigned_by_line.get(line, set())
                rhs = self.rhs_by_line.get(line, set())

                # 1) Figure out which vars are READ on this line
                emit_vars = set(self.used_by_line.get(line, set()))
                # (Also cover cases like x += y where target is read)
                emit_vars |= (self.assigned_by_line.get(line, set()) & self.rhs_by_line.get(line, set()))

                # 2) SNAPSHOT pre-line deps for reads
                pre_deps = {v: self._get_current_deps_for(frame, v) for v in emit_vars}

                # 3) Now apply the assignment (updates post-line deps)
                if assigned:
                    self._set_deps_for_assignment(frame, assigned, list(rhs))

                # 4) Increment execution count and EMIT using pre-line deps
                self.line_exec_count[line] += 1
                ecount = self.line_exec_count[line]
                for v in sorted(emit_vars):
                    for d in sorted(pre_deps[v]):
                        self.records.append(f"{line},{ecount},{v},{d}")

            return self.tracer
        except Exception:
            return self.tracer

    def run(self):
        prev_trace = sys.gettrace()
        try:
            sys.settrace(self.tracer)
            target_dir = os.path.dirname(self.source_abspath)
            if target_dir and target_dir not in sys.path:
                sys.path.insert(0, target_dir)
            runpy.run_path(self.source_abspath, run_name="__main__")
        finally:
            sys.settrace(prev_trace)
            return self.records

# Create temporary file with user code
with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
    f.write(${JSON.stringify(codeToAnalyze)})
    temp_file = f.name

# Run analysis
analyzer = Analyzer(temp_file)
results = analyzer.run()

print(f"Data-flow analysis results: {len(results)} records")
print("Sample results:")
for i, result in enumerate(results[:10]):
    print(f"  {i+1}: {result}")

# Convert to list of dictionaries for easier JavaScript access
result_list = []
for result in results:
    parts = result.split(",")
    if len(parts) == 4:
        result_list.append({
            "line": int(parts[0]),
            "execution": int(parts[1]),
            "variable": parts[2],
            "dependency": parts[3]
        })

# Clean up temporary file
os.unlink(temp_file)

# Return the result list directly
result_list
`;
  
  const results = await pyodide.runPythonAsync(tempCode);
  // Convert Python list[dict] -> plain JS array of objects
  let finalResults: DataFlowRecord[] = [];
  try {
    // Pyodide PyProxy -> JS
    finalResults = (results as { toJs: (config: { dict_converter: typeof Object.fromEntries }) => DataFlowRecord[] }).toJs({ dict_converter: Object.fromEntries });
  } catch (err) {
    console.warn("Primary toJs() conversion failed, falling back to JSON bridge.", err);
    // Fallback: re-materialize in Python as JSON (same interpreter session)
    const jsonStr = await pyodide.runPythonAsync("import json; json.dumps(result_list)");
    finalResults = JSON.parse(String(jsonStr));
  }

  // Avoid leaking the PyProxy
  try { 
    if ((results as { destroy?: () => void }).destroy) {
      (results as { destroy: () => void }).destroy();
    }
  } catch {
    // Ignore errors when destroying PyProxy
  }

  return finalResults;
}
