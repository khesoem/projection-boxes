import { useEffect, useState } from "react";

export function useCaretLine(textareaRef: React.RefObject<HTMLTextAreaElement | null>): number | null {
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
