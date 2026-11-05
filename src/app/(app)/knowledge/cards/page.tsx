import Link from "next/link";
import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { listCards, type CardStatus, type CardView } from "@/lib/knowledge/cards";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { CardActions } from "./CardActions";
import { NewCardForm } from "./NewCardForm";

export const dynamic = "force-dynamic";

const STATUS_TABS: Array<{ key: CardStatus; label: string }> = [
  { key: "pending", label: "待确认" },
  { key: "confirmed", label: "已确认" },
  { key: "dropped", label: "已作废" },
];

const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  object: "对象",
  decision: "决策",
  preference: "偏好",
  faq: "问答",
  case: "案例",
  viewpoint: "观点",
};

const ORIGIN_LABEL: Record<string, string> = {
  intake: "巡读",
  distill: "AI 蒸馏",
  manual: "人工",
  scout: "采集",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formatDate(value: Date | string | null): string {
  if (!value) {
    return "—";
  }
  return DATE_FORMATTER.format(typeof value === "string" ? new Date(value) : value);
}

export default async function KnowledgeCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);
  const params = await searchParams;
  const status = STATUS_TABS.some((tab) => tab.key === params.status)
    ? (params.status as CardStatus)
    : "pending";

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
      canConfirm: actor ? authorize(actor, "knowledge:confirm").allowed : false,
    };
  });

  const cards: CardView[] = access.canRead ? await listCards(context, status) : [];

  return (
    <section className="page">
      <header className="section-header">
        <div>
          <h1 className="section-title">知识卡</h1>
          <p className="section-subtitle">
            只有确认过的卡片会进入问答召回；证据引文必须能在原文逐字复现。
          </p>
        </div>
        <Link className="button-secondary" href="/knowledge">
          返回知识库
        </Link>
      </header>

      <nav className="perm-tabs" role="tablist" aria-label="知识卡状态">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/knowledge/cards?status=${tab.key}`}
            role="tab"
            aria-selected={tab.key === status}
            className={`perm-tab${tab.key === status ? " is-active" : ""}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {!access.canRead ? (
        <div className="alert-error">当前账号没有「知识库查看」权限，请联系 L1 管理员授权。</div>
      ) : (
        <>
          {status === "pending" && access.canWrite ? <NewCardForm /> : null}

          {cards.length === 0 ? (
            <div className="card">
              <p className="hint">
                暂无{STATUS_TABS.find((tab) => tab.key === status)?.label}的知识卡。
                {status === "pending" ? "可在知识库页面用「生成卡片」从文档蒸馏，或人工新建。" : ""}
              </p>
            </div>
          ) : (
            cards.map((card) => (
              <article className="card" key={card.id}>
                <div className="badge-row">
                  <span className="badge badge-accent">{KIND_LABEL[card.kind] ?? card.kind}</span>
                  <span className="badge">{ORIGIN_LABEL[card.origin] ?? card.origin}</span>
                  <span className="badge">{card.departmentName}</span>
                  {card.humanEdited ? <span className="badge badge-ok">人工编辑</span> : null}
                  {card.conflictWith.length > 0 ? <span className="badge badge-error">存在冲突</span> : null}
                  {card.validUntil ? <span className="badge">有效期至 {card.validUntil}</span> : null}
                </div>

                <div className="card-title">{card.title}</div>
                <p>{card.body}</p>

                <div className="card-divider" />
                <div className="meta-label">证据（{card.evidence.length}）</div>
                {card.evidence.length === 0 ? (
                  <p className="hint">
                    {card.status === "pending"
                      ? "暂无证据。需要人工修订或补充证据后才能确认。"
                      : "暂无关联证据。"}
                  </p>
                ) : (
                  <ul className="evidence-list">
                    {card.evidence.map((evidence) => (
                      <li key={evidence.id}>
                        <span className="evidence-quote">“{evidence.quote}”</span>
                        <span className="hint">
                          {evidence.documentTitle ?? "文档"} · {evidence.locator ?? "未标注位置"} ·{" "}
                          {evidence.verified ? "已核对" : "未核对"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {card.confirmedAt ? (
                  <p className="hint">确认时间：{formatDate(card.confirmedAt)}</p>
                ) : null}

                <CardActions
                  cardId={card.id}
                  title={card.title}
                  body={card.body}
                  canConfirm={access.canConfirm}
                  canWrite={access.canWrite}
                  status={card.status}
                />
              </article>
            ))
          )}
        </>
      )}
    </section>
  );
}
