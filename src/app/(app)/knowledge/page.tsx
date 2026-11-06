import { headers } from "next/headers";

import { InlineMessage } from "@/components/knowledge/InlineMessage";
import {
  badge,
  badgeRow,
  headerRow,
  pageSubtitle,
  pageTitle,
  pageWrap,
} from "@/components/knowledge/tokens";
import { aiStatus } from "@/lib/ai/openai";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { loadKnowledgeStats } from "@/lib/knowledge/stats";
import {
  isUuid,
  loadCardDetail,
  loadDocumentContent,
  loadKnowledgeGraph,
  loadWorkspaceTree,
} from "@/lib/knowledge/workspace";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { CardsTab } from "./_components/CardsTab";
import { GapsTab } from "./_components/GapsTab";
import { GraphView } from "./_components/GraphView";
import { MetaTab } from "./_components/MetaTab";
import { QaTab } from "./_components/QaTab";
import { RegressionTab } from "./_components/RegressionTab";
import { ScoutTab } from "./_components/ScoutTab";
import { StatBar } from "./_components/StatBar";
import { DEFAULT_TAB, TabNav, isKnowledgeTab, type KnowledgeTab } from "./_components/TabNav";
import { WorkspaceEditor } from "./_components/WorkspaceEditor";
import { WorkspaceTree } from "./_components/WorkspaceTree";

export const dynamic = "force-dynamic";

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
    doc?: string;
    card?: string;
  }>;
}) {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);
  const ai = aiStatus();

  const params = await searchParams;
  const tab: KnowledgeTab = isKnowledgeTab(params.tab) ? params.tab : DEFAULT_TAB;

  const access = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }
    return {
      canRead: actor ? authorize(actor, "knowledge:read").allowed : false,
      canWrite: actor ? authorize(actor, "knowledge:write").allowed : false,
    };
  });

  const [stats, tree] = await Promise.all([
    access.canRead ? loadKnowledgeStats(context) : Promise.resolve(null),
    access.canRead ? loadWorkspaceTree(context) : Promise.resolve(null),
  ]);

  const runs =
    access.canRead && tab === "scout"
      ? (
          await withUserContext(context, (client) =>
            client.query<RunRow>(
              `select r.id, r.kind, r.status, r.goal, r.counts, r.created_at,
                      dep.name as department_name, u.name as creator_name
                 from ingest_runs r
                 join departments dep on dep.id = r.department_id
                 left join users u on u.id = r.created_by
                order by r.created_at desc
                limit 30`,
            ),
          )
        ).rows
      : [];

  const wantsDocument = tab === "scout" && Boolean(params.doc);
  const wantsCard = tab === "scout" && Boolean(params.card);

  const document =
    tab === "scout" && isUuid(params.doc) ? await loadDocumentContent(context, params.doc) : null;
  const card = tab === "scout" && isUuid(params.card) ? await loadCardDetail(context, params.card) : null;
  const graph =
    tab === "scout" && !wantsDocument && !wantsCard ? await loadKnowledgeGraph(context) : null;

  const regressionFailed =
    stats?.lastRegression && stats.lastRegression.passed < stats.lastRegression.total
      ? stats.lastRegression.total - stats.lastRegression.passed
      : 0;

  return (
    <section className={`${pageWrap} kb-workspace`}>
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

      {!access.canRead || !stats || !tree ? (
        <InlineMessage tone="error">当前账号没有「知识库查看」权限，请联系 L1 管理员授权。</InlineMessage>
      ) : (
        <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(200px,17%)_minmax(0,1fr)] lg:items-start">
          <WorkspaceTree
            tree={tree}
            selected={
              document
                ? { kind: "doc", id: document.id }
                : card
                  ? { kind: "card", id: card.id }
                  : null
            }
          />

          <div className="min-w-0">
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
                <details className="mb-4 rounded-2xl border border-hairline bg-white px-4 py-3 shadow-card">
                  <summary className="cursor-pointer text-[13px] font-medium text-zinc-800">
                    上传文档与入库批次
                  </summary>
                  <div className="mt-3">
                    <ScoutTab
                      canWrite={access.canWrite}
                      runs={runs.map((run) => ({
                        id: run.id,
                        status: run.status,
                        goal: run.goal,
                        counts: run.counts,
                        createdAt: run.created_at.toISOString(),
                        creatorName: run.creator_name,
                      }))}
                    />
                  </div>
                </details>

                {document ? (
                  <WorkspaceEditor
                    key={document.id}
                    mode="document"
                    document={document}
                    canWrite={access.canWrite}
                    aiEnabled={ai.chatEnabled}
                  />
                ) : card ? (
                  <WorkspaceEditor key={card.id} mode="card" card={card} canWrite={access.canWrite} />
                ) : wantsDocument || wantsCard ? (
                  <InlineMessage tone="error">找不到该条目，或当前部门无权查看。</InlineMessage>
                ) : graph ? (
                  <GraphView data={graph} />
                ) : null}
              </>
            ) : null}

            {tab === "qa" ? <QaTab context={context} aiEnabled={ai.chatEnabled} /> : null}

            {tab === "gaps" ? (
              <GapsTab context={context} canWrite={access.canWrite} statusParam={params.gapStatus} />
            ) : null}

            {tab === "regression" ? (
              <RegressionTab context={context} canWrite={access.canWrite} />
            ) : null}

            {tab === "cards" ? <CardsTab context={context} searchParams={params} /> : null}

            {tab === "meta" ? (
              <MetaTab context={context} canWrite={access.canWrite} missingOnly={params.missing === "1"} />
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
