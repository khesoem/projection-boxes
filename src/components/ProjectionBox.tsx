import { useEffect, useMemo, useCallback } from "react";
import type { Box, Orientation, ViewMode, DataFlowRecord } from "../types";
import { VARIABLE_SHAPES } from "../constants";
import { computeChangedVars } from "../utils/python";

interface ProjectionBoxProps {
  box: Box;
  orientation: Orientation;
  rowMode: boolean;
  viewMode: ViewMode;
  dataFlowResults?: DataFlowRecord[];
}

export function ProjectionBox({ box, orientation, rowMode, viewMode, dataFlowResults }: ProjectionBoxProps) {
  const allVars = useMemo(() => {
    const names = new Set<string>();
    for (const r of box.rows) for (const k of Object.keys(r.vars)) names.add(k);
    return Array.from(names).sort();
  }, [box]);

  // Get dependencies for a specific variable at a specific execution
  const getDependencies = useCallback((varName: string, execution: number): Set<string> => {
    if (!dataFlowResults) return new Set();
    const s = new Set<string>();
    for (const r of dataFlowResults) {
      if (r.line === box.line && r.execution === execution && r.variable === varName) {
        s.add(r.dependency);
      }
    }
    return s;
  }, [dataFlowResults, box.line]);

  // Debug logging for data-flow view (only when needed)
  useEffect(() => {
    if (viewMode === "dataflow" && dataFlowResults && dataFlowResults.length > 0) {
      console.log(`ProjectionBox for line ${box.line}:`);
      console.log(`  - Data-flow results for this line:`, dataFlowResults.filter(r => r.line === box.line));
      console.log(`  - Variables in this box:`, allVars);
      console.log(`  - Number of rows:`, box.rows.length);
      
      // Test dependencies for first few variables
      for (let i = 0; i < Math.min(3, allVars.length); i++) {
        const varName = allVars[i];
        for (let j = 0; j < Math.min(3, box.rows.length); j++) {
          const deps = getDependencies(varName, j + 1);
          if (deps.size > 0) {
            console.log(`  - ${varName} at execution ${j + 1} depends on:`, Array.from(deps));
          }
        }
      }
    }
  }, [viewMode, dataFlowResults, box.line, allVars, box.rows.length, getDependencies]);

  // Collect all dependency variables for THIS line (across executions/vars)
  const depVarsForThisLine = useMemo(() => {
    const s = new Set<string>();
    if (dataFlowResults) {
      for (const r of dataFlowResults) {
        if (r.line === box.line) s.add(r.dependency);
      }
    }
    return s;
  }, [dataFlowResults, box.line]);

  // Shape domain = variables in the box ∪ dependency variables for the line
  const shapeDomain = useMemo(() => {
    const union = new Set<string>([...allVars, ...depVarsForThisLine]);
    return Array.from(union).sort();
  }, [allVars, depVarsForThisLine]);

  // Use the domain above to resolve a stable shape per variable
  const getVariableShape = (varName: string): string => {
    const idx = shapeDomain.indexOf(varName);
    // Guard against -1 (should be rare after the union)
    return VARIABLE_SHAPES[(idx >= 0 ? idx : 0) % VARIABLE_SHAPES.length];
  };

  // In rowMode (Victor-like), show variables down rows and iterations across columns, but only for variables that changed at that line
  const changedOnly = useMemo(() => computeChangedVars(box.rows), [box]);
  const rowsForRender = rowMode ? Array.from(allVars).filter((v) => changedOnly.size === 0 || changedOnly.has(v)) : Array.from(allVars);

  // Render dependency indicators for data-flow view
  const renderDependencies = (dependencies: Set<string>) => {
    if (dependencies.size === 0) return null;
    
    return (
      <span className="ml-1 text-[10px] text-blue-600 font-bold">
        {Array.from(dependencies).map(dep => getVariableShape(dep)).join('')}
      </span>
    );
  };

  return (
    <div className="rounded-2xl shadow-sm bg-white ring-1 ring-neutral-200 overflow-hidden">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-50 flex items-center justify-between">
        <span>Line {box.line}</span>
        <span className="text-neutral-400">
          {rowMode ? "Row View" : viewMode === "dataflow" ? "Data-flow View" : "Full View"}
        </span>
      </div>

      {/* Orientation: columns (variables across columns) */}
      {orientation === "columns" && !rowMode && (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="bg-neutral-50">
              <th className="px-2 py-1 text-right w-10">#</th>
              {rowsForRender.map((v) => (
                <th key={v} className="px-2 py-1 text-left truncate">
                  {viewMode === "dataflow" && (
                    <span className="mr-1 text-[10px]">{getVariableShape(v)}</span>
                  )}
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {box.rows.map((r, i) => (
              <tr key={i} className="odd:bg-white even:bg-neutral-50/60">
                <td className="px-2 py-1 text-right text-neutral-500">{i + 1}</td>
                {rowsForRender.map((v) => (
                  <td key={v} className="px-2 py-1 font-mono whitespace-pre truncate align-top">
                    {r.vars[v] ?? ""}
                    {viewMode === "dataflow" && dataFlowResults && (
                      renderDependencies(getDependencies(v, i + 1))
                    )}
                  </td>
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
                <td className="px-2 py-1 text-left text-neutral-600">
                  {viewMode === "dataflow" && (
                    <span className="mr-1 text-[10px]">{getVariableShape(v)}</span>
                  )}
                  {v}
                </td>
                {box.rows.map((r, i) => (
                  <td key={i} className="px-2 py-1 font-mono whitespace-pre truncate align-top">
                    {r.vars[v] ?? ""}
                    {viewMode === "dataflow" && dataFlowResults && (
                      renderDependencies(getDependencies(v, i + 1))
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
