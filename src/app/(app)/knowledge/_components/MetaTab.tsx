import Link from "next/link";

import { EmptyState } from "@/components/knowledge/EmptyState";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { tabActive, tabIdle } from "@/components/knowledge/tokens";
import type { UserContext } from "@/lib/db/user-context";
import { listCards } from "@/lib/knowledge/cards";

import { MetaRow, type MetaRowCard } from "./MetaRow";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface MetaTabProps {
  context: UserContext;
  canWrite: boolean;
  missingOnly: boolean;
}

/** 条目四字段：来源 / 版本 / 负责人 / 有效期（全部落在 extra jsonb） */
export async function MetaTab({ context, canWrite, missingOnly }: MetaTabProps) {
  const cards = await listCards(context, { status: "all", limit: 200 });

  const rows: MetaRowCard[] = cards.map((card) => ({
    id: card.id,
    title: card.title,
    status: card.status,
    departmentName: card.departmentName,
    source: text(card.extra.source),
    version: text(card.extra.version),
    owner: text(card.extra.owner),
    validUntil: card.validUntil ?? "",
  }));

  const missing = rows.filter(
    (row) => !row.source || !row.version || !row.owner || !row.validUntil,
  );
  const shown = missingOnly ? missing : rows;

  return (
    <SectionCard
      title="条目四字段"
      count={`${rows.length - missing.length}/${rows.length} 已填齐`}
      desc="来源 / 版本 / 负责人 / 有效期 写入卡片 extra 字段，不新增数据库列；没填齐的卡在对外和过期治理前要先补。"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href="/knowledge?tab=meta"
          className={missingOnly ? tabIdle : tabActive}
          aria-current={missingOnly ? undefined : "page"}
        >
          全部 {rows.length}
        </Link>
        <Link
          href="/knowledge?tab=meta&missing=1"
          className={missingOnly ? tabActive : tabIdle}
          aria-current={missingOnly ? "page" : undefined}
        >
          只看没填齐的 {missing.length}
        </Link>
      </div>

      {shown.length === 0 ? (
        <div className="mt-3">
          <EmptyState>{rows.length === 0 ? "还没有知识卡。" : "四字段都填齐了。"}</EmptyState>
        </div>
      ) : (
        <ul className="mt-2 list-none divide-y divide-black/[0.04] p-0">
          {shown.map((row) => (
            <MetaRow key={row.id} card={row} canWrite={canWrite} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
