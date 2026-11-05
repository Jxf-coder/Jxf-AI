import { evidenceItem, evidenceList, meta, quote } from "./tokens";

export interface EvidenceItemView {
  id: string;
  quote: string;
  locator?: string | null;
  documentTitle?: string | null;
  verified: boolean;
}

/** 证据列表：引文 + 文档 / 定位 / 核对状态 */
export function EvidenceList({ items }: { items: EvidenceItemView[] }) {
  return (
    <ul className={evidenceList}>
      {items.map((item) => (
        <li key={item.id} className={evidenceItem}>
          <span className={quote}>“{item.quote}”</span>
          <span className={meta}>
            {item.documentTitle ?? "文档"} · {item.locator ?? "未标注位置"} ·{" "}
            {item.verified ? "已核对" : "未核对"}
          </span>
        </li>
      ))}
    </ul>
  );
}
