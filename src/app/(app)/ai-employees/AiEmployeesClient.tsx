"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { InlineMessage } from "@/components/knowledge/InlineMessage";
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
import type {
  AiEmployeeDetail,
  AiEmployeeGrantCandidates,
  AiEmployeeStatus,
  AiEmployeeView,
} from "@/lib/ai-employees";

import {
  createAiEmployeeAction,
  grantDepartmentAction,
  grantUserAction,
  revokeGrantAction,
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

interface AiEmployeesClientProps {
  employees: AiEmployeeView[];
  detail: AiEmployeeDetail | null;
  candidates: AiEmployeeGrantCandidates | null;
  canManage: boolean;
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
  canManage,
}: AiEmployeesClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(detail?.name ?? "");
  const [editDescription, setEditDescription] = useState(detail?.description ?? "");

  const [departmentId, setDepartmentId] = useState("");
  const [userId, setUserId] = useState("");

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
                  }),
                (result) => {
                  setCreating(false);
                  setSlug("");
                  setName("");
                  setDescription("");
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
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}

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
              AI 员工自身不携带数据权限，运行时（M3）以调用者身份继承部门上下文。
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
