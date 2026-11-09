"use client";

import type { ReactNode } from "react";

import { linkBtn } from "@/components/knowledge/tokens";

export function Drawer({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-black/25"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative h-full w-full ${
          wide ? "max-w-3xl" : "max-w-xl"
        } overflow-y-auto bg-white p-5 shadow-2xl`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-zinc-900">{title}</h2>
          <button type="button" className={`${linkBtn} text-[12px]`} onClick={onClose}>
            关闭
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}
