import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Crosshair, Play, Grid, GitBranch } from "lucide-react";

// Import extracted components and utilities
import { Button, Card, CardContent, Toggle } from "./components/ui";
import { StatusDot } from "./components/StatusDot";
import { ProjectionBox } from "./components/ProjectionBox";
import { useCaretLine } from "./hooks/useCaretLine";
import { ensurePyodide, buildPythonDriverSource, extractUsedNamesFromPythonLine } from "./utils/python";
import { runDataFlowAnalysis } from "./utils/dataFlow";
import type { Box, ViewMode, Orientation, DataFlowRecord, Status } from "./types";
import { SAMPLE } from "./constants";

// Main component
export default function ProjectionBoxesDemo() {
  const [code, setCode] = useState(SAMPLE);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [stdout, setStdout] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("full");
  const [orientation, setOrientation] = useState<Orientation>("columns");
  const [filter, setFilter] = useState<string>("");
  const [appliedFilter, setAppliedFilter] = useState<string>("");
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [lastExecutedCode, setLastExecutedCode] = useState<string>(SAMPLE);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const activeLine = useCaretLine(editorRef);

  // State for data-flow analysis
  const [dataFlowResults, setDataFlowResults] = useState<DataFlowRecord[]>([]);
  const [dataFlowLoading, setDataFlowLoading] = useState(false);

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
      if (e.key === "2") setView("scoped");
      if (e.key === "3") setView("dataflow");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filteredBoxes = useMemo(() => {
    let bs = boxes;
    // Summary view: show current line and last executed line only
    if (view === "summary") {
      const last = boxes[boxes.length - 1]?.line;
      const lines = new Set<number>();
      if (activeLine) lines.add(activeLine);
      if (last != null) lines.add(last);
      bs = boxes.filter((b) => lines.has(b.line));
    }
    // Scoped view: for each line, only show variables that are referenced on that specific source line
    if (view === "scoped") {
      const codeLines = code.split("\n");
      bs = bs.map((b) => {
        const lineText = codeLines[b.line - 1] ?? "";
        const used = extractUsedNamesFromPythonLine(lineText);
        return {
          line: b.line,
          rows: b.rows.map((r) => ({
            line: r.line,
            vars: Object.fromEntries(Object.entries(r.vars).filter(([k]) => used.has(k)))
          }))
        };
      });
    }
    // Data-flow view: show all variables with dependency analysis from dyn_flow.py
    if (view === "dataflow") {
      // This will be populated when data-flow analysis is complete
      // For now, return the same as full view
      bs = boxes;
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
  }, [boxes, view, activeLine, appliedFilter, code]);

  // Run data-flow analysis when dataflow view is selected and we have execution data
  useEffect(() => {
    if (view === "dataflow" && status === "ok") {
      // Only run analysis if we don't already have results for this code
      if (dataFlowResults.length === 0 || lastExecutedCode !== code) {
        setDataFlowLoading(true);
        runDataFlowAnalysis(code)
          .then(results => {
            setDataFlowResults(results);
          })
          .catch(error => {
            console.error("Data-flow analysis failed:", error);
            setDataFlowResults([]);
          })
          .finally(() => {
            setDataFlowLoading(false);
          });
      }
    }
  }, [view, status, code, dataFlowResults.length, lastExecutedCode]);

  // Clear data-flow results when switching away from dataflow view
  useEffect(() => {
    if (view !== "dataflow") {
      setDataFlowResults([]);
      setDataFlowLoading(false);
    }
  }, [view]);

  // Log when data-flow results change (for debugging)
  useEffect(() => {
    if (dataFlowResults.length > 0) {
      console.log("Data-flow results updated:", dataFlowResults.length, "records");
      console.log("Data-flow line numbers:", [...new Set(dataFlowResults.map(r => r.line))].sort((a, b) => a - b));
      console.log("Execution line numbers:", [...new Set(dataFlowResults.map(r => r.execution))].sort((a, b) => a - b));
      console.log("Variables in data-flow:", [...new Set(dataFlowResults.map(r => r.variable))]);
    }
  }, [dataFlowResults]);

  async function execute(codeToRun: string) {
    const pyodide = await ensurePyodide();
    const driver = buildPythonDriverSource(codeToRun);
    console.log("Generated driver code:", driver);
    
    try {
      // Start line tracing
      await pyodide.runPythonAsync("import sys\nsys.settrace(None)");
      await pyodide.runPythonAsync(driver);
      const out = await pyodide.runPythonAsync(`__buf.getvalue()`);
      const err = await pyodide.runPythonAsync(`__err`);
      const jsRows = await pyodide.runPythonAsync(`trace_data`);
      const traceDataJson = await pyodide.runPythonAsync(`trace_data_json`);
      
      console.log("Execution results:", { out, err, jsRows, jsRowsLength: Array.isArray(jsRows) ? jsRows.length : 0 });
      console.log("Trace data JSON:", traceDataJson);
      
      // Parse the JSON string to get proper JavaScript objects
      const convertedRows = JSON.parse(String(traceDataJson));
      
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
        const grouped = new Map<number, Array<{ line: number; vars: Record<string, string> }>>();
        console.log("Raw rows data:", rows);
        for (const r of rows as Array<{ line: number; vars: Record<string, string> }>) {
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
        console.log("Sample code lines:", code.split('\n').map((line, i) => `${i+1}: ${line}`));
        console.log("Raw trace data:", rows);
        setBoxes(bs);
        setStatus("ok");
        setLastExecutedCode(code);
      }
    } catch (e: unknown) {
      console.error("Run error:", e);
      setError(String(e instanceof Error ? e.message : e));
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
          <h1 className="text-2xl font-semibold">Enhanced Projection Boxes</h1>
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
            <Toggle pressed={view === "scoped"} onPressedChange={() => setView("scoped")} className="gap-2"><Crosshair className="w-4 h-4"/> Scoped</Toggle>
            <Toggle pressed={view === "dataflow"} onPressedChange={() => setView("dataflow")} className="gap-2">
              <GitBranch className="w-4 h-4"/> 
              Data-flow
              {dataFlowLoading && <span className="ml-1 text-xs text-blue-600">(analyzing...)</span>}
            </Toggle>
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
                                viewMode={view}
                                dataFlowResults={view === "dataflow" ? dataFlowResults : undefined}
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

      <div className="text-xs text-neutral-500">
        Tip: Hover over code lines to see variable values. Press 1=Full view, 2=Scoped mode, 3=Data-flow mode. Run code to see execution data.
        {view === "dataflow" && dataFlowResults && dataFlowResults.length > 0 && (
          <div className="mt-2 p-2 bg-blue-50 rounded border border-blue-200">
            <div className="font-medium text-blue-800 mb-1">Data-flow Legend:</div>
            <div className="text-blue-700">
              Geometric shapes show variable dependencies. For example, ● under variable 's' means 's' depends on variable 'a'.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
