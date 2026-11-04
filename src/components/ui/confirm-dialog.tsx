"use client";

import { useEffect, type ReactNode } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** 需要额外输入（如驳回原因）时传入表单内容 */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 全局唯一确认弹窗：替换 window.confirm / window.alert / window.prompt。
 *
 * 原生阻塞弹窗在 Electron / IDE 内置浏览器中由宿主主窗口托管，
 * 一旦对话框状态异常会导致整个宿主主线程假死，因此统一使用页内 Modal。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  pending = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        onCancel();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div className="confirm-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        className="confirm-backdrop"
        aria-label={cancelLabel}
        onClick={() => {
          if (!pending) {
            onCancel();
          }
        }}
      />
      <div className="confirm-card">
        <h3 className="confirm-title">{title}</h3>
        {description ? <p className="confirm-desc">{description}</p> : null}
        {children}
        <div className="confirm-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button${danger ? " button-danger" : ""}`}
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
          >
            {pending ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
