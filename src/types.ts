export type TraceRow = { line: number; vars: Record<string, string> };
export type Box = { line: number; rows: TraceRow[] };

export type ViewMode = "full" | "summary" | "row" | "scoped" | "dataflow";

export type Orientation = "columns" | "rows"; // columns: variables across columns; rows: variables down rows (Victor-style)

// Data-flow analysis types
export type DataFlowRecord = {
  line: number;
  execution: number;
  variable: string;
  dependency: string;
};

export type DataFlowResult = {
  line: number;
  records: DataFlowRecord[];
};

export type Status = "idle" | "running" | "ok" | "error" | "modified";
