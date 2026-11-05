import { headers } from "next/headers";
import Link from "next/link";

import { aiStatus } from "@/lib/ai/openai";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import { listRegressionRuns, type RegressionRunView } from "@/lib/knowledge/regression";
import type { ResolvedPermissions } from "@/types/permission";

import { DistillButton } from "./DistillButton";
import { QaPanel } from "./QaPanel";
import { RegressionPanel } from "./RegressionPanel";
import { RevokeButton } from "./RevokeButton";
import { UploadPanel } from "./UploadPanel";

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

function statusClass(status: string): string {
  if (status === "done" || status === "parsed") {
    return "badge badge-ok";
  }
  if (status === "failed") {
    return "badge badge-error";
  }
  if (status === "revoked" || status === "needs_ocr" || status === "running") {
    return "badge badge-accent";
  }
  return "badge";
}

export default async function KnowledgePage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);
  const ai = aiStatus();

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

    const documents = await client.query<DocumentRow>(
      `select d.id, d.title, d.mime, d.status, d.page_count, d.char_count, d.created_at,
              dep.name as department_name,
              (select count(*) from doc_chunks c where c.document_id = d.id)::text as chunk_count
         from documents d
         join departments dep on dep.id = d.department_id
        order by d.created_at desc
        limit 100`,
    );

    const runs = await client.query<RunRow>(
      `select r.id, r.kind, r.status, r.goal, r.counts, r.created_at,
              dep.name as department_name, u.name as creator_name
         from ingest_runs r
         join departments dep on dep.id = r.department_id
         left join users u on u.id = r.created_by
        order by r.created_at desc
        limit 30`,
    );

    const qaLogs = await client.query<QaRow>(
      `select id, question, cited_card_ids, invalid_cites, unverified_numbers, created_at
         from qa_logs
        order by created_at desc
        limit 10`,
    );

    const gaps = await client.query<GapRow>(
      `select id, question, created_at
         from knowledge_gaps
        where status = 'open'
        order by created_at desc
        limit 10`,
    );

    return {
      canRead,
      canWrite,
      documents: documents.rows,
      runs: runs.rows,
      qaLogs: qaLogs.rows,
      gaps: gaps.rows,
    };
  });

  const regressionRuns: RegressionRunView[] = data.canRead ? await listRegressionRuns(context) : [];

  return (
    <section className="page">
      <header className="section-header">
        <div>
          <h1 className="section-title">知识库</h1>
          <p className="section-subtitle">
            上传文档 → 解析分块 → 知识卡确认 → 单轮问答。当前入库文档范围为本部门及下级部门。
          </p>
        </div>
      </header>

      <nav className="perm-tabs" role="tablist" aria-label="知识库视图">
        <Link href="/knowledge" className="perm-tab is-active" aria-current="page">
          文档与批次
        </Link>
        <Link href="/knowledge/cards" className="perm-tab">
          知识卡
        </Link>
      </nav>

      <div className="badge-row">
        <span className={ai.embeddingEnabled ? "badge badge-ok" : "badge badge-accent"}>
          向量检索：{ai.embeddingEnabled ? `${ai.embeddingModel} 已启用` : "未配置（仅关键词）"}
        </span>
        <span className={ai.chatEnabled ? "badge badge-ok" : "badge badge-accent"}>
          问答生成：{ai.chatEnabled ? ai.chatModel : "未启用"}
        </span>
      </div>

      {!data.canRead ? (
        <div className="alert-error">当前账号没有「知识库查看」权限，请联系 L1 管理员授权。</div>
      ) : (
        <>
          <QaPanel aiEnabled={ai.chatEnabled} />

          <UploadPanel canWrite={data.canWrite} aiEnabled={ai.embeddingEnabled} />

          <div className="card">
            <div className="card-title">文档（{data.documents.length}）</div>
            {data.documents.length === 0 ? (
              <p className="hint">还没有文档。上传后会自动解析、分块并写入检索索引。</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>部门</th>
                    <th>状态</th>
                    <th>页数</th>
                    <th>字符</th>
                    <th>切片</th>
                    <th>入库时间</th>
                    <th>原件</th>
                    <th>知识卡</th>
                  </tr>
                </thead>
                <tbody>
                  {data.documents.map((document) => (
                    <tr key={document.id}>
                      <td data-label="标题">{document.title}</td>
                      <td data-label="部门">{document.department_name}</td>
                      <td data-label="状态">
                        <span className={statusClass(document.status)}>
                          {STATUS_LABEL[document.status] ?? document.status}
                        </span>
                      </td>
                      <td data-label="页数">{document.page_count ?? "—"}</td>
                      <td data-label="字符">{document.char_count}</td>
                      <td data-label="切片">{document.chunk_count}</td>
                      <td data-label="入库时间">{formatDate(document.created_at)}</td>
                      <td data-label="原件">
                        <a className="link-action" href={`/api/knowledge/documents/${document.id}`}>
                          下载
                        </a>
                      </td>
                      <td data-label="知识卡">
                        {data.canWrite && document.status === "parsed" ? (
                          <DistillButton documentId={document.id} disabled={!ai.chatEnabled} />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div className="card-title">入库批次（最近 30 次）</div>
            {data.runs.length === 0 ? (
              <p className="hint">暂无入库批次。</p>
            ) : (
              <table className="table">
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
                      <td data-label="来源">{RUN_KIND_LABEL[run.kind] ?? run.kind}</td>
                      <td data-label="部门">{run.department_name}</td>
                      <td data-label="状态">
                        <span className={statusClass(run.status)}>
                          {STATUS_LABEL[run.status] ?? run.status}
                        </span>
                      </td>
                      <td data-label="文件">
                        {run.counts.files ?? 0} / {run.counts.documents ?? 0} / {run.counts.skipped ?? 0}
                      </td>
                      <td data-label="切片">
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
            )}
          </div>

          <div className="card">
            <div className="card-title">最近问答（{data.qaLogs.length}）</div>
            {data.qaLogs.length === 0 ? (
              <p className="hint">还没有提问记录。</p>
            ) : (
              <table className="table">
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
                      <td data-label="问题">{log.question}</td>
                      <td data-label="引用">{log.cited_card_ids.length} 张卡</td>
                      <td data-label="校验">
                        {log.invalid_cites.length === 0 && log.unverified_numbers.length === 0 ? (
                          <span className="badge badge-ok">通过</span>
                        ) : (
                          <span className="badge badge-error">
                            {log.invalid_cites.length > 0 ? `越界引用 ${log.invalid_cites.join(",")}` : ""}
                            {log.invalid_cites.length > 0 && log.unverified_numbers.length > 0 ? " · " : ""}
                            {log.unverified_numbers.length > 0
                              ? `未核实数字 ${log.unverified_numbers.join("、")}`
                              : ""}
                          </span>
                        )}
                      </td>
                      <td data-label="时间">{formatDate(log.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {data.gaps.length > 0 ? (
            <div className="card">
              <div className="card-title">知识缺口（{data.gaps.length}）</div>
              <p className="hint">问答未命中时自动沉淀，补文档或补卡片后可关闭。</p>
              <ul className="evidence-list">
                {data.gaps.map((gap) => (
                  <li key={gap.id}>
                    <span className="evidence-quote">{gap.question}</span>
                    <span className="hint">{formatDate(gap.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.canWrite ? <RegressionPanel /> : null}

          {regressionRuns.length > 0 ? (
            <div className="card">
              <div className="card-title">回归记录（最近 {regressionRuns.length} 次）</div>
              <table className="table">
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
                        <td data-label="构建标记">{run.buildTag}</td>
                        <td data-label="通过">
                          {run.passed} / {run.total}
                        </td>
                        <td data-label="保留率">{(run.retained * 100).toFixed(2)}%</td>
                        <td data-label="门禁">
                          <span className={gate ? "badge badge-ok" : "badge badge-error"}>
                            {gate ? "通过" : "未通过"}
                          </span>
                        </td>
                        <td data-label="时间">{formatDate(run.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
