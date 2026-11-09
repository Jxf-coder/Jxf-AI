"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { ChevronIcon } from "@/components/ui/icons";
import {
  badge,
  btnBlue,
  btnGhost,
  card,
  cardDesc,
  cardHead,
  cardTitle,
  divider,
  emptyState,
  fieldLabel,
  input,
  linkBtn,
  meta,
} from "@/components/knowledge/tokens";
import type { AiEmployeeDetail, AiEmployeeGrantCandidates, AiEmployeeStatus, AiEmployeeView } from "@/lib/ai-employees";
import type { McpToolOptionView } from "@/lib/mcp/connectors";
import type { SkillOptionView } from "@/lib/skills";
import type { WorkItemView, WorkPriority } from "@/lib/work-items";

import {
  assignWorkAction,
  createAiEmployeeAction,
  grantDepartmentAction,
  grantUserAction,
  rerunWorkAction,
  revokeGrantAction,
  reviewWorkAction,
  setAiEmployeeStatusAction,
  updateAiEmployeeAction,
} from "./actions";

const STATUS_LABEL: Record<AiEmployeeStatus, string> = {
  draft: "草稿",
  active: "已上线",
  disabled: "已停用",
};

const STATUS_TONE: Record<AiEmployeeStatus, "muted" | "ok" | "warn"> = {
  draft: "muted",
  active: "ok",
  disabled: "warn",
};

const WORK_STATUS_LABEL: Record<WorkItemView["status"], string> = {
  draft: "草稿",
  queued: "排队中",
  running: "执行中",
  waiting_review: "待验收",
  done: "已完成",
  returned: "已退回",
  failed: "失败",
  cancelled: "已取消",
};

const WORK_STATUS_TONE: Record<WorkItemView["status"], "muted" | "ok" | "warn" | "blue" | "error"> = {
  draft: "muted",
  queued: "blue",
  running: "blue",
  waiting_review: "warn",
  done: "ok",
  returned: "warn",
  failed: "error",
  cancelled: "muted",
};

const PRIORITY_LABEL: Record<WorkPriority, string> = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(iso: string | null): string {
  return iso ? TIME_FORMAT.format(new Date(iso)) : "";
}

const SKILL_CATEGORY_LABEL: Record<string, string> = {
  creation: "创作",
  production: "共用制作",
  expert: "专家",
  video: "视频 / 播客",
  knowledge: "知识库",
  music: "音乐",
  tool: "工具",
  learning: "学习提炼",
  teaching: "教学",
  finance: "财务",
  admin: "行政",
};

/** 多选下拉：受工作台权限开关约束的 Skill 选项 */
function SkillMultiSelect({
  options,
  value,
  onChange,
}: {
  options: SkillOptionView[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.filter((option) => value.includes(option.key));

  function toggle(key: string) {
    onChange(value.includes(key) ? value.filter((item) => item !== key) : [...value, key]);
  }

  return (
    <div className="relative">
      <div
        role="button"
        tabIndex={0}
        className={`${input} flex min-h-[42px] cursor-pointer flex-wrap items-center gap-1.5 py-2 text-left`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((current) => !current);
          }
        }}
      >
        {selected.length === 0 ? (
          <span className="text-zinc-400">选择可调用的 Skill</span>
        ) : (
          selected.map((option) => (
            <span
              key={option.key}
              className="inline-flex items-center gap-1 rounded-full bg-apple-blue-soft px-2 py-0.5 text-[11px] text-apple-blue"
            >
              {option.name}
              <button
                type="button"
                aria-label={`移除 ${option.name}`}
                className="text-apple-blue/60 hover:text-apple-blue"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(option.key);
                }}
              >
                ×
              </button>
            </span>
          ))
        )}
        <span className="ml-auto text-[11px] text-zinc-400">▾</span>
      </div>

      {open ? (
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-2xl border border-hairline bg-white p-2 shadow-lg">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-zinc-500">
              当前等级没有可选 Skill；请检查工作台权限开关。
            </p>
          ) : (
            options.map((option) => (
              <label
                key={option.key}
                className="flex cursor-pointer items-start gap-2 rounded-xl px-2 py-2 hover:bg-apple-canvas"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={value.includes(option.key)}
                  onChange={() => toggle(option.key)}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-zinc-900">{option.name}</span>
                    <span className="font-mono text-[10px] text-zinc-400">{option.key}</span>
                    <span className={badge("muted")}>
                      {SKILL_CATEGORY_LABEL[option.category] ?? option.category}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                    {option.summary || "—"}
                  </span>
                </span>
              </label>
            ))
          )}
          <div className="flex justify-end border-t border-hairline px-2 pt-2">
            <button type="button" className={`${linkBtn} text-[11px]`} onClick={() => setOpen(false)}>
              完成
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface AiEmployeesClientProps {
  employees: AiEmployeeView[];
  detail: AiEmployeeDetail | null;
  candidates: AiEmployeeGrantCandidates | null;
  workItems: WorkItemView[];
  mcpTools: McpToolOptionView[];
  skillOptions: SkillOptionView[];
  accessLevel: string | null;
  canManage: boolean;
  canAssign: boolean;
}

interface ActionOutcome {
  ok: boolean;
  message: string;
  id?: string;
}

export function AiEmployeesClient({
  employees,
  detail,
  candidates,
  workItems,
  mcpTools,
  skillOptions,
  accessLevel,
  canManage,
  canAssign,
}: AiEmployeesClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createSkills, setCreateSkills] = useState<string[]>([]);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(detail?.name ?? "");
  const [editDescription, setEditDescription] = useState(detail?.description ?? "");
  const [editPersona, setEditPersona] = useState(detail?.persona ?? "");
  const [editSystemPrompt, setEditSystemPrompt] = useState(detail?.systemPrompt ?? "");
  const [editSkills, setEditSkills] = useState<string[]>(detail?.skillKeys ?? []);
  const [editTools, setEditTools] = useState((detail?.allowedTools ?? []).join(", "));
  const [editTier, setEditTier] = useState<"deep" | "fast">(detail?.modelTier ?? "deep");
  const [editReviewMode, setEditReviewMode] = useState<"manual" | "auto">(
    detail?.reviewMode ?? "manual",
  );
  const [editMinChars, setEditMinChars] = useState(String(detail?.autoMinChars ?? 120));

  const [departmentId, setDepartmentId] = useState("");
  const [userId, setUserId] = useState("");

  const [assignOpen, setAssignOpen] = useState(false);
  const [workTitle, setWorkTitle] = useState("");
  const [workBrief, setWorkBrief] = useState("");
  const [workPriority, setWorkPriority] = useState<WorkPriority>("normal");
  const [workDue, setWorkDue] = useState("");
  const [openWorkId, setOpenWorkId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  // 有排队 / 执行中的工作时自动刷新，状态推进无需手动操作
  useEffect(() => {
    const active = workItems.some((item) => item.status === "queued" || item.status === "running");
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [workItems, router]);

  function run(action: () => Promise<ActionOutcome>, done?: (result: ActionOutcome) => void) {
    startTransition(async () => {
      const result = await action();
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        done?.(result);
        router.refresh();
      }
    });
  }

  /** 连接器工具以 mcp:<serverId>:<toolName> 存进 allowedTools，逗号分隔 */
  function toggleToolToken(value: string) {
    setEditTools((previous) => {
      const list = previous
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
      const next = list.includes(value)
        ? list.filter((item) => item !== value)
        : [...list, value];
      return next.join(", ");
    });
  }

  return (
    <div className="mt-5 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
      <aside
        aria-label="AI 员工目录"
        className="rounded-2xl border border-hairline bg-[#f7f8fa] p-2"
      >
        <div className="flex items-center justify-between px-2 py-1">
          <p className="text-[11px] font-medium text-zinc-500">目录 · {employees.length}</p>
          {canManage ? (
            <button
              type="button"
              className={`${linkBtn} text-[11px]`}
              onClick={() => setCreating((value) => !value)}
            >
              {creating ? "取消" : "新建"}
            </button>
          ) : null}
        </div>

        {creating ? (
          <form
            className="mb-2 grid gap-2 rounded-xl bg-white p-3 ring-1 ring-black/5"
            onSubmit={(event) => {
              event.preventDefault();
              run(
                () =>
                  createAiEmployeeAction({
                    slug: slug.trim(),
                    name: name.trim(),
                    description: description.trim(),
                    skillKeys: createSkills,
                  }),
                (result) => {
                  setCreating(false);
                  setSlug("");
                  setName("");
                  setDescription("");
                  setCreateSkills([]);
                  if (result.id) {
                    router.push(`/ai-employees?ai=${result.id}`);
                  }
                },
              );
            }}
          >
            <label className="block">
              <span className={fieldLabel}>标识</span>
              <input
                className={input}
                value={slug}
                maxLength={64}
                required
                placeholder="kb-assistant"
                onChange={(event) => setSlug(event.target.value)}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>名称</span>
              <input
                className={input}
                value={name}
                maxLength={60}
                required
                placeholder="知识库助手"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>描述</span>
              <textarea
                className={`${input} min-h-[72px] resize-y`}
                value={description}
                maxLength={500}
                placeholder="它能做什么、服务哪个岗位"
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <div className="block">
              <span className={fieldLabel}>分配 Skill</span>
              <SkillMultiSelect options={skillOptions} value={createSkills} onChange={setCreateSkills} />
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                可选范围受工作台权限开关约束：当前 {accessLevel ?? "-"}；不存在的 Key 会被服务端拒绝。
              </p>
            </div>
            <button type="submit" className={btnBlue} disabled={pending}>
              {pending ? "创建中…" : "创建草稿"}
            </button>
          </form>
        ) : null}

        {employees.length === 0 ? (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-zinc-400">
            还没有对你开放的 AI 员工。需要管理员授权后才能看到。
          </p>
        ) : (
          employees.map((employee) => {
            const active = detail?.id === employee.id;
            return (
              <Link
                key={employee.id}
                href={`/ai-employees?ai=${employee.id}`}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={`block rounded-xl px-2 py-2 transition-colors ${
                  active ? "bg-white ring-1 ring-black/5" : "hover:bg-white/70"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-zinc-800">
                    {employee.name}
                  </span>
                  <span className={`ml-auto shrink-0 ${badge(STATUS_TONE[employee.status])}`}>
                    {STATUS_LABEL[employee.status]}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                  {employee.description || `@${employee.slug}`}
                </span>
              </Link>
            );
          })
        )}
      </aside>

      <div className="min-w-0">
        {message ? (
          <InlineMessage tone={failed ? "error" : "info"} className="mb-3 mt-0">
            {message}
          </InlineMessage>
        ) : null}

        {!detail ? (
          <div className={emptyState}>
            当前没有可见的 AI 员工。未授权账号看不到任何名称与描述；如需开通请联系 L1 管理员。
          </div>
        ) : (
          <section className={card}>
            <div className={cardHead}>
              <div className="min-w-0">
                <h2 className={cardTitle}>{detail.name}</h2>
                <p className={`${meta} mt-0.5`}>
                  @{detail.slug} · {STATUS_LABEL[detail.status]}
                  {detail.createdByName ? ` · 创建者 ${detail.createdByName}` : ""}
                </p>
              </div>
              {canManage ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={`${linkBtn} text-[11px]`}
                    onClick={() => setEditing((value) => !value)}
                  >
                    {editing ? "收起编辑" : "编辑"}
                  </button>
                  {detail.status !== "active" ? (
                    <button
                      type="button"
                      className={`${linkBtn} text-[11px]`}
                      disabled={pending}
                      onClick={() =>
                        run(() => setAiEmployeeStatusAction(detail.id, "active"))
                      }
                    >
                      上线
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`${linkBtn} text-[11px]`}
                      disabled={pending}
                      onClick={() =>
                        run(() => setAiEmployeeStatusAction(detail.id, "disabled"))
                      }
                    >
                      停用
                    </button>
                  )}
                </div>
              ) : null}
            </div>

            <p className={cardDesc}>{detail.description || "暂无描述"}</p>

            <p className={`${meta} mb-3`}>
              模型档位：{detail.modelTier === "fast" ? "轻量快速（flash）" : "深度推理（pro）"}
              {detail.skillKeys.length > 0
                ? ` · 技能 ${detail.skillKeys
                    .map((key) => skillOptions.find((option) => option.key === key)?.name ?? key)
                    .join(" / ")}`
                : ""}
              {detail.allowedTools.length > 0 ? ` · 工具 ${detail.allowedTools.join(" / ")}` : ""}
              {detail.reviewMode === "auto"
                ? ` · 自动验收（≥ ${detail.autoMinChars} 字）`
                : " · 人工验收"}
            </p>

            {detail.status === "draft" ? (
              <p className={`${meta} mb-3`}>
                草稿仅创建者与 L1 可见；上线后才按授权开放给部门与成员。
              </p>
            ) : null}

            {editing && canManage ? (
              <div className="mb-4 grid gap-2 rounded-2xl bg-apple-canvas p-3">
                <label className="block">
                  <span className={fieldLabel}>名称</span>
                  <input
                    className={input}
                    value={editName}
                    maxLength={60}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                </label>
                <label className="block">
                  <span className={fieldLabel}>描述</span>
                  <textarea
                    className={`${input} min-h-[90px] resize-y`}
                    value={editDescription}
                    maxLength={500}
                    onChange={(event) => setEditDescription(event.target.value)}
                  />
                </label>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className={fieldLabel}>人格描述</span>
                    <textarea
                      className={`${input} min-h-[80px] resize-y`}
                      value={editPersona}
                      maxLength={2000}
                      placeholder="它的工作风格与立场，会拼进系统提示"
                      onChange={(event) => setEditPersona(event.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className={fieldLabel}>系统提示（可选）</span>
                    <textarea
                      className={`${input} min-h-[80px] resize-y`}
                      value={editSystemPrompt}
                      maxLength={8000}
                      placeholder="留空则由人格描述 + 默认约束生成"
                      onChange={(event) => setEditSystemPrompt(event.target.value)}
                    />
                  </label>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="block">
                    <span className={fieldLabel}>分配 Skill</span>
                    <SkillMultiSelect options={skillOptions} value={editSkills} onChange={setEditSkills} />
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                      受工作台权限开关约束：当前 {accessLevel ?? "-"}；保存时会拒绝悬空 Key。
                    </p>
                  </div>
                  <label className="block">
                    <span className={fieldLabel}>可用工具</span>
                    <input
                      className={input}
                      value={editTools}
                      placeholder="留空表示暂不开放工具"
                      onChange={(event) => setEditTools(event.target.value)}
                    />
                  </label>
                </div>

                {mcpTools.length > 0 ? (
                  <div className="rounded-2xl bg-apple-canvas p-3">
                    <span className={fieldLabel}>连接器工具（点击加入 / 移除）</span>
                    <div className="flex flex-wrap gap-1.5">
                      {mcpTools.map((tool) => {
                        const active = editTools.includes(tool.value);
                        return (
                          <button
                            key={tool.value}
                            type="button"
                            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                              active
                                ? "border-apple-blue/20 bg-apple-blue-soft text-apple-blue"
                                : "border-black/[0.06] bg-white text-zinc-600 hover:bg-apple-canvas"
                            }`}
                            title={tool.description}
                            onClick={() => toggleToolToken(tool.value)}
                          >
                            {tool.serverName} · {tool.toolName}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                <label className="block sm:w-[200px]">
                  <span className={fieldLabel}>模型档位</span>
                  <select
                    className={input}
                    value={editTier}
                    onChange={(event) => setEditTier(event.target.value as "deep" | "fast")}
                  >
                    <option value="deep">深度推理（pro）</option>
                    <option value="fast">轻量快速（flash）</option>
                  </select>
                </label>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className={fieldLabel}>验收方式</span>
                    <select
                      className={input}
                      value={editReviewMode}
                      onChange={(event) => setEditReviewMode(event.target.value as "manual" | "auto")}
                    >
                      <option value="manual">人工验收（默认）</option>
                      <option value="auto">自动验收（满足门槛直接完成）</option>
                    </select>
                  </label>
                  {editReviewMode === "auto" ? (
                    <label className="block">
                      <span className={fieldLabel}>自动验收最小字数</span>
                      <input
                        type="number"
                        min={0}
                        max={5000}
                        className={input}
                        value={editMinChars}
                        onChange={(event) => setEditMinChars(event.target.value)}
                      />
                    </label>
                  ) : null}
                </div>

                {editReviewMode === "auto" ? (
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    交付物达到字数门槛且不含「待确认 / 待补充 / 无法确定」等未决标记时自动完成；否则仍转人工验收。
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnBlue}
                    disabled={pending || editName.trim().length === 0}
                    onClick={() =>
                      run(
                        () =>
                          updateAiEmployeeAction(detail.id, {
                            name: editName.trim(),
                            description: editDescription.trim(),
                            persona: editPersona.trim(),
                            systemPrompt: editSystemPrompt.trim(),
                            skillKeys: editSkills,
                            allowedTools: editTools
                              .split(/[,，\n]/)
                              .map((item) => item.trim())
                              .filter(Boolean),
                            modelTier: editTier,
                            reviewMode: editReviewMode,
                            autoMinChars: editMinChars.trim() === "" ? undefined : Number(editMinChars),
                          }),
                        () => setEditing(false),
                      )
                    }
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={pending}
                    onClick={() => {
                      setEditing(false);
                      setEditName(detail.name);
                      setEditDescription(detail.description);
                      setEditPersona(detail.persona);
                      setEditSystemPrompt(detail.systemPrompt);
                      setEditSkills(detail.skillKeys);
                      setEditTools(detail.allowedTools.join(", "));
                      setEditTier(detail.modelTier);
                      setEditReviewMode(detail.reviewMode);
                      setEditMinChars(String(detail.autoMinChars));
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}

            <div className={divider} />

            {canAssign && detail.status === "active" ? (
              <div className="rounded-2xl bg-apple-canvas p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-zinc-900">安排工作</p>
                    <p className={meta}>
                      派发给{detail.name}，
                      {detail.reviewMode === "auto" ? "满足门槛自动完成，否则转人工验收" : "执行完成后进入待验收"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${linkBtn} shrink-0 text-[11px]`}
                    onClick={() => setAssignOpen((value) => !value)}
                  >
                    {assignOpen ? "收起" : "派活"}
                  </button>
                </div>

                {assignOpen ? (
                  <form
                    className="mt-3 grid gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(
                        () =>
                          assignWorkAction({
                            aiEmployeeId: detail.id,
                            title: workTitle.trim(),
                            brief: workBrief.trim(),
                            priority: workPriority,
                            dueAt: workDue ? `${workDue}T23:59:59+08:00` : null,
                          }),
                        (result) => {
                          if (!result.ok) {
                            return;
                          }
                          setAssignOpen(false);
                          setWorkTitle("");
                          setWorkBrief("");
                          setWorkDue("");
                          setWorkPriority("normal");
                        },
                      );
                    }}
                  >
                    <input
                      className={input}
                      value={workTitle}
                      maxLength={80}
                      required
                      placeholder="工作标题，例如：整理本周客户投诉并给出改进建议"
                      onChange={(event) => setWorkTitle(event.target.value)}
                    />
                    <textarea
                      className={`${input} min-h-[96px] resize-y`}
                      value={workBrief}
                      maxLength={4000}
                      required
                      placeholder="工作说明：目标、背景、可用资料、交付格式与验收要点"
                      onChange={(event) => setWorkBrief(event.target.value)}
                    />
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="block w-[120px]">
                        <span className={fieldLabel}>优先级</span>
                        <select
                          className={input}
                          value={workPriority}
                          onChange={(event) => setWorkPriority(event.target.value as WorkPriority)}
                        >
                          {(["low", "normal", "high", "urgent"] as WorkPriority[]).map((priority) => (
                            <option key={priority} value={priority}>
                              {PRIORITY_LABEL[priority]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block w-[170px]">
                        <span className={fieldLabel}>截止时间</span>
                        <input
                          type="date"
                          className={input}
                          value={workDue}
                          onChange={(event) => setWorkDue(event.target.value)}
                        />
                      </label>
                      <button
                        type="submit"
                        className={btnBlue}
                        disabled={pending || workTitle.trim().length === 0 || workBrief.trim().length === 0}
                      >
                        {pending ? "派发中…" : "派发工作"}
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            ) : null}

            <div className={divider} />

            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[13px] font-semibold text-zinc-900">工作记录</h3>
              <span className={meta}>{workItems.length} 项</span>
            </div>

            {workItems.length === 0 ? (
              <p className={`${meta} mt-1`}>
                还没有给{detail.name}安排工作。派活后在这里跟踪执行与验收。
              </p>
            ) : (
              <ul className="mt-2 grid list-none gap-2 p-0">
                {workItems.map((item) => {
                  const open = openWorkId === item.id;
                  return (
                    <li
                      key={item.id}
                      className="rounded-xl border border-hairline bg-white px-3 py-2"
                    >
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 text-left"
                        aria-expanded={open}
                        onClick={() => setOpenWorkId(open ? null : item.id)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-zinc-900">
                              {item.title}
                            </span>
                            <span className={badge(WORK_STATUS_TONE[item.status])}>
                              {WORK_STATUS_LABEL[item.status]}
                            </span>
                            <span className={meta}>{PRIORITY_LABEL[item.priority]}</span>
                          </span>
                          <span className={`${meta} mt-0.5 block`}>
                            {item.assignedByName ?? "—"} 派发 · {formatTime(item.createdAt)}
                            {item.dueAt ? ` · 截止 ${formatTime(item.dueAt)}` : ""}
                          </span>
                        </span>
                        <ChevronIcon
                          size={14}
                          className={`mt-1 shrink-0 text-zinc-400 transition-transform ${
                            open ? "rotate-180" : ""
                          }`}
                        />
                      </button>

                      {open ? (
                        <div className="mt-2 border-t border-hairline pt-2">
                          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-600">
                            {item.brief}
                          </p>

                          {item.deliverableText ? (
                            <div className="mt-2 rounded-xl bg-apple-canvas p-3">
                              <p className={meta}>
                                交付物
                                {item.deliverableModel ? ` · ${item.deliverableModel}` : ""}
                              </p>
                              <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-800">
                                {item.deliverableText}
                              </p>
                            </div>
                          ) : (
                            <p className={`${meta} mt-2`}>
                              {item.status === "queued"
                                ? "排队中，等待 worker 领取。"
                                : item.status === "running"
                                  ? "正在执行…"
                                  : "暂无交付物"}
                            </p>
                          )}

                          {item.reviewNote ? (
                            <p className={`${meta} mt-2`}>验收备注：{item.reviewNote}</p>
                          ) : null}

                          {["returned", "failed", "cancelled"].includes(item.status) && canAssign ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                className={btnBlue}
                                disabled={pending}
                                onClick={() => run(() => rerunWorkAction(item.id))}
                              >
                                重新执行
                              </button>
                            </div>
                          ) : null}

                          {item.status === "waiting_review" && canAssign ? (
                            <div className="mt-2 grid gap-2">
                              <input
                                className={input}
                                value={reviewNotes[item.id] ?? ""}
                                maxLength={1000}
                                placeholder="验收备注（可选，退回时建议填写）"
                                onChange={(event) =>
                                  setReviewNotes((previous) => ({
                                    ...previous,
                                    [item.id]: event.target.value,
                                  }))
                                }
                              />
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className={btnBlue}
                                  disabled={pending}
                                  onClick={() =>
                                    run(() =>
                                      reviewWorkAction(item.id, "approve", reviewNotes[item.id] ?? ""),
                                    )
                                  }
                                >
                                  验收通过
                                </button>
                                <button
                                  type="button"
                                  className={btnGhost}
                                  disabled={pending}
                                  onClick={() =>
                                    run(() =>
                                      reviewWorkAction(item.id, "return", reviewNotes[item.id] ?? ""),
                                    )
                                  }
                                >
                                  退回重做
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className={divider} />

            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[13px] font-semibold text-zinc-900">使用授权</h3>
              <span className={meta}>{detail.grants.length} 条</span>
            </div>

            {detail.grants.length === 0 ? (
              <p className={`${meta} mt-1`}>
                暂无授权。上线前至少给一个部门或成员授权，否则只有创建者可见。
              </p>
            ) : (
              <ul className="mt-2 grid list-none gap-1.5 p-0">
                {detail.grants.map((grant) => (
                  <li
                    key={grant.id}
                    className="flex items-center gap-2 rounded-xl bg-apple-canvas px-3 py-2"
                  >
                    <span className={badge(grant.targetType === "department" ? "blue" : "muted")}>
                      {grant.targetType === "department" ? "部门" : "成员"}
                    </span>
                    <span className="truncate text-[13px] text-zinc-800">{grant.targetName}</span>
                    <span className={meta}>{grant.capability === "manage" ? "管理" : "使用"}</span>
                    {canManage && grant.capability !== "manage" ? (
                      <button
                        type="button"
                        className={`${linkBtn} ml-auto text-[11px]`}
                        disabled={pending}
                        onClick={() => run(() => revokeGrantAction(grant.id))}
                      >
                        撤回
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {canManage && candidates ? (
              <div className="mt-3 grid gap-2 rounded-2xl bg-apple-canvas p-3">
                <p className="text-[11px] font-medium text-zinc-500">添加授权</p>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-full sm:w-[260px]">
                    <select
                      className={input}
                      value={departmentId}
                      disabled={pending}
                      onChange={(event) => setDepartmentId(event.target.value)}
                    >
                      <option value="">选择部门…</option>
                      {candidates.departments.map((department) => (
                        <option key={department.id} value={department.id}>
                          {department.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={pending || !departmentId}
                    onClick={() =>
                      run(
                        () => grantDepartmentAction(detail.id, departmentId),
                        () => setDepartmentId(""),
                      )
                    }
                  >
                    授权部门
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-full sm:w-[260px]">
                    <select
                      className={input}
                      value={userId}
                      disabled={pending}
                      onChange={(event) => setUserId(event.target.value)}
                    >
                      <option value="">选择成员…</option>
                      {candidates.users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}（{user.email}）
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={pending || !userId}
                    onClick={() =>
                      run(
                        () => grantUserAction(detail.id, userId),
                        () => setUserId(""),
                      )
                    }
                  >
                    授权成员
                  </button>
                </div>

                <p className={meta}>
                  部门授权自动覆盖其全部子部门；个人授权是例外，不随部门调整。
                </p>
              </div>
            ) : null}

            <p className={`${meta} mt-4`}>
              AI 员工自身不携带数据权限，运行时继承派发者的部门上下文；交付物必须人工验收后才算完成。
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
