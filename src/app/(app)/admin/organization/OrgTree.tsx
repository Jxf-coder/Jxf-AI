"use client";

import { useMemo, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import Link from "next/link";

import { usePermission } from "@/components/permissions/usePermission";
import { NoticeBar } from "@/components/ui/notice-bar";
import { Select } from "@/components/ui/select";

import {
  checkMemberBlockers,
  deleteDepartment,
  moveMember,
  removeMember,
  reorderDepartments,
  requestMemberRemoval,
} from "./actions";

export interface OrgDepartment {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
}

export interface OrgMember {
  id: string;
  user_id: string;
  department_id: string;
  access_level: "L1" | "L2" | "L3";
  title: string;
  email: string | null;
  phone: string | null;
  name: string | null;
}

type DragItem =
  | { kind: "department"; id: string; name: string; parentId: string | null }
  | { kind: "member"; id: string; name: string; departmentId: string };

interface PendingMove {
  membershipId: string;
  memberName: string;
  fromName: string;
  toId: string;
  toName: string;
}

interface PendingRemoval {
  membershipId: string;
  memberName: string;
}

interface HandoverItem {
  assetType: string;
  assetId: string;
  label: string;
}

interface PendingHandover {
  membershipId: string;
  memberName: string;
  groups: Array<{ assetType: string; label: string; items: HandoverItem[] }>;
}

interface PendingDepartmentDelete {
  departmentId: string;
  departmentName: string;
}

interface Notice {
  kind: "info" | "error";
  text: string;
}

/** 树形渲染防爆：默认最多渲染 4 层，超深层级需手动展开 */
const MAX_TREE_DEPTH = 4;
/** 单次渲染的部门总量上限，防止极端数据量导致 DOM 过载 */
const MAX_DEPARTMENTS = 400;
/** 单个部门默认展示的成员上限 */
const MAX_MEMBERS_PER_DEPARTMENT = 50;

function LevelBadge({ level }: { level: "L1" | "L2" | "L3" }) {
  return (
    <span className={`badge level-${level.toLowerCase()}`}>{level === "L1" ? "老板" : level}</span>
  );
}

export function OrgTree({
  departments,
  members,
}: {
  departments: OrgDepartment[];
  members: OrgMember[];
}) {
  const { can, check } = usePermission();
  const canManageOrg = can("org:manage");
  const canManageMembers = can("member:manage");
  const canOpenProfiles = can("member:view", "DEPT_TREE");
  const readOnlyReason = check("org:manage").reason || check("member:manage").reason;

  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [hoverDepartmentId, setHoverDepartmentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [pendingHandover, setPendingHandover] = useState<PendingHandover | null>(null);
  const [handoverTargets, setHandoverTargets] = useState<Record<string, string>>({});
  const [pendingDepartmentDelete, setPendingDepartmentDelete] =
    useState<PendingDepartmentDelete | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [expandedDeepIds, setExpandedDeepIds] = useState<ReadonlySet<string>>(new Set());

  const departmentNames = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
  );

  const handoverRecipients = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const member of members) {
      if (member.id === pendingHandover?.membershipId || seen.has(member.user_id)) {
        continue;
      }
      seen.add(member.user_id);
      options.push({
        value: member.user_id,
        label: `${member.name || member.phone || "未命名成员"} · ${
          departmentNames.get(member.department_id) ?? "未知部门"
        }`,
      });
    }
    return options;
  }, [members, departmentNames, pendingHandover]);

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, OrgDepartment[]>();
    for (const department of departments) {
      const key = department.parent_id;
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(department);
      } else {
        map.set(key, [department]);
      }
    }
    return map;
  }, [departments]);

  const membersOf = useMemo(() => {
    const map = new Map<string, OrgMember[]>();
    for (const member of members) {
      const bucket = map.get(member.department_id);
      if (bucket) {
        bucket.push(member);
      } else {
        map.set(member.department_id, [member]);
      }
    }
    return map;
  }, [members]);

  const departmentIds = useMemo(
    () => new Set(departments.map((department) => department.id)),
    [departments],
  );

  const roots = useMemo(
    () =>
      departments.filter(
        (department) =>
          department.parent_id === null || !departmentIds.has(department.parent_id),
      ),
    [departments, departmentIds],
  );

  function handleDragOver(event: DragEvent<HTMLElement>, departmentId: string) {
    if (!dragging) {
      return;
    }
    if (dragging.kind === "department" ? !canManageOrg : !canManageMembers) {
      return;
    }
    if (dragging.kind === "department" && dragging.id === departmentId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (hoverDepartmentId !== departmentId) {
      setHoverDepartmentId(departmentId);
    }
  }

  function handleDragLeave(event: DragEvent<HTMLElement>, departmentId: string) {
    if (hoverDepartmentId !== departmentId) {
      return;
    }
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) {
      return;
    }
    setHoverDepartmentId(null);
  }

  function handleDrop(event: DragEvent<HTMLElement>, target: OrgDepartment) {
    event.preventDefault();
    event.stopPropagation();
    setHoverDepartmentId(null);

    const item = dragging;
    setDragging(null);

    if (!item) {
      return;
    }
    if (item.kind === "department" ? !canManageOrg : !canManageMembers) {
      return;
    }

    if (item.kind === "member") {
      if (item.departmentId === target.id) {
        setNotice({ kind: "info", text: `「${item.name}」已经在「${target.name}」，无需移动` });
        return;
      }
      // 跨部门属于高风险操作：先弹确认框，防止拖拽误触
      setPendingMove({
        membershipId: item.id,
        memberName: item.name,
        fromName: departmentNames.get(item.departmentId) ?? "原部门",
        toId: target.id,
        toName: target.name,
      });
      return;
    }

    if (item.id === target.id) {
      return;
    }
    if (item.parentId !== target.parent_id) {
      setNotice({ kind: "error", text: "只能在同一上级部门下拖动排序" });
      return;
    }

    setIsPending(true);
    void (async () => {
      try {
        const result = await reorderDepartments(item.id, target.id);
        if (result.ok) {
          setNotice({ kind: "info", text: `已将「${item.name}」移到「${target.name}」前方` });
        } else {
          setNotice({ kind: "error", text: result.message });
        }
      } finally {
        setIsPending(false);
      }
    })();
  }

  function confirmMove() {
    if (!pendingMove || isPending) {
      return;
    }
    const move = pendingMove;
    setIsPending(true);
    void (async () => {
      try {
        const result = await moveMember(move.membershipId, move.toId);
        if (result.ok) {
          setNotice({
            kind: "info",
            text: `已将「${move.memberName}」从「${move.fromName}」调整到「${move.toName}」`,
          });
        } else {
          setNotice({ kind: "error", text: result.message });
        }
      } finally {
        setPendingMove(null);
        setIsPending(false);
      }
    })();
  }

  /** 移出前先预检：有资产走交接审批；有运行中工作则先改派 */
  function handleRemovalRequest(membershipId: string, memberName: string) {
    if (isPending || !canManageMembers) {
      return;
    }
    setIsPending(true);
    void (async () => {
      try {
        const result = await checkMemberBlockers(membershipId);
        if (!result.ok) {
          setNotice({ kind: "error", text: result.message });
          return;
        }
        if (result.openWork > 0) {
          setNotice({
            kind: "error",
            text: `「${memberName}」还有 ${result.openWork} 个运行中的工作，请先改派后再移出`,
          });
          return;
        }
        if (result.groups.length > 0) {
          setPendingHandover({ membershipId, memberName, groups: result.groups });
          setHandoverTargets(
            Object.fromEntries(
              result.groups.flatMap((group) =>
                group.items.map((item) => [`${item.assetType}:${item.assetId}`, ""]),
              ),
            ),
          );
          return;
        }
        setPendingRemoval({ membershipId, memberName });
      } finally {
        setIsPending(false);
      }
    })();
  }

  /** 提交离职交接审批：成员立即冻结，L1 在审批中心通过后正式停用 */
  function confirmHandover() {
    if (!pendingHandover || isPending) {
      return;
    }
    const target = pendingHandover;
    const assignments = target.groups.flatMap((group) =>
      group.items.map((item) => ({
        assetType: item.assetType,
        assetId: item.assetId,
        toUserId: handoverTargets[`${item.assetType}:${item.assetId}`] ?? "",
      })),
    );
    if (assignments.some((item) => !item.toUserId)) {
      setNotice({ kind: "error", text: "请为每一项资产选择接收人" });
      return;
    }

    setIsPending(true);
    void (async () => {
      try {
        const result = await requestMemberRemoval(target.membershipId, assignments);
        if (result.ok) {
          setNotice({
            kind: "info",
            text: `已提交「${target.memberName}」的离职交接审批，审批通过前该账号已冻结`,
          });
        } else {
          setNotice({ kind: "error", text: result.message });
        }
      } finally {
        setPendingHandover(null);
        setHandoverTargets({});
        setIsPending(false);
      }
    })();
  }

  function confirmRemoval() {
    if (!pendingRemoval || isPending) {
      return;
    }
    const removal = pendingRemoval;
    setIsPending(true);
    void (async () => {
      try {
        const result = await removeMember(removal.membershipId);
        if (result.ok) {
          setNotice({
            kind: "info",
            text: `已将「${removal.memberName}」移出，可在「已停用成员」中恢复`,
          });
        } else {
          setNotice({ kind: "error", text: result.message });
        }
      } finally {
        setPendingRemoval(null);
        setIsPending(false);
      }
    })();
  }

  function confirmDepartmentDeletion() {
    if (!pendingDepartmentDelete || isPending) {
      return;
    }
    const target = pendingDepartmentDelete;
    setIsPending(true);
    void (async () => {
      try {
        const result = await deleteDepartment(target.departmentId);
        if (result.ok) {
          setNotice({ kind: "info", text: `已删除部门「${target.departmentName}」` });
        } else {
          setNotice({ kind: "error", text: result.message });
        }
      } finally {
        setPendingDepartmentDelete(null);
        setIsPending(false);
      }
    })();
  }

  // 每次渲染重置预算，防止超宽树一次性挂载过多节点
  const renderBudget = { departments: 0 };

  function renderDepartment(department: OrgDepartment, depth: number): ReactNode {
    if (renderBudget.departments >= MAX_DEPARTMENTS) {
      return null;
    }
    renderBudget.departments += 1;

    const departmentMembers = membersOf.get(department.id) ?? [];
    const children = childrenOf.get(department.id) ?? [];
    const visibleMembers = departmentMembers.slice(0, MAX_MEMBERS_PER_DEPARTMENT);
    const hiddenMemberCount = departmentMembers.length - visibleMembers.length;
    const deeperLocked =
      depth + 1 >= MAX_TREE_DEPTH &&
      children.length > 0 &&
      !expandedDeepIds.has(department.id);
    const isRoot = department.parent_id === null;
    const droppable =
      dragging !== null &&
      (dragging.kind === "department" ? canManageOrg : canManageMembers);

    return (
      <li
        key={department.id}
        className={`org-node${hoverDepartmentId === department.id ? " is-drop-target" : ""}`}
        onDragOver={(event) => handleDragOver(event, department.id)}
        onDragLeave={(event) => handleDragLeave(event, department.id)}
        onDrop={(event) => handleDrop(event, department)}
      >
        <div
          className={`dept-node${dragging?.kind === "department" && dragging.id === department.id ? " is-dragging" : ""}`}
          draggable={canManageOrg && !isRoot}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", department.id);
            setDragging({
              kind: "department",
              id: department.id,
              name: department.name,
              parentId: department.parent_id,
            });
          }}
          onDragEnd={() => {
            setDragging(null);
            setHoverDepartmentId(null);
          }}
          title={canManageOrg && !isRoot ? "按住拖拽可调整同级顺序" : undefined}
        >
          {canManageOrg && !isRoot ? (
            <span className="dept-grip" aria-hidden="true">
              ⠿
            </span>
          ) : null}
          <span className="dept-name">{department.name}</span>
          <span className="dept-count">{departmentMembers.length} 人</span>
          {canManageOrg && !isRoot ? (
            <button
              type="button"
              className="link-danger dept-delete"
              onClick={() => {
                // 非空部门直接拦截：必须先移出成员、删除子部门，避免反复弹窗却删不掉
                if (departmentMembers.length > 0 || children.length > 0) {
                  const parts = [
                    departmentMembers.length > 0 ? `${departmentMembers.length} 名成员` : null,
                    children.length > 0 ? `${children.length} 个子部门` : null,
                  ].filter(Boolean);
                  setNotice({
                    kind: "error",
                    text: `「${department.name}」下仍有${parts.join("、")}，请先清空后再删除该部门`,
                  });
                  return;
                }
                setPendingDepartmentDelete({
                  departmentId: department.id,
                  departmentName: department.name,
                });
              }}
            >
              删除部门
            </button>
          ) : null}
        </div>

        {departmentMembers.length > 0 ? (
          <>
            <ul className="member-cards">
              {visibleMembers.map((member) => {
              const displayName = member.name?.trim() || member.phone || member.email || "未命名成员";
              return (
                <li
                  key={member.id}
                  className={`member-card${dragging?.kind === "member" && dragging.id === member.id ? " is-dragging" : ""}`}
                  draggable={canManageMembers}
                  onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", member.id);
                    setDragging({
                      kind: "member",
                      id: member.id,
                      name: displayName,
                      departmentId: member.department_id,
                    });
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setHoverDepartmentId(null);
                  }}
                  title={canManageMembers ? "按住拖拽可移动到其他部门" : undefined}
                >
                  <span className="member-identity">
                    <LevelBadge level={member.access_level} />
                    {canOpenProfiles ? (
                      <Link
                        className="member-name member-name-link"
                        href={`/me/profile?userId=${member.user_id}`}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        {displayName}
                      </Link>
                    ) : (
                      <strong className="member-name">{displayName}</strong>
                    )}
                    <span className="member-title">· {member.title || "—"}</span>
                  </span>
                  {canManageMembers && member.access_level !== "L1" ? (
                    <button
                      type="button"
                      className="link-danger"
                      onClick={() => handleRemovalRequest(member.id, displayName)}
                    >
                      移出
                    </button>
                  ) : null}
                </li>
                );
            })}
            </ul>
            {hiddenMemberCount > 0 ? (
              <p className="dept-empty">
                另有 {hiddenMemberCount} 名成员未展示（单部门最多展示 {MAX_MEMBERS_PER_DEPARTMENT} 人，
                可在「员工管理」中筛选查看）
              </p>
            ) : null}
          </>
        ) : (
          <p className="dept-empty">{droppable ? "暂无成员 · 可拖入成员" : "暂无成员"}</p>
        )}

        {children.length > 0 ? (
          deeperLocked ? (
            <div className="dept-more">
              <span>
                还有 {children.length} 个下级部门已折叠（最多渲染 {MAX_TREE_DEPTH} 层）
              </span>
              <button
                type="button"
                className="button button-ghost"
                onClick={() =>
                  setExpandedDeepIds((current) => {
                    const next = new Set(current);
                    next.add(department.id);
                    return next;
                  })
                }
              >
                展开本级
              </button>
            </div>
          ) : (
            <ul className={`role-tree role-tree-depth-${Math.min(depth + 1, 3)}`}>
              {children.map((child) => renderDepartment(child, depth + 1))}
            </ul>
          )
        ) : null}
      </li>
    );
  }

  return (
    <>
      {canManageOrg || canManageMembers ? (
        <p className="hint drag-hint">
          {canManageOrg ? "按住部门行可拖动调整同级顺序。" : null}
          {canManageMembers ? "按住成员名片可拖动到其他部门，跨部门调整会二次确认。" : null}
        </p>
      ) : (
        <p className="hint">当前为只读视图：{readOnlyReason || "缺少管理权限"}</p>
      )}

      {notice ? (
        <NoticeBar kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </NoticeBar>
      ) : null}

      <ul className="role-tree">
        {roots.map((department) => renderDepartment(department, 0))}
      </ul>

      {departments.length > MAX_DEPARTMENTS ? (
        <p className="hint">
          部门数量超过 {MAX_DEPARTMENTS}，已仅渲染前 {MAX_DEPARTMENTS} 个；可通过「员工管理」按部门筛选查看。
        </p>
      ) : null}

      {pendingMove ? (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-label="确认调整成员部门">
          <button
            type="button"
            className="confirm-backdrop"
            aria-label="取消"
            onClick={() => {
              if (!isPending) {
                setPendingMove(null);
              }
            }}
          />
          <div className="confirm-card">
            <h3 className="confirm-title">确认调整成员部门？</h3>
            <p className="confirm-desc">
              将「{pendingMove.memberName}」从「{pendingMove.fromName}」移动到「{pendingMove.toName}」。
              调整后该成员的数据权限与知识库可见范围会随之变化。
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setPendingMove(null)}
                disabled={isPending}
              >
                取消
              </button>
              <button type="button" className="button" onClick={confirmMove} disabled={isPending}>
                {isPending ? "处理中…" : "确定移动"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingRemoval ? (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-label="确认移出成员">
          <button
            type="button"
            className="confirm-backdrop"
            aria-label="取消"
            onClick={() => {
              if (!isPending) {
                setPendingRemoval(null);
              }
            }}
          />
          <div className="confirm-card">
            <h3 className="confirm-title">确认移出成员？</h3>
            <p className="confirm-desc">
              移出后，「{pendingRemoval.memberName}」将无法再登录 Jxf-AI 工作台。
              其历史审计日志和创建的部门资产将被保留。
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setPendingRemoval(null)}
                disabled={isPending}
              >
                取消
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={confirmRemoval}
                disabled={isPending}
              >
                {isPending ? "处理中…" : "确认移出"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingHandover ? (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-label="离职交接">
          <button
            type="button"
            className="confirm-backdrop"
            aria-label="取消"
            onClick={() => {
              if (!isPending) {
                setPendingHandover(null);
                setHandoverTargets({});
              }
            }}
          />
          <div className="confirm-card handover-card">
            <h3 className="confirm-title">离职交接 · {pendingHandover.memberName}</h3>
            <p className="confirm-desc">
              提交后该成员立即冻结、无法登录；由 L1 在「审批中心」通过后资产完成转移并正式停用。
            </p>
            <div className="handover-groups">
              {pendingHandover.groups.map((group) => (
                <section className="handover-group" key={group.assetType}>
                  <h4 className="handover-group-title">
                    {group.label} · {group.items.length} 项
                  </h4>
                  {group.items.map((item) => {
                    const itemKey = `${item.assetType}:${item.assetId}`;
                    return (
                      <div className="handover-item" key={itemKey}>
                        <span className="handover-item-label">{item.label}</span>
                        <Select
                          className="handover-recipient"
                          value={handoverTargets[itemKey] ?? ""}
                          aria-label={`${item.label}接收人`}
                          options={[{ value: "", label: "选择接收人" }, ...handoverRecipients]}
                          onValueChange={(value) =>
                            setHandoverTargets((current) => ({ ...current, [itemKey]: value }))
                          }
                        />
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  setPendingHandover(null);
                  setHandoverTargets({});
                }}
                disabled={isPending}
              >
                取消
              </button>
              <button
                type="button"
                className="button"
                onClick={confirmHandover}
                disabled={isPending}
              >
                {isPending ? "处理中…" : "提交交接审批"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDepartmentDelete ? (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-label="确认删除部门">
          <button
            type="button"
            className="confirm-backdrop"
            aria-label="取消"
            onClick={() => {
              if (!isPending) {
                setPendingDepartmentDelete(null);
              }
            }}
          />
          <div className="confirm-card">
            <h3 className="confirm-title">确认删除部门？</h3>
            <p className="confirm-desc">
              删除后，「{pendingDepartmentDelete.departmentName}」将从组织架构中移除，此操作不可撤销。
              当前部门下已无成员与子部门。
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setPendingDepartmentDelete(null)}
                disabled={isPending}
              >
                取消
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={confirmDepartmentDeletion}
                disabled={isPending}
              >
                {isPending ? "处理中…" : "删除部门"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
