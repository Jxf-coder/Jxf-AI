"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NoticeBar } from "@/components/ui/notice-bar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";

import {
  addMember,
  checkMemberPendingApprovals,
  removeMember,
  restoreMember,
  updateMemberBasics,
} from "./actions";

export interface MemberTableRow {
  membershipId: string;
  userId: string;
  name: string;
  phone: string;
  email: string | null;
  departmentId: string;
  departmentName: string;
  title: string;
  employeeNo: string;
  hireDate: string | null;
  birthday: string | null;
  position: string;
  level: "L1" | "L2" | "L3";
  status: "active" | "removed";
  removedAt: string | null;
}

/** 由入职日期动态计算司龄，不落库 */
function formatTenure(hireDate: string | null): string {
  if (!hireDate) {
    return "—";
  }
  const start = new Date(`${hireDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return "—";
  }
  const now = new Date();
  let months =
    (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) {
    months -= 1;
  }
  if (months < 0) {
    return "—";
  }
  const years = Math.floor(months / 12);
  const restMonths = months % 12;
  if (years > 0) {
    return `${years} 年 ${restMonths} 个月`;
  }
  if (restMonths > 0) {
    return `${restMonths} 个月`;
  }
  return "不足 1 个月";
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

type StatusFilter = "active" | "removed" | "all";

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "active", label: "在职" },
  { value: "removed", label: "已停用" },
  { value: "all", label: "全部" },
];

export function MembersTab({
  rows,
  departments,
  canManageMembers,
  defaultDepartmentId,
  initialStatus,
  initialDepartmentId,
  initialSearch,
}: {
  rows: MemberTableRow[];
  departments: Array<{ id: string; name: string }>;
  canManageMembers: boolean;
  defaultDepartmentId: string;
  initialStatus: StatusFilter;
  initialDepartmentId: string;
  initialSearch: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [search, setSearch] = useState(initialSearch);
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MemberTableRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<MemberTableRow | null>(null);
  const [removalTarget, setRemovalTarget] = useState<MemberTableRow | null>(null);
  const [pendingBlock, setPendingBlock] = useState<{
    row: MemberTableRow;
    count: number;
  } | null>(null);
  const [transferToUserId, setTransferToUserId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const departmentOptions = useMemo(
    () => [{ value: "all", label: "全部部门" }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
    [departments],
  );

  /** 审批单转交候选人：其他在职成员（按人去重） */
  const transferOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const row of rows) {
      if (
        row.status !== "active" ||
        row.userId === pendingBlock?.row.userId ||
        seen.has(row.userId)
      ) {
        continue;
      }
      seen.add(row.userId);
      options.push({
        value: row.userId,
        label: `${row.name?.trim() || row.phone || "未命名成员"} · ${row.departmentName || "未知部门"}`,
      });
    }
    return options;
  }, [rows, pendingBlock]);

  /** 筛选条件写入 URL：刷新页面或从其他页面返回后不被重置 */
  function syncQuery(next: { status?: StatusFilter; departmentId?: string; search?: string }) {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "members");

    const nextStatus = next.status ?? status;
    const nextDepartmentId = next.departmentId ?? departmentId;
    const nextSearch = next.search ?? search;

    if (nextStatus === "active") {
      params.delete("status");
    } else {
      params.set("status", nextStatus);
    }

    if (nextDepartmentId === "all") {
      params.delete("dept");
    } else {
      params.set("dept", nextDepartmentId);
    }

    const keyword = nextSearch.trim();
    if (keyword) {
      params.set("q", keyword);
    } else {
      params.delete("q");
    }

    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  function changeStatus(next: StatusFilter) {
    setStatus(next);
    syncQuery({ status: next });
  }

  function changeDepartment(next: string) {
    setDepartmentId(next);
    syncQuery({ departmentId: next });
  }

  function changeSearch(next: string) {
    setSearch(next);
    syncQuery({ search: next });
  }

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (status !== "all" && row.status !== status) {
        return false;
      }
      if (departmentId !== "all" && row.departmentId !== departmentId) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const name = row.name?.toLowerCase() ?? "";
      const phone = row.phone ?? "";
      const email = (row.email ?? "").toLowerCase();
      return name.includes(keyword) || phone.includes(keyword) || email.includes(keyword);
    });
  }, [rows, status, departmentId, search]);

  async function handleAdd(formData: FormData): Promise<void> {
    if (busy) {
      return;
    }
    formData.set("accessLevel", "L3");
    setBusy("add");
    try {
      const result = await addMember(formData);
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setAdding(false);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleEdit(formData: FormData): Promise<void> {
    if (!editing || busy) {
      return;
    }
    setBusy("edit");
    try {
      const result = await updateMemberBasics({
        membershipId: editing.membershipId,
        name: String(formData.get("name") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        departmentId: String(formData.get("departmentId") ?? ""),
        employeeNo: String(formData.get("employeeNo") ?? ""),
        hireDate: String(formData.get("hireDate") ?? ""),
        birthday: String(formData.get("birthday") ?? ""),
        position: String(formData.get("position") ?? ""),
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setEditing(null);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveRequest(row: MemberTableRow): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(row.membershipId);
    try {
      const result = await checkMemberPendingApprovals(row.membershipId);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.message });
        return;
      }
      if (result.count > 0) {
        setTransferToUserId("");
        setPendingBlock({ row, count: result.count });
        return;
      }
      setRemovalTarget(row);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(row: MemberTableRow, reassignToUserId?: string): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(row.membershipId);
    try {
      const result = await removeMember(
        row.membershipId,
        reassignToUserId ? { reassignToUserId } : undefined,
      );
      if (result.ok) {
        setNotice({
          kind: "info",
          text: reassignToUserId
            ? "待处理审批单已转交，成员已移出"
            : "已移出，可在「已停用」中恢复",
        });
        setRemovalTarget(null);
        setPendingBlock(null);
        setTransferToUserId("");
        router.refresh();
        return;
      }
      if (result.code === "PENDING_APPROVALS") {
        setRemovalTarget(null);
        setTransferToUserId("");
        setPendingBlock({ row, count: result.pendingCount ?? 0 });
        return;
      }
      setNotice({ kind: "error", text: result.message });
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore(row: MemberTableRow): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(row.membershipId);
    try {
      const result = await restoreMember(row.membershipId);
      setNotice({ kind: result.ok ? "info" : "error", text: result.ok ? "已恢复为在职" : result.message });
      if (result.ok) {
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {notice ? (
        <NoticeBar kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </NoticeBar>
      ) : null}

      <div className="members-toolbar">
        <div className="perm-segmented" role="group" aria-label="员工状态">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`perm-segment${status === option.value ? " is-active" : ""}`}
              onClick={() => changeStatus(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <Select
          className="members-dept-filter"
          value={departmentId}
          aria-label="按部门筛选"
          options={departmentOptions}
          onValueChange={changeDepartment}
        />

        <input
          className="perm-search members-search"
          value={search}
          onChange={(event) => changeSearch(event.target.value)}
          placeholder="搜索姓名、手机号、邮箱"
          aria-label="搜索员工"
        />

        <button
          type="button"
          className="button members-add"
          onClick={() => setAdding(true)}
          disabled={!canManageMembers}
        >
          + 添加员工
        </button>
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <p className="hint">没有匹配的员工。</p>
        ) : (
          <table className="table members-table">
            <thead>
              <tr>
                <th>工号</th>
                <th>姓名</th>
                <th>手机号</th>
                <th>部门</th>
                <th>岗位</th>
                <th>等级</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.membershipId}>
                  <td className="members-employee-no" data-label="工号">
                    <span className="members-cell-value">{row.employeeNo || "—"}</span>
                  </td>
                  <td data-label="姓名">
                    <span className="members-cell-value">
                      {row.name?.trim() || row.phone || "未命名"}
                      {row.email ? <span className="perm-muted"> · {row.email}</span> : null}
                    </span>
                  </td>
                  <td data-label="手机号">
                    <span className="members-cell-value">{row.phone || "—"}</span>
                  </td>
                  <td data-label="部门">
                    <span className="members-cell-value">{row.departmentName || "—"}</span>
                  </td>
                  <td data-label="岗位">
                    <span className="members-cell-value">{row.position || row.title || "—"}</span>
                  </td>
                  <td data-label="等级">
                    <span className="members-cell-value">
                      <span className={`badge level-${(row.level ?? "L3").toLowerCase()}`}>
                        {row.level === "L1" ? "老板" : row.level || "—"}
                      </span>
                    </span>
                  </td>
                  <td data-label="状态">
                    <span className="members-cell-value">
                      {row.status === "active" ? (
                        <span className="perm-tag perm-tag-allow">在职</span>
                      ) : (
                        <span className="perm-tag perm-tag-deny">
                          已停用{row.removedAt ? ` · ${row.removedAt}` : ""}
                        </span>
                      )}
                    </span>
                  </td>
                  <td data-label="操作">
                    <div className="member-row-actions">
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => setDetailTarget(row)}
                      >
                        详情
                      </button>
                      {row.status === "active" ? (
                        <>
                          <button
                            type="button"
                            className="button button-ghost"
                            onClick={() => setEditing(row)}
                            disabled={!canManageMembers || busy !== null}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="button button-ghost"
                            onClick={() => void handleRemoveRequest(row)}
                            disabled={!canManageMembers || busy !== null}
                          >
                            移出
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => void handleRestore(row)}
                          disabled={!canManageMembers || busy !== null}
                        >
                          恢复账号
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={removalTarget !== null}
        title="确认移出员工？"
        danger
        confirmLabel="确认移出"
        pending={busy !== null}
        description={
          removalTarget
            ? `移出后，「${removalTarget.name?.trim() || removalTarget.phone || "该员工"}」将无法再登录 Jxf-AI 工作台。其历史审计日志和资产将被保留，可在「已停用」中恢复。`
            : ""
        }
        onConfirm={() => {
          if (removalTarget) {
            void handleRemove(removalTarget);
          }
        }}
        onCancel={() => setRemovalTarget(null)}
      />

      <ConfirmDialog
        open={pendingBlock !== null}
        title="该员工有待处理审批单"
        danger
        confirmLabel="转交并移出"
        pending={busy !== null}
        confirmDisabled={!transferToUserId}
        description={
          pendingBlock
            ? `「${pendingBlock.row.name?.trim() || pendingBlock.row.phone || "该员工"}」在审批中心还有 ${pendingBlock.count} 条待处理审批单。停用前请指定转交人，避免审批流悬挂。`
            : ""
        }
        onConfirm={() => {
          if (pendingBlock && transferToUserId) {
            void handleRemove(pendingBlock.row, transferToUserId);
          }
        }}
        onCancel={() => {
          setPendingBlock(null);
          setTransferToUserId("");
        }}
      >
        <label className="confirm-field">
          转交给
          <Select
            className="transfer-select"
            value={transferToUserId}
            aria-label="选择转交人"
            options={[{ value: "", label: "请选择转交人" }, ...transferOptions]}
            onValueChange={setTransferToUserId}
          />
        </label>
      </ConfirmDialog>

      {detailTarget ? (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-label="员工资料">
          <button
            type="button"
            className="confirm-backdrop"
            aria-label="关闭"
            onClick={() => setDetailTarget(null)}
          />
          <div className="confirm-card hr-detail-card">
            <h3 className="confirm-title">员工资料</h3>
            <dl className="meta-grid hr-detail-grid">
              <div>
                <div className="meta-label">工号</div>
                <div className="meta-value">{detailTarget.employeeNo || "—"}</div>
              </div>
              <div>
                <div className="meta-label">姓名</div>
                <div className="meta-value">{detailTarget.name?.trim() || "未命名"}</div>
              </div>
              <div>
                <div className="meta-label">部门</div>
                <div className="meta-value">{detailTarget.departmentName || "—"}</div>
              </div>
              <div>
                <div className="meta-label">岗位</div>
                <div className="meta-value">{detailTarget.position || detailTarget.title || "—"}</div>
              </div>
              <div>
                <div className="meta-label">等级</div>
                <div className="meta-value">
                  {detailTarget.level === "L1" ? "L1 老板" : detailTarget.level}
                </div>
              </div>
              <div>
                <div className="meta-label">手机号</div>
                <div className="meta-value">{detailTarget.phone || "—"}</div>
              </div>
              <div>
                <div className="meta-label">邮箱</div>
                <div className="meta-value">{detailTarget.email || "—"}</div>
              </div>
              <div>
                <div className="meta-label">入职日期</div>
                <div className="meta-value">{formatDate(detailTarget.hireDate)}</div>
              </div>
              <div>
                <div className="meta-label">生日</div>
                <div className="meta-value">{formatDate(detailTarget.birthday)}</div>
              </div>
              <div>
                <div className="meta-label">司龄</div>
                <div className="meta-value">{formatTenure(detailTarget.hireDate)}</div>
              </div>
              <div>
                <div className="meta-label">状态</div>
                <div className="meta-value">
                  {detailTarget.status === "active"
                    ? "在职"
                    : `已停用${detailTarget.removedAt ? ` · ${detailTarget.removedAt}` : ""}`}
                </div>
              </div>
            </dl>
            <div className="confirm-actions">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setDetailTarget(null)}
              >
                关闭
              </button>
              {detailTarget.status === "active" ? (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setEditing(detailTarget);
                    setDetailTarget(null);
                  }}
                  disabled={!canManageMembers}
                >
                  编辑资料
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {adding ? (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-label="添加员工">
          <button
            type="button"
            className="confirm-backdrop"
            aria-label="取消"
            onClick={() => {
              if (!busy) {
                setAdding(false);
              }
            }}
          />
          <div className="confirm-card handover-card">
            <h3 className="confirm-title">添加员工</h3>
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void handleAdd(new FormData(event.currentTarget));
              }}
            >
              <label>
                姓名
                <input name="name" required maxLength={40} placeholder="真实姓名" />
              </label>
              <label>
                手机号
                <input name="phone" required inputMode="tel" maxLength={20} placeholder="13800000000" />
              </label>
              <label>
                邮箱（选填）
                <input name="email" type="email" maxLength={254} placeholder="user@example.com" />
              </label>
              <label>
                所属部门
                <Select
                  className="form-select-block"
                  name="departmentId"
                  required
                  defaultValue={defaultDepartmentId}
                  options={departments.map((department) => ({
                    value: department.id,
                    label: department.name,
                  }))}
                />
              </label>
              <label>
                岗位/职位（选填）
                <input name="position" maxLength={40} placeholder="例如：交付经理、HRBP" />
              </label>
              <label>
                工号（选填）
                <input name="employeeNo" maxLength={32} placeholder="留空自动生成，如 JXF-0001" />
              </label>
              <label>
                入职日期（选填）
                <input name="hireDate" type="date" />
              </label>
              <label>
                生日（选填）
                <input name="birthday" type="date" />
              </label>
              <div className="confirm-actions">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setAdding(false)}
                  disabled={busy !== null}
                >
                  取消
                </button>
                <button type="submit" className="button" disabled={busy !== null}>
                  {busy === "add" ? "添加中…" : "添加员工"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="confirm-layer" role="dialog" aria-modal="true" aria-label="编辑员工">
          <button
            type="button"
            className="confirm-backdrop"
            aria-label="取消"
            onClick={() => {
              if (!busy) {
                setEditing(null);
              }
            }}
          />
          <div className="confirm-card handover-card">
            <h3 className="confirm-title">编辑员工资料</h3>
            <p className="confirm-desc">
              仅修改基础行政资料；权限由「权限管理 → 成员授权」单独配置。
            </p>
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void handleEdit(new FormData(event.currentTarget));
              }}
            >
              <label>
                姓名
                <input name="name" required maxLength={40} defaultValue={editing.name} />
              </label>
              <label>
                手机号
                <input
                  name="phone"
                  required
                  inputMode="tel"
                  maxLength={20}
                  defaultValue={editing.phone}
                />
              </label>
              <label>
                所属部门
                <Select
                  className="form-select-block"
                  name="departmentId"
                  required
                  defaultValue={editing.departmentId}
                  options={departments.map((department) => ({
                    value: department.id,
                    label: department.name,
                  }))}
                />
              </label>
              <label>
                岗位/职位（选填）
                <input
                  name="position"
                  maxLength={40}
                  defaultValue={editing.position || editing.title}
                  placeholder="例如：交付经理、HRBP"
                />
              </label>
              <label>
                工号（选填）
                <input
                  name="employeeNo"
                  maxLength={32}
                  defaultValue={editing.employeeNo}
                  placeholder="留空自动生成，如 JXF-0001"
                />
              </label>
              <label>
                入职日期（选填）
                <input name="hireDate" type="date" defaultValue={editing.hireDate ?? ""} />
              </label>
              <label>
                生日（选填）
                <input name="birthday" type="date" defaultValue={editing.birthday ?? ""} />
              </label>
              <div className="confirm-actions">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setEditing(null)}
                  disabled={busy !== null}
                >
                  取消
                </button>
                <button type="submit" className="button" disabled={busy !== null}>
                  {busy === "edit" ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
