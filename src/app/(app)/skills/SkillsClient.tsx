"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  emptyState,
  formGrid,
  input,
  linkBtn,
  meta,
  pageSubtitle,
  pageTitle,
  pageWrap,
  headerRow,
} from "@/components/knowledge/tokens";
import type { SkillRunView, SkillView } from "@/lib/skills";

import {
  createSkillAction,
  deleteSkillAction,
  setSkillStatusAction,
  updateSkillAction,
} from "./actions";

interface SkillsClientProps {
  skills: SkillView[];
  canEdit: boolean;
  recentRuns: SkillRunView[];
}

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

const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABEL);

interface Message {
  tone: "info" | "error";
  text: string;
}

export function SkillsClient({ skills, canEdit, recentRuns }: SkillsClientProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ name: "", summary: "", hint: "", promptBody: "" });
  const [draft, setDraft] = useState({
    key: "",
    name: "",
    icon: "🧩",
    category: "tool",
    summary: "",
    hint: "",
    promptBody: "",
  });

  const categories = useMemo(() => {
    const used = new Set(skills.map((skill) => skill.category));
    return CATEGORY_OPTIONS.filter(([value]) => used.has(value));
  }, [skills]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (category !== "all" && skill.category !== category) return false;
      if (!needle) return true;
      return (
        skill.name.toLowerCase().includes(needle) ||
        skill.key.includes(needle) ||
        skill.summary.toLowerCase().includes(needle)
      );
    });
  }, [skills, query, category]);

  async function submitCreate() {
    setBusy("create");
    setMessage(null);
    try {
      const result = await createSkillAction(draft);
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setDraft({ key: "", name: "", icon: "🧩", category: "tool", summary: "", hint: "", promptBody: "" });
        setCreating(false);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function submitEdit() {
    if (!editingKey) return;
    setBusy(`edit:${editingKey}`);
    setMessage(null);
    try {
      const result = await updateSkillAction(editingKey, {
        name: editDraft.name,
        summary: editDraft.summary,
        hint: editDraft.hint,
        promptBody: editDraft.promptBody.trim() ? editDraft.promptBody : undefined,
      });
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setEditingKey(null);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function retireSkill(key: string) {
    setBusy(`retire:${key}`);
    setMessage(null);
    try {
      const result = await setSkillStatusAction(key, "retired");
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function removeSkill(key: string) {
    setBusy(`delete:${key}`);
    setMessage(null);
    try {
      const result = await deleteSkillAction(key);
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className={headerRow}>
        <div>
          <h1 className={pageTitle}>Skill 技能台</h1>
          <p className={pageSubtitle}>
            常用与已配置 · 卡片直接打开对应能力；技能绑定在「AI 员工」编辑页维护。
          </p>
        </div>
        {canEdit ? (
          <button type="button" className={btnBlue} onClick={() => setCreating((value) => !value)}>
            {creating ? "收起" : "注册技能"}
          </button>
        ) : null}
      </div>

      <div className="mt-5 space-y-4">
        {message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}

        {creating && canEdit ? (
          <SectionCard title="注册新技能" desc="新增后即可绑定到部门与 AI 员工；模板型技能可填写提示词直接执行。">
            <div className={formGrid}>
              <Field label="标识符（小写字母 / 数字 / 连字符）">
                <input
                  className={input}
                  value={draft.key}
                  onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                  placeholder="doc-digest"
                />
              </Field>
              <Field label="名称">
                <input
                  className={input}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="文档提炼"
                />
              </Field>
              <Field label="图标">
                <input
                  className={input}
                  value={draft.icon}
                  onChange={(event) => setDraft({ ...draft, icon: event.target.value })}
                  placeholder="🧩"
                />
              </Field>
              <Field label="分类">
                <select
                  className={input}
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                >
                  {CATEGORY_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="mt-3 grid gap-3.5">
              <Field label="卡片说明">
                <input
                  className={input}
                  value={draft.summary}
                  onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                  placeholder="一句话说明这个技能能解决什么问题"
                />
              </Field>
              <Field label="使用提示">
                <input
                  className={input}
                  value={draft.hint}
                  onChange={(event) => setDraft({ ...draft, hint: event.target.value })}
                  placeholder="打开后先看什么、什么情况下不要用"
                />
              </Field>
              <Field label="提示词（可留空，留空则只做说明卡）">
                <textarea
                  className={`${input} min-h-[120px]`}
                  value={draft.promptBody}
                  onChange={(event) => setDraft({ ...draft, promptBody: event.target.value })}
                  placeholder="你是……请按以下结构输出……"
                />
              </Field>
            </div>
            <div className={actions}>
              <button
                type="button"
                className={btnBlue}
                disabled={busy === "create"}
                onClick={submitCreate}
              >
                {busy === "create" ? "注册中…" : "注册技能"}
              </button>
              <button type="button" className={btnGhost} onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </SectionCard>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${input} max-w-xs`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能名称 / 说明"
          />
          <button
            type="button"
            className={category === "all" ? btnBlue : btnGhost}
            onClick={() => setCategory("all")}
          >
            全部
          </button>
          {categories.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={category === value ? btnBlue : btnGhost}
              onClick={() => setCategory(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className={emptyState}>没有匹配的技能。</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((skill) => (
              <div
                key={skill.key}
                className="flex flex-col rounded-2xl border border-hairline bg-white p-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <span className="text-2xl leading-none">{skill.icon}</span>
                  <span className={badge("muted")}>{CATEGORY_LABEL[skill.category] ?? skill.category}</span>
                </div>
                <h3 className="text-base font-semibold tracking-tight text-zinc-900">{skill.name}</h3>
                <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-zinc-500">
                  {skill.summary || "尚未填写卡片说明"}
                </p>
                {skill.hint ? <p className={`mt-3 ${meta}`}>{skill.hint}</p> : null}

                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
                  <span className={meta}>{skill.origin === "builtin" ? "内置技能" : "自建技能"}</span>
                  <div className="flex items-center gap-1">
                    {canEdit && skill.origin === "tenant" ? (
                      <>
                        <button
                          type="button"
                          className={linkBtn}
                          onClick={() => {
                            setEditingKey(editingKey === skill.key ? null : skill.key);
                            setEditDraft({
                              name: skill.name,
                              summary: skill.summary,
                              hint: skill.hint,
                              promptBody: "",
                            });
                          }}
                        >
                          {editingKey === skill.key ? "收起" : "编辑"}
                        </button>
                        <button
                          type="button"
                          className={linkBtn}
                          disabled={busy === `retire:${skill.key}`}
                          onClick={() => retireSkill(skill.key)}
                        >
                          停用
                        </button>
                        <button
                          type="button"
                          className={linkBtn}
                          disabled={busy === `delete:${skill.key}`}
                          onClick={() => removeSkill(skill.key)}
                        >
                          删除
                        </button>
                      </>
                    ) : null}
                    <Link
                      href={`/skills/${skill.key}`}
                      className={`ml-1 ${badge("blue")} transition hover:bg-apple-blue hover:text-white`}
                    >
                      打开 →
                    </Link>
                  </div>
                </div>

                {editingKey === skill.key ? (
                  <div className="mt-3 grid gap-2 border-t border-hairline pt-3">
                    <input
                      className={input}
                      value={editDraft.name}
                      onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
                      placeholder="名称"
                    />
                    <input
                      className={input}
                      value={editDraft.summary}
                      onChange={(event) => setEditDraft({ ...editDraft, summary: event.target.value })}
                      placeholder="卡片说明"
                    />
                    <input
                      className={input}
                      value={editDraft.hint}
                      onChange={(event) => setEditDraft({ ...editDraft, hint: event.target.value })}
                      placeholder="使用提示"
                    />
                    <textarea
                      className={`${input} min-h-[90px]`}
                      value={editDraft.promptBody}
                      onChange={(event) => setEditDraft({ ...editDraft, promptBody: event.target.value })}
                      placeholder="留空则保留原提示词"
                    />
                    <div className={actions}>
                      <button
                        type="button"
                        className={btnBlue}
                        disabled={busy === `edit:${skill.key}`}
                        onClick={submitEdit}
                      >
                        保存修改
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <SectionCard title="最近执行" count={`${recentRuns.length} 条`}>
          {recentRuns.length === 0 ? (
            <div className={emptyState}>还没有执行记录。打开一个技能开始第一次运行。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>技能</th>
                    <th>状态</th>
                    <th>摘要</th>
                    <th>执行人</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.id}>
                      <td className="mono text-[12px]">{run.skillKey}</td>
                      <td>
                        <span className={badge(run.status === "done" ? "ok" : run.status === "failed" ? "error" : "warn")}>
                          {run.status === "done" ? "完成" : run.status === "failed" ? "失败" : "执行中"}
                        </span>
                      </td>
                      <td className="max-w-[28rem] truncate text-[12px] text-zinc-500">
                        {String(run.output.summary ?? run.error ?? "—")}
                      </td>
                      <td className="text-[12px] text-zinc-500">{run.createdByName ?? "—"}</td>
                      <td className="text-[12px] text-zinc-500">
                        {new Date(run.createdAt).toLocaleString("zh-CN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
