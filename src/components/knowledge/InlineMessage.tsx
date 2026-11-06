import type { ReactNode } from "react";

import { alert } from "./tokens";

interface InlineMessageProps {
  tone?: "info" | "error";
  /** 追加定位类（如 mt-4 mb-0） */
  className?: string;
  children: ReactNode;
}

/** 操作回执 / 提示条：异步结果自动播报给读屏器 */
export function InlineMessage({ tone = "info", className, children }: InlineMessageProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={className ? `${alert(tone)} ${className}` : alert(tone)}
    >
      {children}
    </div>
  );
}
