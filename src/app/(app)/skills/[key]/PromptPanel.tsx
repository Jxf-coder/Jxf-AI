"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
  meta,
} from "@/components/knowledge/tokens";
import type { SkillRunView, SkillView } from "@/lib/skills";

import { runSkillAction } from "../actions";

interface PromptPanelProps {
  skill: SkillView;
  runs: SkillRunView[];
}

const EMPTY = {
  companyName: "",
  notes: "",
  purpose: "",
  materials: "",
  roles: "",
  question: "",
  input: "",
};

export function PromptPanel({ skill, runs }: PromptPanelProps) {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [output, setOutput] = useState<string>(() => {
    const latest = runs.find((run) => run.status === "done" && typeof run.output.text === "string");
    return latest ? String(latest.output.text) : "";
  });
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const isResearch = skill.key === "customer-research";
  const isIma = skill.key === "ima-knowledge";

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const payload: Record<string, string> = isResearch
        ? { companyName: form.companyName, notes: form.notes }
        : isIma
          ? {
              purpose: form.purpose,
              materials: form.materials,
              roles: form.roles,
              question: form.question,
            }
          : { input: form.input };
      const result = await runSkillAction(skill.key, payload);
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok && result.output) {
        setOutput(result.output);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}

      <SectionCard title={skill.name} desc={skill.summary} right={<span className={badge("blue")}>{skill.key}</span>}>
        {skill.hint ? <p className={`mb-4 ${meta}`}>{skill.hint}</p> : null}
        {isResearch ? (
          <div className={formGrid}>
            <Field label="公司全称（先要）">
              <input
                className={input}
                value={form.companyName}
                onChange={(event) => setForm({ ...form, companyName: event.target.value })}
                placeholder="例如：ABC Hardware GmbH"
              />
            </Field>
            <Field label="补充要求（可选）">
              <input
                className={input}
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                placeholder="目标市场、关注品类、需要重点核对的字段"
              />
            </Field>
          </div>
        ) : isIma ? (
          <div className="grid gap-3.5">
            <Field label="建库用途">
              <input
                className={input}
                value={form.purpose}
                onChange={(event) => setForm({ ...form, purpose: event.target.value })}
                placeholder="例如：销售团队查产品与客户跟进记录"
              />
            </Field>
            <Field label="资料类型">
              <input
                className={input}
                value={form.materials}
                onChange={(event) => setForm({ ...form, materials: event.target.value })}
                placeholder="文档 / 图片 / 音频 / 网页；视频与设计源文件不入库"
              />
            </Field>
            <Field label="权限角色">
              <input
                className={input}
                value={form.roles}
                onChange={(event) => setForm({ ...form, roles: event.target.value })}
                placeholder="个人 / 共享库管理员 / 可编辑 / 仅查看"
              />
            </Field>
            <Field label="主要提问">
              <input
                className={input}
                value={form.question}
                onChange={(event) => setForm({ ...form, question: event.target.value })}
                placeholder="例如：这个客户的交付边界是什么？"
              />
            </Field>
          </div>
        ) : (
          <Field label="输入">
            <textarea
              className={`${input} min-h-[120px]`}
              value={form.input}
              onChange={(event) => setForm({ ...form, input: event.target.value })}
              placeholder="填写这个技能需要的输入"
            />
          </Field>
        )}
        <div className={actions}>
          <button type="button" className={btnBlue} disabled={busy} onClick={submit}>
            {busy ? "生成中…" : "开始执行"}
          </button>
          <button type="button" className={btnGhost} disabled={busy} onClick={() => setForm(EMPTY)}>
            清空
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="执行结果"
        desc="结果保存在 skill_runs，可按时间回看；没有来源的内容会保留「未核实」标注。"
      >
        {output ? (
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-apple-canvas p-4 text-[13px] leading-relaxed text-zinc-700">
            {output}
          </pre>
        ) : (
          <div className={emptyState}>还没有结果。填写输入后点「开始执行」。</div>
        )}
      </SectionCard>

      <SectionCard title="历史记录" count={`${runs.length} 条`}>
        {runs.length === 0 ? (
          <div className={emptyState}>还没有执行记录。</div>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.id} className="rounded-xl bg-apple-canvas px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={badge(run.status === "done" ? "ok" : run.status === "failed" ? "error" : "warn")}>
                      {run.status === "done" ? "完成" : run.status === "failed" ? "失败" : "执行中"}
                    </span>
                    <span className={meta}>{new Date(run.createdAt).toLocaleString("zh-CN")}</span>
                  </div>
                  <button
                    type="button"
                    className="text-[12px] text-apple-blue hover:underline"
                    disabled={typeof run.output.text !== "string"}
                    onClick={() => setOutput(String(run.output.text ?? ""))}
                  >
                    查看结果
                  </button>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[12px] text-zinc-500">
                  {String(run.output.summary ?? run.error ?? "—")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
