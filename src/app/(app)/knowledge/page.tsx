import { headers } from "next/headers";

import { EmptyState } from "@/components/knowledge/EmptyState";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  badge,
  badgeRow,
  evidenceItem,
  evidenceList,
  headerRow,
  meta,
  pageSubtitle,
  pageTitle,
  pageWrap,
  quote,
  inline as inlineCls,
} from "@/components/knowledge/tokens";
import { aiStatus } from "@/lib/ai/openai";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { listRegressionRuns, type RegressionRunView } from "@/lib/knowledge/regression";
import { loadKnowledgeStats } from "@/lib/knowledge/stats";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { DistillButton } from "./DistillButton";
import { QaPanel } from "./QaPanel";
import { RegressionPanel } from "./RegressionPanel";
import { RevokeButton } from "./RevokeButton";
import { UploadPanel } from "./UploadPanel";
import { StatBar } from "./_components/StatBar";
import { CardsTab } from "./_components/CardsTab";
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

interface QaRow {
  id: string;
  question: string;
  cited_card_ids: string[];
  invalid_cites: string[];
  unverified_numbers: string[];
  created_at: Date;
}

interface GapRow {
  id: string;
  question: string;
  created_at: Date;
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

const RUN_KIND_LABEL: Record<string, string> = {
  upload: "上传",
  scout: "巡读",
  manual: "手工",
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
        qaLogs: [] as QaRow[],
        gaps: [] as GapRow[],
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

    const qaLogs =
      tab === "qa"
        ? (
            await client.query<QaRow>(
              `select id, question, cited_card_ids, invalid_cites, unverified_numbers, created_at
                 from qa_logs
                order by created_at desc
                limit 10`,
            )
          ).rows
        : [];

    const gaps =
      tab === "gaps"
        ? (
            await client.query<GapRow>(
              `select id, question, created_at
                 from knowledge_gaps
                where status = 'open'
                order by created_at desc
                limit 50`,
            )
          ).rows
        : [];

    return { canRead, canWrite, documents, runs, qaLogs, gaps };
  });

  const stats = data.canRead ? await loadKnowledgeStats(context) : null;
  const regressionRuns: RegressionRunView[] =
    data.canRead && tab === "regression" ? await listRegressionRuns(context) : [];

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
              <UploadPanel canWrite={data.canWrite} aiEnabled={ai.embeddingEnabled} />

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

              <SectionCard title="入库批次" count={`最近 ${data.runs.length} 次`}>
                {data.runs.length === 0 ? (
                  <EmptyState>暂无入库批次。</EmptyState>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="kb-table">
                      <thead>
                        <tr>
                          <th>来源</th>
                          <th>部门</th>
                          <th>状态</th>
                          <th>文件 / 入库 / 跳过</th>
                          <th>切片 / 向量</th>
                          <th>目标</th>
                          <th>创建</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.runs.map((run) => (
                          <tr key={run.id}>
                            <td data-label="来源" className="kb-strong">
                              {RUN_KIND_LABEL[run.kind] ?? run.kind}
                            </td>
                            <td data-label="部门">{run.department_name}</td>
                            <td data-label="状态">
                              <span className={statusBadgeClass(run.status)}>
                                {STATUS_LABEL[run.status] ?? run.status}
                              </span>
                            </td>
                            <td data-label="文件数" className="kb-num">
                              {run.counts.files ?? 0} / {run.counts.documents ?? 0} / {run.counts.skipped ?? 0}
                            </td>
                            <td data-label="切片数" className="kb-num">
                              {run.counts.chunks ?? 0} / {run.counts.embedded ?? 0}
                            </td>
                            <td data-label="目标">{run.goal ?? "—"}</td>
                            <td data-label="创建">
                              {run.creator_name ?? "—"} · {formatDate(run.created_at)}
                            </td>
                            <td data-label="操作">
                              {data.canWrite && run.status !== "revoked" ? (
                                <RevokeButton runId={run.id} />
                              ) : (
                                "—"
                              )}
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

          {tab === "qa" ? (
            <>
              <QaPanel aiEnabled={ai.chatEnabled} />

              <SectionCard title="最近问答" count={data.qaLogs.length}>
                {data.qaLogs.length === 0 ? (
                  <EmptyState>还没有提问记录。</EmptyState>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="kb-table">
                      <thead>
                        <tr>
                          <th>问题</th>
                          <th>引用</th>
                          <th>校验</th>
                          <th>时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.qaLogs.map((log) => (
                          <tr key={log.id}>
                            <td data-label="问题" className="kb-strong">
                              {log.question}
                            </td>
                            <td data-label="引用" className="kb-num">
                              {log.cited_card_ids.length} 张卡
                            </td>
                            <td data-label="校验">
                              {log.invalid_cites.length === 0 && log.unverified_numbers.length === 0 ? (
                                <span className={badge("ok")}>通过</span>
                              ) : (
                                <span className={badge("error")}>
                                  {log.invalid_cites.length > 0 ? `越界引用 ${log.invalid_cites.join(",")}` : ""}
                                  {log.invalid_cites.length > 0 && log.unverified_numbers.length > 0 ? " · " : ""}
                                  {log.unverified_numbers.length > 0
                                    ? `未核实数字 ${log.unverified_numbers.join("、")}`
                                    : ""}
                                </span>
                              )}
                            </td>
                            <td data-label="时间" className="kb-num">
                              {formatDate(log.created_at)}
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

          {tab === "gaps" ? (
            <SectionCard
              title="知识缺口"
              right={<span className={badge("warn")}>{data.gaps.length}</span>}
              desc="问答未命中时自动沉淀，补文档或补卡片后可关闭。"
            >
              {data.gaps.length === 0 ? (
                <EmptyState>还没有缺口。</EmptyState>
              ) : (
                <ul className={evidenceList}>
                  {data.gaps.map((gap) => (
                    <li key={gap.id} className={evidenceItem}>
                      <span className={quote}>{gap.question}</span>
                      <span className={meta}>{formatDate(gap.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          ) : null}

          {tab === "regression" ? (
            <>
              {data.canWrite ? <RegressionPanel /> : null}

              <SectionCard title="回归记录" count={`最近 ${regressionRuns.length} 次`}>
                {regressionRuns.length === 0 ? (
                  <EmptyState>还没有回归记录。</EmptyState>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="kb-table">
                      <thead>
                        <tr>
                          <th>构建标记</th>
                          <th>通过</th>
                          <th>保留率</th>
                          <th>门禁</th>
                          <th>时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {regressionRuns.map((run) => {
                          const gate = run.passed === run.total && run.retained >= 0.9;
                          return (
                            <tr key={run.id}>
                              <td data-label="构建标记" className="kb-strong">
                                {run.buildTag}
                              </td>
                              <td data-label="通过" className="kb-num">
                                {run.passed} / {run.total}
                              </td>
                              <td data-label="保留率" className="kb-num">
                                {(run.retained * 100).toFixed(2)}%
                              </td>
                              <td data-label="门禁">
                                <span className={gate ? badge("ok") : badge("error")}>
                                  {gate ? "通过" : "未通过"}
                                </span>
                              </td>
                              <td data-label="时间" className="kb-num">
                                {formatDate(run.createdAt)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            </>
          ) : null}

          {tab === "cards" ? <CardsTab context={context} searchParams={params} /> : null}

          {tab === "meta" ? (
            <SectionCard title="条目四字段" desc="来源 / 版本 / 负责人 / 有效期的批量补全。">
              <EmptyState>该视图尚未接入，可先在「知识卡」页查看卡片。</EmptyState>
            </SectionCard>
          ) : null}
        </>
      )}
    </section>
  );
}
