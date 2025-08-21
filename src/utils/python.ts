import type { TraceRow } from "../types";
import { PYTHON_KEYWORDS } from "../constants";

// Pyodide type definitions
interface PyodideInstance {
  runPythonAsync: (code: string) => Promise<unknown>;
}

interface GlobalWithPyodide extends Window {
  __pyodidePromise?: Promise<PyodideInstance>;
  loadPyodide?: (config: { indexURL: string }) => Promise<PyodideInstance>;
}

// --- Pyodide Loader ---
export async function ensurePyodide(): Promise<PyodideInstance> {
  const globalAny = globalThis as unknown as GlobalWithPyodide;
  if (globalAny.__pyodidePromise) return globalAny.__pyodidePromise;
  
  globalAny.__pyodidePromise = new Promise<PyodideInstance>((resolve, reject) => {
    const loadPyodide = async () => {
      try {
        if (!globalAny.loadPyodide) {
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js";
          script.onload = async () => {
            try {
              const pyodide = await (globalThis as unknown as GlobalWithPyodide).loadPyodide!({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/" });
              resolve(pyodide);
            } catch (e) {
              reject(e);
            }
          };
          script.onerror = reject;
          document.head.appendChild(script);
        } else {
          const pyodide = await globalAny.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/" });
          resolve(pyodide);
        }
      } catch (e) {
        reject(e);
      }
    };
    
    loadPyodide();
  });
  
  return globalAny.__pyodidePromise;
}

// Compute a simple diff of changed variables per line occurrence
export function computeChangedVars(rows: TraceRow[]): Set<string> {
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

// Extract Python identifiers used on a single line (best-effort heuristic)
export function extractUsedNamesFromPythonLine(line: string): Set<string> {
  const names = new Set<string>();
  const regex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    const name = m[0];
    if (!PYTHON_KEYWORDS.has(name)) names.add(name);
  }
  return names;
}

// --- Safer source injection: avoid manual escaping by embedding JSON literal ---
export function buildPythonDriverSource(userCode: string): string {
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
                # Use the frame line number directly (this should match the data-flow analysis)
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
