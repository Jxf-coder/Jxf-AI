import type { ReactNode } from "react";

import { fieldLabel } from "./tokens";

interface FieldProps {
  label: string;
  className?: string;
  children: ReactNode;
}

/** 表单字段：统一 label 排版，控件由调用方传入（input / select / textarea） */
export function Field({ label, className, children }: FieldProps) {
  return (
    <label className={className ?? "block"}>
      <span className={fieldLabel}>{label}</span>
      {children}
    </label>
  );
}
