import type { Status } from "../types";

interface StatusDotProps {
  status: Status;
}

export function StatusDot({ status }: StatusDotProps) {
  const color = status === "ok" ? "bg-green-500" : status === "running" ? "bg-amber-500 animate-pulse" : status === "error" ? "bg-red-500" : status === "modified" ? "bg-yellow-500" : "bg-neutral-300";
  const label = status === "ok" ? "up-to-date" : status === "running" ? "running" : status === "error" ? "error" : status === "modified" ? "modified" : "idle";
  
  return (
    <div className="flex items-center gap-2 text-sm text-neutral-600">
      <span className={`inline-block w-3 h-3 rounded-full ${color}`} />
      {label}
    </div>
  );
}
