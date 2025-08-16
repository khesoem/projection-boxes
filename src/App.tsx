import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { RefreshCcw, Play, Grid } from "lucide-react";

// --- Lightweight UI helpers (Tailwind) ---
const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = "", children, ...rest }) => (
  <button className={`px-3 py-2 rounded-2xl bg-neutral-900 text-white hover:bg-neutral-800 transition ${className}`} {...rest}>{children}</button>
);
const Card: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = "", children }) => (
  <div className={`bg-white rounded-2xl border border-neutral-200 ${className}`}>{children}</div>
);
const CardContent: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = "", children }) => (
  <div className={`p-4 ${className}`}>{children}</div>
);
const Toggle: React.FC<{ pressed?: boolean; onPressedChange?: (v: boolean) => void; className?: string; children: React.ReactNode }> = ({ pressed, onPressedChange, className = "", children }) => (
  <button
    onClick={() => onPressedChange && onPressedChange(!pressed)}
    className={`px-3 py-2 rounded-2xl border transition ${pressed ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-800 border-neutral-300 hover:bg-neutral-50'} ${className}`}
  >{children}</button>
);


// --- Utility types ---
type TraceRow = { line: number; vars: Record<string, string> };
type Box = { line: number; rows: TraceRow[] };

type ViewMode = "full" | "summary" | "row" | "stealth";

type Orientation = "columns" | "rows"; // columns: variables across columns; rows: variables down rows (Victor-style)

// --- Sample Python program (inspired by the paper) ---
const SAMPLE = `def f():
    a = [0, 2, 8, 1]
    s, n = 0, 0
    for x in a:
        s = s + x
        n = n + 1
    avg = s / n
    return avg

print(f())`;

// --- Pyodide Loader ---
async function ensurePyodide(): Promise<any> {
  const globalAny = globalThis as any;
  if (globalAny.__pyodidePromise) return globalAny.__pyodidePromise;
  globalAny.__pyodidePromise = new Promise(async (resolve, reject) => {
    try {
      if (!(globalAny as any).loadPyodide) {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js";
        script.onload = async () => {
          try {
            const pyodide = await (globalThis as any).loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/" });
            resolve(pyodide);
          } catch (e) {
            reject(e);
          }
        };
        script.onerror = reject;
        document.head.appendChild(script);
      } else {
        const pyodide = await (globalThis as any).loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/" });
        resolve(pyodide);
      }
    } catch (e) {
      reject(e);
    }
  });
  return globalAny.__pyodidePromise;
}

// Compute a simple diff of changed variables per line occurrence
function computeChangedVars(rows: TraceRow[]): Set<string> {
  const changed = new Set<string>();
  let prev: Record<string, string> | null = null;
  for (const r of rows) {
    if (!prev) { prev = r.vars; continue; }
    for (const k of Object.keys(r.vars)) {
      if (!(k in prev) || prev[k] !== r.vars[k]) changed.add(k);
    }
    prev = r.vars;
  }
  return changed;
}

function useCaretLine(textareaRef: React.RefObject<HTMLTextAreaElement | null>): number | null {
  const [line, setLine] = useState<number | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    
    const handler = () => {
      const pos = el.selectionStart || 0;
      const pre = el.value.slice(0, pos);
      setLine(pre.split("\n").length);
    };
    
    // Only track on click and focus, not on every input
    el.addEventListener("click", handler);
    el.addEventListener("focus", handler);
    
    // Initial call
    handler();
    
    return () => {
      el.removeEventListener("click", handler);
      el.removeEventListener("focus", handler);
    };
  }, [textareaRef]);
  return line;
}

// --- Safer source injection: avoid manual escaping by embedding JSON literal ---
function buildPythonDriverSource(userCode: string): string {
  const jsonSourceLiteral = JSON.stringify(userCode);
  return `
import sys, json, ast
trace_data = []

# Function to capture variable state
def __capture_state(line_num, frame):
    d = {}
    try:
        # Get local variables from the frame, filtering out built-ins and globals
        for k, v in frame.f_locals.items():
            # Skip built-in variables and special variables
            if k.startswith('__') or k in ['__builtins__', '__name__', '__doc__', '__package__', '__loader__', '__spec__']:
                continue
            # Skip if it's a built-in function or class
            if hasattr(v, '__module__') and v.__module__ == 'builtins':
                continue
            # Skip function objects (including user-defined functions)
            if callable(v):
                continue
            try:
                d[k] = repr(v)
            except Exception:
                try:
                    d[k] = str(v)
                except Exception:
                    d[k] = '<unrepr>'
    except Exception:
        pass
    # Only add to trace_data if we have actual user variables
    if d:
        trace_data.append({'line': line_num, 'vars': d})

# Custom tracer that should work better in Pyodide
def __tracer(frame, event, arg):
    if event == 'line':
        # Only trace lines in user code
        if hasattr(frame, 'f_code') and hasattr(frame.f_code, 'co_filename'):
            if frame.f_code.co_filename == '<user>' or frame.f_code.co_filename == '<string>':
                # For now, let's use the frame line number directly
                # We'll need to map this to the correct source line
                __capture_state(frame.f_lineno, frame)
    return __tracer

from io import StringIO
__buf = StringIO()
__old_stdout = sys.stdout
sys.stdout = __buf

__err = None

# --- run user's program with tracing ---
def __run_user():
    __g = {}
    __source = ${jsonSourceLiteral}
    
    # Try to set up tracing
    try:
        sys.settrace(__tracer)
        exec(compile(__source, '<user>', 'exec'), __g, __g)
    except Exception as e:
        print(f"Tracing failed: {e}")
        # Fallback: execute without tracing
        exec(compile(__source, '<user>', 'exec'), __g, __g)
    finally:
        sys.settrace(None)

try:
    __run_user()
except Exception as e:
    __err = repr(e)
finally:
    sys.stdout = __old_stdout

# Debug: print trace data to see if it's working
print("DEBUG: trace_data length:", len(trace_data))
for i, item in enumerate(trace_data):
    print(f"DEBUG: trace[{i}] = {item}")

# Convert to JSON for easier JavaScript access
import json
trace_data_json = json.dumps(trace_data)
`;
}

// Main component
export default function ProjectionBoxesDemo() {
  const [code, setCode] = useState(SAMPLE);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [stdout, setStdout] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "running" | "ok" | "error" | "modified">("idle");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("full");
  const [orientation, setOrientation] = useState<Orientation>("columns");
  const [filter, setFilter] = useState<string>("");
  const [appliedFilter, setAppliedFilter] = useState<string>("");
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [lastExecutedCode, setLastExecutedCode] = useState<string>(SAMPLE);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const activeLine = useCaretLine(editorRef);

  // Update status when code changes
  useEffect(() => {
    if (code !== lastExecutedCode) {
      if (status === "ok" || status === "error") {
        setStatus("modified");
      }
    }
  }, [code, lastExecutedCode, status]);

  // Keyboard shortcuts for view presets (as in the paper UI suggestion)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "1") setView("full");
      if (e.key === "2") setView("stealth");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filteredBoxes = useMemo(() => {
    if (view === "stealth") return [];
    let bs = boxes;
    // Summary view: show current line and last executed line only
    if (view === "summary") {
      const last = boxes[boxes.length - 1]?.line;
      const lines = new Set<number>();
      if (activeLine) lines.add(activeLine);
      if (last != null) lines.add(last);
      bs = boxes.filter((b) => lines.has(b.line));
    }
    // Row view uses variables as rows (Victor-like) later in rendering
    if (!appliedFilter.trim()) return bs;
    // Simple filter mini-language: `keep:REGEX` or `del:REGEX`
    const m = appliedFilter.match(/^(keep|del):(.+)$/i);
    if (!m) return bs;
    const [, kind, pat] = m;
    const re = new RegExp(pat);
    return bs.map((b) => ({
      line: b.line,
      rows: b.rows.map((r) => ({
        line: r.line,
        vars: Object.fromEntries(Object.entries(r.vars).filter(([k]) =>
          (kind.toLowerCase() === "keep" ? re.test(k) : !re.test(k))
        )),
      })),
    }));
  }, [boxes, view, activeLine, appliedFilter]);

  async function execute(codeToRun: string) {
    const pyodide: any = await ensurePyodide();
    const driver = buildPythonDriverSource(codeToRun);
    console.log("Generated driver code:", driver);
    
    try {
      // Start line tracing
      await pyodide.runPythonAsync("import sys\nsys.settrace(None)");
      await pyodide.runPythonAsync(driver);
      const out = await pyodide.runPythonAsync(`__buf.getvalue()`);
      const err = await pyodide.runPythonAsync(`__err`);
      const jsRows: any[] = await pyodide.runPythonAsync(`trace_data`);
      const traceDataJson = await pyodide.runPythonAsync(`trace_data_json`);
      
      console.log("Execution results:", { out, err, jsRows, jsRowsLength: jsRows?.length });
      console.log("Trace data JSON:", traceDataJson);
      
      // Parse the JSON string to get proper JavaScript objects
      const convertedRows = JSON.parse(traceDataJson);
      
      console.log("Converted rows:", convertedRows);
      
      return { out: String(out || ""), err: (err && String(err) !== "None") ? String(err) : null, rows: convertedRows };
    } catch (e) {
      console.error("Execute error:", e);
      throw e;
    }
  }

  async function run() {
    setStatus("running");
    setError(null);
    setStdout("");
    try {
      const { out, err, rows } = await execute(code);
      console.log("Run function received:", { out, err, rows, rowsLength: rows?.length });
      setStdout(out);
      if (err) {
        setError(err);
        setStatus("error");
      } else {
        // Group rows by line with line number mapping
        const grouped = new Map<number, TraceRow[]>();
        console.log("Raw rows data:", rows);
        for (const r of rows as any[]) {
          console.log("Processing row:", r, "line type:", typeof r.line, "line value:", r.line);
          const originalLine = Number(r.line);
          console.log("Converted line number:", originalLine, "isNaN:", isNaN(originalLine));
          // Map function line numbers to source line numbers
          // Function body starts at line 2, so map 2->2, 3->3, etc.
          const sourceLine = originalLine;
          const vars = r.vars as Record<string, string>;
          if (!grouped.has(sourceLine)) grouped.set(sourceLine, []);
          grouped.get(sourceLine)!.push({ line: sourceLine, vars });
        }
        const bs: Box[] = Array.from(grouped.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([line, rows]) => ({ line, rows }));
        console.log("Processed boxes:", bs);
        console.log("Box details:", bs.map(b => ({ line: b.line, rowCount: b.rows.length, firstRowVars: b.rows[0]?.vars })));
        console.log("Available line numbers in boxes:", bs.map(b => b.line));
        console.log("Sample code lines:", code.split('\\n').map((line, i) => `${i+1}: ${line}`));
        setBoxes(bs);
        setStatus("ok");
        setLastExecutedCode(code);
      }
    } catch (e: any) {
      console.error("Run error:", e);
      setError(String(e?.message || e));
      setStatus("error");
    }
  }



  // Presentation helpers
  const lines = useMemo(() => code.split("\n"), [code]);



  return (
    <div className="w-full min-h-screen bg-neutral-50 p-6 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Projection Boxes – Web Prototype</h1>
          <span className="text-sm text-neutral-500">(React + Pyodide)</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot status={status} />
          <Button onClick={run} className="gap-2"><Play className="w-4 h-4"/>Run</Button>
        </div>
      </div>

      {/* Controls */}
      <Card className="shadow-sm">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-600">View:</span>
            <Toggle pressed={view === "full"} onPressedChange={() => setView("full")} className="gap-2"><Grid className="w-4 h-4"/> Full</Toggle>
            <Toggle pressed={view === "stealth"} onPressedChange={() => setView("stealth")} className="gap-2"><RefreshCcw className="w-4 h-4"/> Stealth</Toggle>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-600">Orientation:</span>
            <Toggle pressed={orientation === "columns"} onPressedChange={() => setOrientation("columns")}>Columns</Toggle>
            <Toggle pressed={orientation === "rows"} onPressedChange={() => setOrientation("rows")}>Rows</Toggle>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-600">Variables filter:</span>
            <input 
              value={filter} 
              onChange={(e)=>setFilter(e.target.value)} 
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setAppliedFilter(filter);
                }
              }}
              placeholder="keep:^[snx] | del:^_" 
              className="px-2 py-1 rounded border text-sm w-64"
            />
            <Button 
              onClick={() => setAppliedFilter(filter)} 
              className="px-2 py-1 text-xs"
            >
              Apply
            </Button>
          </div>
          
        </CardContent>
      </Card>



      {/* Editor + Projection layer */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="shadow-sm">
          <CardContent className="p-0">
            <textarea
              ref={editorRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const target = e.target as HTMLTextAreaElement;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  const newValue = code.substring(0, start) + '    ' + code.substring(end);
                  setCode(newValue);
                  // Set cursor position after the tab
                  setTimeout(() => {
                    target.selectionStart = target.selectionEnd = start + 4;
                  }, 0);
                }
              }}
              className="w-full h-[520px] resize-none font-mono text-sm p-4 outline-none border-0 rounded-t-2xl"
              spellCheck={false}
            />
            <div className="border-t bg-neutral-50 px-4 py-2 text-xs text-neutral-600 flex items-center justify-between">
              <div>Stdout: <span className="font-mono">{stdout ? stdout : "(empty)"}</span></div>
              {error && <div className="text-red-600">{String(error)}</div>}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardContent className="p-0">
            <div className="h-[560px] overflow-auto divide-y">
              {lines.map((lineText, idx) => {
                const b = filteredBoxes.find((x) => x.line === idx + 1);
                return (
                  <div key={idx} className="grid grid-cols-12 items-stretch" onMouseEnter={() => setHoverLine(idx + 1)} onMouseLeave={() => setHoverLine(null)}>
                    {/* Code line number + text (readonly mirror for alignment) */}
                    <div className="col-span-5 font-mono text-xs px-3 py-1 bg-white">
                      <span className="text-neutral-400 select-none w-8 inline-block text-right mr-2">{idx + 1}</span>
                      <span className="whitespace-pre">{lineText || "\u00a0"}</span>
                    </div>

                    {/* Projection box */}
                    <div className="col-span-7 relative">
                      {hoverLine === idx + 1 && (
                        <motion.div
                          className="absolute top-2 left-2 z-10 pointer-events-none"
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                        >
                          <div className="scale-95 opacity-95">
                            {b ? (
                              <ProjectionBox
                                box={b}
                                orientation={orientation}
                                rowMode={view === "row"}
                              />
                            ) : (
                              <div className="rounded-2xl shadow-sm bg-white ring-1 ring-neutral-200 p-4 text-xs text-neutral-500">
                                <div className="font-medium mb-1">Line {idx + 1}</div>
                                <div>No execution data available</div>
                                <div className="text-[10px] mt-1">Run the code to see variable values</div>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="text-xs text-neutral-500">Tip: Hover over code lines to see variable values. Press 1=Full view, 2=Stealth mode. Run code to see execution data.</div>
    </div>
  );
}

function StatusDot({ status }: { status: "idle" | "running" | "ok" | "error" | "modified" }) {
  const color = status === "ok" ? "bg-green-500" : status === "running" ? "bg-amber-500 animate-pulse" : status === "error" ? "bg-red-500" : status === "modified" ? "bg-yellow-500" : "bg-neutral-300";
  const label = status === "ok" ? "up-to-date" : status === "running" ? "running" : status === "error" ? "error" : status === "modified" ? "modified" : "idle";
  return (
    <div className="flex items-center gap-2 text-sm text-neutral-600">
      <span className={`inline-block w-3 h-3 rounded-full ${color}`} />
      {label}
    </div>
  );
}

function ProjectionBox({ box, orientation, rowMode }: { box: Box; orientation: Orientation; rowMode: boolean }) {
  const allVars = useMemo(() => {
    const names = new Set<string>();
    for (const r of box.rows) for (const k of Object.keys(r.vars)) names.add(k);
    return Array.from(names).sort();
  }, [box]);

  // In rowMode (Victor-like), show variables down rows and iterations across columns, but only for variables that changed at that line
  const changedOnly = useMemo(() => computeChangedVars(box.rows), [box]);
  const rowsForRender = rowMode ? Array.from(allVars).filter((v) => changedOnly.size === 0 || changedOnly.has(v)) : Array.from(allVars);

  return (
    <div className="rounded-2xl shadow-sm bg-white ring-1 ring-neutral-200 overflow-hidden">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-50 flex items-center justify-between">
        <span>Line {box.line}</span>
        <span className="text-neutral-400">{rowMode ? "Row View" : "Full View"}</span>
      </div>

      {/* Orientation: columns (variables across columns) */}
      {orientation === "columns" && !rowMode && (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="bg-neutral-50">
              <th className="px-2 py-1 text-right w-10">#</th>
              {rowsForRender.map((v) => (
                <th key={v} className="px-2 py-1 text-left truncate">{v}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {box.rows.map((r, i) => (
              <tr key={i} className="odd:bg-white even:bg-neutral-50/60">
                <td className="px-2 py-1 text-right text-neutral-500">{i + 1}</td>
                {rowsForRender.map((v) => (
                  <td key={v} className="px-2 py-1 font-mono whitespace-pre truncate align-top">{r.vars[v] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Orientation: rows (variables down rows) or Victor-style */}
      {(orientation === "rows" || rowMode) && (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="bg-neutral-50">
              <th className="px-2 py-1 text-left w-14">Var</th>
              {box.rows.map((_, i) => (
                <th key={i} className="px-2 py-1 text-right w-10">{i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsForRender.map((v) => (
              <tr key={v} className="odd:bg-white even:bg-neutral-50/60">
                <td className="px-2 py-1 text-left text-neutral-600">{v}</td>
                {box.rows.map((r, i) => (
                  <td key={i} className="px-2 py-1 font-mono whitespace-pre truncate align-top">{r.vars[v] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
