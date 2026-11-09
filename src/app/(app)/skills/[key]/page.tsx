import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import { getSkill, listSkillRuns } from "@/lib/skills";
import { getLearningSource, listLearningSources } from "@/lib/skills/learning-sources";
import { getMetaConnection, listMetaDrafts } from "@/lib/skills/meta-ads";
import { listDistribute } from "@/lib/skills/distribute";
import {
  badge,
  emptyState,
  meta,
  pageSubtitle,
  pageTitle,
  pageWrap,
} from "@/components/knowledge/tokens";

import { DistributePanel } from "./DistributePanel";
import { MetaPanel } from "./MetaPanel";
import { PromptPanel } from "./PromptPanel";

export const dynamic = "force-dynamic";

const CATEGORY_LABEL: Record<string, string> = {
  creation: "创作",
  production: "共用制作能力",
  expert: "专家",
  video: "视频 / 播客",
  knowledge: "知识库",
  music: "音乐",
  tool: "工具",
  learning: "学习提炼",
  teaching: "教学管理",
  finance: "财务",
  admin: "行政",
};

export default async function SkillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ source?: string; q?: string }>;
}) {
  const { key } = await params;
  const query = await searchParams;
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  if (!context.accessLevel) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前账号没有有效任用。</div>
      </section>
    );
  }

  const skill = await getSkill(context, key);
  if (!skill) {
    notFound();
  }

  const permissions = await withUserContext(context, (client) =>
    resolveContextPermissions(client, context),
  );
  const resource = {
    kind: "department" as const,
    id: context.activeDepartmentId ?? undefined,
    departmentId: context.activeDepartmentId,
  };
  const canUse = authorize(permissions, "skill:use", resource).allowed;
  const canEdit = authorize(permissions, "skill:edit", resource).allowed;

  if (!canUse) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前等级没有「使用技能」权限。</div>
      </section>
    );
  }

  return (
    <section className={pageWrap}>
      <div className="mb-5">
        <Link href="/skills" className="text-[12px] text-apple-blue hover:underline">
          ← 返回技能台
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="text-3xl leading-none">{skill.icon}</span>
            <div>
              <h1 className={pageTitle}>{skill.name}</h1>
              <p className={pageSubtitle}>{skill.summary || "尚未填写卡片说明"}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={badge("muted")}>{CATEGORY_LABEL[skill.category] ?? skill.category}</span>
            <span className={badge(skill.origin === "builtin" ? "blue" : "ok")}>
              {skill.origin === "builtin" ? "内置技能" : "自建技能"}
            </span>
            <span className={meta}>v{skill.version}</span>
          </div>
        </div>
        {skill.hint ? <p className={`mt-3 ${meta}`}>{skill.hint}</p> : null}
      </div>

      {skill.key === "learning-knowledge" ? (
        <LearningSources
          sources={await listLearningSources()}
          selected={query.source ? await getLearningSource(query.source) : null}
          q={query.q ?? ""}
        />
      ) : skill.key === "meta-ads-operator" ? (
        <MetaPanel
          connection={await getMetaConnection(context)}
          drafts={await listMetaDrafts(context)}
        />
      ) : skill.key === "video-distribute" ? (
        <DistributePanel
          view={await listDistribute(context)}
          canManage={context.accessLevel === "L1"}
        />
      ) : (
        <PromptPanel skill={skill} runs={await listSkillRuns(context, skill.key, 20)} />
      )}
    </section>
  );
}

function LearningSources({
  sources,
  selected,
  q,
}: {
  sources: { code: string; title: string; skill: string }[];
  selected: { code: string; title: string; skill: string; content: string } | null;
  q: string;
}) {
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? sources.filter(
        (source) =>
          source.code.toLowerCase().includes(needle) ||
          source.title.toLowerCase().includes(needle) ||
          source.skill.toLowerCase().includes(needle),
      )
    : sources;

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <div className="rounded-2xl border border-hairline bg-white p-4 shadow-card">
        <form className="mb-3 flex gap-2" action={`/skills/learning-knowledge`}>
          <input
            name="q"
            defaultValue={q}
            className="w-full rounded-2xl border-0 bg-apple-canvas px-3.5 py-2.5 text-[13px] outline-none placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-apple-blue/20"
            placeholder="搜索编号 / 标题 / 技能"
          />
          <button type="submit" className="rounded-xl bg-zinc-900 px-3 py-2 text-[12px] text-white">
            搜索
          </button>
        </form>
        <p className="mb-2 text-[11px] text-zinc-500">共 {filtered.length} 份脱敏来源</p>
        <ul className="max-h-[36rem] space-y-1 overflow-auto">
          {filtered.map((source) => (
            <li key={source.code}>
              <Link
                href={`/skills/learning-knowledge?source=${source.code}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className={`block rounded-xl px-3 py-2 text-[12px] transition ${
                  selected?.code === source.code
                    ? "bg-apple-blue-soft text-apple-blue"
                    : "text-zinc-600 hover:bg-apple-canvas"
                }`}
              >
                <span className="font-mono text-[11px]">{source.code}</span>
                <span className="mt-0.5 block text-[12px]">{source.title}</span>
                {source.skill ? <span className="mt-0.5 block text-[11px] text-zinc-400">{source.skill}</span> : null}
              </Link>
            </li>
          ))}
          {filtered.length === 0 ? <li className={emptyState}>没有匹配的来源。</li> : null}
        </ul>
      </div>

      <div className="rounded-2xl border border-hairline bg-white p-5 shadow-card">
        {selected ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={badge("blue")}>{selected.code}</span>
              <h2 className="text-base font-semibold text-zinc-900">{selected.title}</h2>
              {selected.skill ? <span className={meta}>{selected.skill}</span> : null}
            </div>
            <pre className="max-h-[40rem] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-700">
              {selected.content}
            </pre>
          </>
        ) : (
          <div className={emptyState}>从左侧选一份来源，查看脱敏全文。</div>
        )}
      </div>
    </div>
  );
}
