"use client";

import Link from "next/link";
import { useState } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  formGrid,
  input,
  linkBtn,
  meta,
  type Tone,
} from "@/components/knowledge/tokens";
import type { PipelineRunStatus, PipelineRunView, PipelineView } from "@/lib/pipelines";

import {
  createPipelineAction,
  runPipelineAction,
  togglePipelineAction,
} from "./actions";

interface EmployeeOption {
  id: string;
  name: string;
}

interface PipelinesClientProps {
  pipelines: PipelineView[];
  runs: PipelineRunView[];
  employees: EmployeeOption[];
  canManage: boolean;
}

interface StepDraft {
  title: string;
  brief: string;
  aiEmployeeId: string;
}

interface Message {
  tone: "info" | "error";
  text: string;
}

const RUN_STATUS_LABEL: Record<PipelineRunStatus, string> = {
  running: "执行中",
  waiting_review: "待验收",
  done: "已完成",
  partial: "有失败",
};

function runTone(status: PipelineRunStatus): Tone {
  if (status === "done") {
    return "ok";
  }
  if (status === "partial") {
    return "error";
  }
  return status === "waiting_review" ? "warn" : "blue";
}

function formatTime(value: string): string {
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}

const EMPTY_STEP: StepDraft = { title: "", brief: "", aiEmployeeId: "" };

export function PipelinesClient({
  pipelines,
  runs,
  employees,
  canManage,
}: PipelinesClientProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([{ ...EMPTY_STEP }]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  function updateStep(index: number, patch: Partial<StepDraft>) {
    setSteps((current) => current.map((step, item) => (item === index ? { ...step, ...patch } : step)));
  }

  function addStep() {
    setSteps((current) => (current.length >= 10 ? current : [...current, { ...EMPTY_STEP }]));
  }

  function removeStep(index: number) {
    setSteps((current) => (current.length === 1 ? current : current.filter((_, item) => item !== index)));
  }

  async function submitCreate() {
    setBusy("create");
    setMessage(null);
    try {
      const result = await createPipelineAction({
        name: name.trim(),
        description: description.trim(),
        steps: steps.map((step) => ({
          title: step.title.trim(),
          brief: step.brief.trim(),
          aiEmployeeId: step.aiEmployeeId,
          aiEmployeeName: employees.find((employee) => employee.id === step.aiEmployeeId)?.name ?? "AI 员工",
        })),
      });
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setCreating(false);
        setName("");
        setDescription("");
        setSteps([{ ...EMPTY_STEP }]);
      }
    } finally {
      setBusy(null);
    }
  }

  async function run(pipelineId: string) {
    setBusy(pipelineId);
    setMessage(null);
    try {
      const result = await runPipelineAction(pipelineId);
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
    } finally {
      setBusy(null);
    }
  }

  async function toggle(pipelineId: string, enabled: boolean) {
    setBusy(pipelineId);
    setMessage(null);
    try {
      const result = await togglePipelineAction(pipelineId, enabled);
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}

      <SectionCard
        title="产线定义"
        desc="一步一个任务：选择 AI 员工并写清目标与交付要求。运行后按顺序派活，失败即停。"
        right={
          canManage ? (
            <button
              type="button"
              className={`${linkBtn} shrink-0 text-[11px]`}
              onClick={() => setCreating((value) => !value)}
            >
              {creating ? "收起" : "新建产线"}
            </button>
          ) : (
            <span className={meta}>只读（缺少管理产线权限）</span>
          )
        }
      >
        {creating ? (
          <div className="mb-4 grid gap-3 rounded-2xl bg-apple-canvas p-3">
            <div className={formGrid}>
              <Field label="产线名称">
                <input
                  className={input}
                  value={name}
                  maxLength={60}
                  placeholder="例如：季度经营分析"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="说明（可选）">
                <input
                  className={input}
                  value={description}
                  maxLength={300}
                  placeholder="这条产线解决什么问题"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </div>

            <div className="grid gap-2">
              {steps.map((step, index) => (
                <div
                  key={index}
                  className="grid gap-2 rounded-xl border border-hairline bg-white px-3 py-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-zinc-700">第 {index + 1} 步</span>
                    <button
                      type="button"
                      className={`${linkBtn} text-[11px]`}
                      disabled={steps.length === 1}
                      onClick={() => removeStep(index)}
                    >
                      移除
                    </button>
                  </div>
                  <div className={formGrid}>
                    <Field label="任务标题">
                      <input
                        className={input}
                        value={step.title}
                        maxLength={80}
                        placeholder="例如：整理销售数据"
                        onChange={(event) => updateStep(index, { title: event.target.value })}
                      />
                    </Field>
                    <Field label="执行员工">
                      <select
                        className={input}
                        value={step.aiEmployeeId}
                        onChange={(event) => updateStep(index, { aiEmployeeId: event.target.value })}
                      >
                        <option value="">请选择 AI 员工</option>
                        {employees.map((employee) => (
                          <option key={employee.id} value={employee.id}>
                            {employee.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="工作说明">
                    <textarea
                      className={`${input} min-h-[70px] resize-y`}
                      value={step.brief}
                      maxLength={2000}
                      placeholder="目标、背景、约束、交付格式"
                      onChange={(event) => updateStep(index, { brief: event.target.value })}
                    />
                  </Field>
                </div>
              ))}
            </div>

            <div className={actions}>
              <button
                type="button"
                className={btnGhost}
                disabled={steps.length >= 10}
                onClick={addStep}
              >
                添加步骤（最多 10 步）
              </button>
              <button
                type="button"
                className={btnBlue}
                disabled={busy === "create" || !name.trim()}
                onClick={submitCreate}
              >
                {busy === "create" ? "创建中…" : "创建产线"}
              </button>
            </div>
            {employees.length === 0 ? (
              <p className={`${meta} text-amber-600`}>
                当前部门没有已上线且授权的 AI 员工，请先到{" "}
                <Link className={linkBtn} href="/ai-employees">
                  AI 员工
                </Link>{" "}
                创建并上线。
              </p>
            ) : null}
          </div>
        ) : null}

        {pipelines.length === 0 ? (
          <div className="rounded-2xl bg-apple-canvas px-4 py-8 text-center text-[13px] text-zinc-500">
            还没有产线。新建一条，把重复的派活流程固定下来。
          </div>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {pipelines.map((pipeline) => (
              <li key={pipeline.id} className="rounded-xl border border-hairline bg-white px-3 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-zinc-900">{pipeline.name}</span>
                      <span className={badge(pipeline.enabled ? "ok" : "muted")}>
                        {pipeline.enabled ? "启用中" : "已停用"}
                      </span>
                      <span className={badge()}>{pipeline.steps.length} 步</span>
                    </div>
                    {pipeline.description ? (
                      <p className={`${meta} mt-1`}>{pipeline.description}</p>
                    ) : null}
                    <p className={`${meta} mt-1`}>
                      {pipeline.steps
                        .map((step, index) => `${index + 1}. ${step.title}（${step.aiEmployeeName}）`)
                        .join(" → ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className={`${btnBlue} !px-3 !py-1 text-[12px]`}
                      disabled={busy === pipeline.id || !pipeline.enabled}
                      onClick={() => run(pipeline.id)}
                    >
                      {busy === pipeline.id ? "运行中…" : "运行"}
                    </button>
                    {canManage ? (
                      <button
                        type="button"
                        className={`${btnGhost} !px-3 !py-1 text-[12px]`}
                        disabled={busy === pipeline.id}
                        onClick={() => toggle(pipeline.id, !pipeline.enabled)}
                      >
                        {pipeline.enabled ? "停用" : "启用"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="运行记录"
        desc="产线只负责批量派活；执行进度与验收在 AI 员工页完成。"
        right={<span className={badge()}>{runs.length} 条</span>}
      >
        {runs.length === 0 ? (
          <p className={`${meta}`}>还没有运行记录。点击产线的「运行」开始。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>产线</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>失败步骤</th>
                  <th>发起时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.pipelineName}</td>
                    <td>
                      <span className={badge(runTone(run.status))}>{RUN_STATUS_LABEL[run.status]}</span>
                    </td>
                    <td className="mono">
                      执行 {run.activeCount} · 待验收 {run.reviewCount} · 完成 {run.doneCount} · 失败{" "}
                      {run.failedCount}
                    </td>
                    <td className="mono">{run.failedStep ?? "—"}</td>
                    <td className="mono">{formatTime(run.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={`${meta} mt-3`}>
          去{" "}
          <Link className={linkBtn} href="/ai-employees">
            AI 员工
          </Link>{" "}
          查看任务与验收交付物。
        </p>
      </SectionCard>
    </>
  );
}
