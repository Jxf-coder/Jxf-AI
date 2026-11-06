import { headers } from "next/headers";

import { EmptyState } from "@/components/knowledge/EmptyState";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  badge,
  badgeRow,
  headerRow,
  pageSubtitle,
  pageTitle,
  pageWrap,
  inline as inlineCls,
} from "@/components/knowledge/tokens";
import { aiStatus } from "@/lib/ai/openai";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { loadKnowledgeStats } from "@/lib/knowledge/stats";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { DistillButton } from "./DistillButton";
import { CardsTab } from "./_components/CardsTab";
import { GapsTab } from "./_components/GapsTab";
import { MetaTab } from "./_components/MetaTab";
import { QaTab } from "./_components/QaTab";
import { RegressionTab } from "./_components/RegressionTab";
import { ScoutTab } from "./_components/ScoutTab";
import { StatBar } from "./_components/StatBar";
import { DEFAULT_TAB, TabNav, isKnowledgeTab, type KnowledgeTab } from "./_components/TabNav";

export const dynamic = "force-dynamic";

interface DocumentRow {
  id: string;
  title: string;
  mime: string;
  status: "parsed" | "needs_ocr" | "failed" | "revoked";
  page_count: number | null;
  char_count: number;
  created_at: Date;
  department_name: string;
  chunk_count: string;
}

interface RunRow {
  id: string;
  kind: string;
  status: "draft" | "running" | "done" | "failed" | "revoked";
  goal: string | null;
  counts: Record<string, number>;
  created_at: Date;
  department_name: string;
  creator_name: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  parsed: "已解析",
  needs_ocr: "待 OCR",
  failed: "解析失败",
  revoked: "已撤回",
  draft: "草稿",
  running: "进行中",
  done: "已完成",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: Date | string): string {
  return DATE_FORMATTER.format(typeof value === "string" ? new Date(value) : value);
}

function statusBadgeClass(status: string): string {
  if (status === "done" || status === "parsed") {
    return badge("ok");
  }
  if (status === "failed") {
    return badge("error");
  }
  if (status === "revoked" || status === "needs_ocr" || status === "running") {
    return badge("warn");
  }
  return badge("muted");
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    status?: string;
    kind?: string;
    category?: string;
    product?: string;
    q?: string;
    problems?: string;
    gapStatus?: string;
    missing?: string;
  }>;
}) {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);
  const ai = aiStatus();

  const params = await searchParams;
  const tab: KnowledgeTab = isKnowledgeTab(params.tab) ? params.tab : DEFAULT_TAB;

  const data = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }

    const canRead = actor ? authorize(actor, "knowledge:read").allowed : false;
    const canWrite = actor ? authorize(actor, "knowledge:write").allowed : false;

    if (!canRead) {
      return {
        canRead,
        canWrite,
        documents: [] as DocumentRow[],
        runs: [] as RunRow[],
      };
    }

    const documents =
      tab === "scout"
        ? (
            await client.query<DocumentRow>(
              `select d.id, d.title, d.mime, d.status, d.page_count, d.char_count, d.created_at,
                      dep.name as department_name,
                      (select count(*) from doc_chunks c where c.document_id = d.id)::text as chunk_count
                 from documents d
                 join departments dep on dep.id = d.department_id
                order by d.created_at desc
                limit 100`,
            )
          ).rows
        : [];

    const runs =
      tab === "scout"
        ? (
            await client.query<RunRow>(
              `select r.id, r.kind, r.status, r.goal, r.counts, r.created_at,
                      dep.name as department_name, u.name as creator_name
                 from ingest_runs r
                 join departments dep on dep.id = r.department_id
                 left join users u on u.id = r.created_by
                order by r.created_at desc
                limit 30`,
            )
          ).rows
        : [];

    return { canRead, canWrite, documents, runs };
  });

  const stats = data.canRead ? await loadKnowledgeStats(context) : null;

  const regressionFailed =
    stats?.lastRegression && stats.lastRegression.passed < stats.lastRegression.total
      ? stats.lastRegression.total - stats.lastRegression.passed
      : 0;

  return (
    <section className={pageWrap}>
      <header className={headerRow}>
        <div>
          <h1 className={pageTitle}>知识库</h1>
          <p className={pageSubtitle}>
            上传文档 → 解析分块 → 知识卡确认 → 单轮问答。入库范围为本部门及下级部门。
          </p>
        </div>
      </header>

      <div className={`${badgeRow} mt-4`}>
        <span className={ai.embeddingEnabled ? badge("ok") : badge("warn")}>
          向量检索 · {ai.embeddingEnabled ? `${ai.embeddingModel} 已启用` : "未配置（仅关键词）"}
        </span>
        <span className={ai.chatEnabled ? badge("ok") : badge("warn")}>
          问答生成 · {ai.chatEnabled ? ai.chatModel : "未启用"}
        </span>
      </div>

      {!data.canRead || !stats ? (
        <InlineMessage tone="error">当前账号没有「知识库查看」权限，请联系 L1 管理员授权。</InlineMessage>
      ) : (
        <>
          <StatBar stats={stats} />

          <TabNav
            active={tab}
            counts={{
              cards: stats.pendingCards,
              gaps: stats.gapsOpen,
              qa: stats.qaFlagged,
              regression: regressionFailed,
            }}
          />

          {tab === "scout" ? (
            <>
              <ScoutTab
                canWrite={data.canWrite}
                runs={data.runs.map((run) => ({
                  id: run.id,
                  status: run.status,
                  goal: run.goal,
                  counts: run.counts,
                  createdAt: run.created_at.toISOString(),
                  creatorName: run.creator_name,
                }))}
              />

              <SectionCard title="文档" count={data.documents.length}>
                {data.documents.length === 0 ? (
                  <EmptyState>还没有文档。上传后会自动解析、分块并写入检索索引。</EmptyState>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="kb-table">
                      <thead>
                        <tr>
                          <th>标题</th>
                          <th>部门</th>
                          <th>状态</th>
                          <th>页数</th>
                          <th>字符</th>
                          <th>切片</th>
                          <th>入库时间</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.documents.map((document) => (
                          <tr key={document.id}>
                            <td data-label="标题" className="kb-strong">
                              {document.title}
                            </td>
                            <td data-label="部门">{document.department_name}</td>
                            <td data-label="状态">
                              <span className={statusBadgeClass(document.status)}>
                                {STATUS_LABEL[document.status] ?? document.status}
                              </span>
                            </td>
                            <td data-label="页数" className="kb-num">
                              {document.page_count ?? "—"}
                            </td>
                            <td data-label="字符" className="kb-num">
                              {document.char_count}
                            </td>
                            <td data-label="切片" className="kb-num">
                              {document.chunk_count}
                            </td>
                            <td data-label="入库时间" className="kb-num">
                              {formatDate(document.created_at)}
                            </td>
                            <td data-label="操作">
                              <span className={inlineCls}>
                                <a
                                  className="text-[13px] text-apple-blue hover:underline"
                                  href={`/api/knowledge/documents/${document.id}`}
                                >
                                  下载
                                </a>
                                {data.canWrite && document.status === "parsed" ? (
                                  <DistillButton documentId={document.id} disabled={!ai.chatEnabled} />
                                ) : null}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            </>
          ) : null}

          {tab === "qa" ? <QaTab context={context} aiEnabled={ai.chatEnabled} /> : null}

          {tab === "gaps" ? (
            <GapsTab context={context} canWrite={data.canWrite} statusParam={params.gapStatus} />
          ) : null}

          {tab === "regression" ? (
            <RegressionTab context={context} canWrite={data.canWrite} />
          ) : null}

          {tab === "cards" ? <CardsTab context={context} searchParams={params} /> : null}

          {tab === "meta" ? (
            <MetaTab context={context} canWrite={data.canWrite} missingOnly={params.missing === "1"} />
          ) : null}
        </>
      )}
    </section>
  );
}
