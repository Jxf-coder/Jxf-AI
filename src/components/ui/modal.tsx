"use client";

import { useEffect, type ReactNode } from "react";

/**
 * 表单类弹层：用于「新增客户」这类字段较多、不适合把内容区挤下去的编辑场景。
 * 危险确认仍走 ConfirmDialog，两者职责分开，避免把表单塞进确认框。
 */
export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  pending = false,
  wide = true,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  pending?: boolean;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-zinc-900/25 backdrop-blur-[2px]"
        onClick={() => {
          if (!pending) {
            onClose();
          }
        }}
      />
      <div
        className={`relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${
          wide ? "max-w-2xl" : "max-w-lg"
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/[0.05] px-5 py-4">
          <h3 className="text-[15px] font-semibold tracking-tight text-zinc-900">{title}</h3>
          {description ? <span className="text-[11px] text-zinc-500">{description}</span> : null}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-black/[0.05] px-5 py-3.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
