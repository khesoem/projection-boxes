import React from "react";

// --- Lightweight UI helpers (Tailwind) ---
export const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = "", children, ...rest }) => (
  <button className={`px-3 py-2 rounded-2xl bg-neutral-900 text-white hover:bg-neutral-800 transition ${className}`} {...rest}>{children}</button>
);

export const Card: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = "", children }) => (
  <div className={`bg-white rounded-2xl border border-neutral-200 ${className}`}>{children}</div>
);

export const CardContent: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = "", children }) => (
  <div className={`p-4 ${className}`}>{children}</div>
);

export const Toggle: React.FC<{ pressed?: boolean; onPressedChange?: (v: boolean) => void; className?: string; children: React.ReactNode }> = ({ pressed, onPressedChange, className = "", children }) => (
  <button
    onClick={() => onPressedChange && onPressedChange(!pressed)}
    className={`px-3 py-2 rounded-2xl border transition ${pressed ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-800 border-neutral-300 hover:bg-neutral-50'} ${className}`}
  >{children}</button>
);
