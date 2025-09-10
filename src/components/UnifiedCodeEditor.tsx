import { useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { ProjectionBox } from "./ProjectionBox";
import type { Box, ViewMode, Orientation, DataFlowRecord, Status } from "../types";

interface UnifiedCodeEditorProps {
  code: string;
  onCodeChange: (code: string) => void;
  boxes: Box[];
  view: ViewMode;
  orientation: Orientation;
  dataFlowResults?: DataFlowRecord[];
  stdout: string;
  error: string | null;
  status: Status;
}

export function UnifiedCodeEditor({
  code,
  onCodeChange,
  boxes,
  view,
  orientation,
  dataFlowResults,
  stdout,
  error,
  status
}: UnifiedCodeEditorProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [focusedLine, setFocusedLine] = useState<number | null>(null);

  const lines = code.split("\n");

  // Handle tab key for indentation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const newValue = code.substring(0, start) + '    ' + code.substring(end);
      onCodeChange(newValue);
      // Set cursor position after the tab
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 4;
      }, 0);
    }
  }, [code, onCodeChange]);

  // Handle mouse movement to detect which line is being hovered
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    const rect = target.getBoundingClientRect();
    const y = e.clientY - rect.top;
    
    // Get computed line height from the textarea
    const computedStyle = window.getComputedStyle(target);
    const lineHeight = parseFloat(computedStyle.lineHeight) || 20;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 16;
    
    // Calculate line number accounting for padding
    const lineNumber = Math.floor((y - paddingTop) / lineHeight) + 1;
    
    if (lineNumber >= 1 && lineNumber <= lines.length) {
      setHoverLine(lineNumber);
    } else {
      setHoverLine(null);
    }
  }, [lines.length]);

  const handleMouseLeave = useCallback(() => {
    setHoverLine(null);
  }, []);

  // Handle focus to show projection box for current line
  const handleFocus = useCallback(() => {
    if (editorRef.current) {
      const pos = editorRef.current.selectionStart || 0;
      const pre = code.slice(0, pos);
      const lineNumber = pre.split("\n").length;
      setFocusedLine(lineNumber);
    }
  }, [code]);

  const handleBlur = useCallback(() => {
    setFocusedLine(null);
  }, []);

  // Get the projection box for the current hover/focus line
  const getProjectionBox = (lineNumber: number) => {
    return boxes.find((box) => box.line === lineNumber);
  };

  return (
    <div className="relative">
      {/* Code Editor with Line Numbers */}
      <div className="flex h-[520px] bg-white rounded-t-2xl overflow-hidden">
        {/* Line Numbers Gutter */}
        <div className="flex-shrink-0 bg-neutral-50 border-r border-neutral-200 px-3 py-4 text-xs text-neutral-400 font-mono select-none overflow-hidden">
          {lines.map((_, index) => {
            const lineNumber = index + 1;
            const isActive = (hoverLine === lineNumber) || (focusedLine === lineNumber);
            return (
              <div 
                key={index} 
                className={`h-5 leading-5 text-right ${
                  isActive ? 'bg-blue-100 text-blue-600 font-semibold' : ''
                }`}
              >
                {lineNumber}
              </div>
            );
          })}
        </div>
        
        {/* Code Editor */}
        <textarea
          ref={editorRef}
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="flex-1 h-full resize-none font-mono text-sm p-4 outline-none border-0 bg-white"
          spellCheck={false}
          style={{ lineHeight: '20px' }}
        />
      </div>
      
      {/* Line Highlight Overlay */}
      {(hoverLine || focusedLine) && (
        <div
          className="absolute pointer-events-none bg-blue-50/50 border-l-2 border-blue-400"
          style={{
            left: '48px', // Account for line number gutter width
            right: '0px',
            top: `${16 + (Math.max(hoverLine || focusedLine || 1, 1) - 1) * 20}px`,
            height: '20px'
          }}
        />
      )}
      
      {/* Projection Box Overlay */}
      {(hoverLine || focusedLine) && (
        <motion.div
          className="absolute z-10 pointer-events-none"
          style={{
            top: '16px',
            right: '16px',
            width: '600px',
            maxWidth: 'calc(100% - 32px)'
          }}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
        >
          <div className="scale-95 opacity-95">
            {(() => {
              const activeLine = hoverLine || focusedLine;
              const box = getProjectionBox(activeLine!);
              
              // Only show execution data if status is "ok" (code is up-to-date)
              if (box && status === "ok") {
                return (
                  <ProjectionBox
                    box={box}
                    orientation={orientation}
                    rowMode={view === "row"}
                    viewMode={view}
                    dataFlowResults={view === "dataflow" ? dataFlowResults : undefined}
                  />
                );
              } else {
                return (
                  <div className="rounded-2xl shadow-sm bg-white ring-1 ring-neutral-200 overflow-hidden">
                    <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-50 flex items-center justify-between">
                      <span>Line {activeLine}</span>
                      <span className="text-neutral-400">No Data</span>
                    </div>
                    <div className="p-4 text-xs text-neutral-500">
                      <div className="mb-2">No execution data available</div>
                      {status !== "ok" && (
                        <div className="text-[10px] text-neutral-400">Run the code to see variable values</div>
                      )}
                    </div>
                  </div>
                );
              }
            })()}
          </div>
        </motion.div>
      )}

      {/* Status Bar */}
      <div className="border-t bg-neutral-50 px-4 py-2 text-xs text-neutral-600 flex items-center justify-between">
        <div>Stdout: <span className="font-mono">{stdout ? stdout : "(empty)"}</span></div>
        {error && <div className="text-red-600">{String(error)}</div>}
      </div>
    </div>
  );
}
