"use client";

import type { ReactNode } from "react";

import { ChevronIcon } from "./icons";

export interface CollapsibleSectionProps {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * 全局唯一折叠分组（标题行 + 统一箭头 + 内容区）。
 *
 * 约束：折叠箭头只能来自 ui/icons 的 ChevronIcon，禁止使用 ⌄ / ▸ / 原生 details 三角。
 */
export function CollapsibleSection({
  open,
  onToggle,
  title,
  description,
  meta,
  children,
  className,
}: CollapsibleSectionProps) {
  return (
    <section className={["ui-collapse", className ?? ""].filter(Boolean).join(" ")}>
      <button type="button" className="ui-collapse-head" aria-expanded={open} onClick={onToggle}>
        <ChevronIcon className={`ui-chevron${open ? " is-open" : ""}`} />
        <span className="ui-collapse-title">{title}</span>
        {description ? <span className="ui-collapse-desc">{description}</span> : null}
        {meta ? <span className="ui-collapse-meta">{meta}</span> : null}
      </button>
      {open && children ? <div className="ui-collapse-body">{children}</div> : null}
    </section>
  );
}
