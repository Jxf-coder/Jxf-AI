"use client";

import type { ReactNode } from "react";

import { CloseIcon } from "./icons";

export interface NoticeBarProps {
  kind?: "info" | "error";
  children: ReactNode;
  onClose: () => void;
}

/**
 * 全局唯一提示条（info / error + 关闭按钮）。
 * 关闭图标统一使用 ui/icons 的 CloseIcon，禁止再写 × 字符。
 */
export function NoticeBar({ kind = "info", children, onClose }: NoticeBarProps) {
  return (
    <div className={`notice-bar ${kind === "error" ? "alert-error" : "alert-info"}`}>
      <span className="notice-text">{children}</span>
      <button type="button" className="notice-close" aria-label="关闭提示" onClick={onClose}>
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
