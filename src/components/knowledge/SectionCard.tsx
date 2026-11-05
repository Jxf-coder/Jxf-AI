import type { ReactNode } from "react";

import { badge, card, cardDesc, cardHead, cardTitle } from "./tokens";

interface SectionCardProps {
  title: string;
  /** 标题右侧的计数徽章；传了 right 时忽略 */
  count?: number | string;
  right?: ReactNode;
  desc?: string;
  className?: string;
  children: ReactNode;
}

/** 知识库通用卡片：标题行 + 可选说明 + 内容 */
export function SectionCard({ title, count, right, desc, className, children }: SectionCardProps) {
  return (
    <section className={className ?? card}>
      <div className={cardHead}>
        <h2 className={cardTitle}>{title}</h2>
        {right ?? (count === undefined ? null : <span className={badge()}>{count}</span>)}
      </div>
      {desc ? <p className={cardDesc}>{desc}</p> : null}
      {children}
    </section>
  );
}
