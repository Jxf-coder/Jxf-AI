"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import {
  badge,
  btnBlue,
  btnGhost,
  card,
  cardDesc,
  cardHead,
  cardTitle,
  emptyState,
  fieldLabel,
  formGrid,
  input,
  meta,
} from "@/components/knowledge/tokens";

import { deleteScopeGrant, saveScopeGrant, shareResource, unshareResource } from "./scope-actions";

export interface ScopeGrantRow {
  id: string;
  granteeUserId: string;
  granteeName: string;
  domain: string;
  scopeType: string;
  scopeRefs: string[];
  refNames: string[];
  capability: string;
  validUntil: string | null;
  reason: string;
}

export interface ResourceShareRow {
  id: string;
  resourceId: string;
  accountLabel: string;
  granteeUserId: string;
  granteeName: string;
  capability: string;
  validUntil: string | null;
  reason: string;
}

export interface ScopeMember {
  id: string;
  name: string;
  departmentName: string;
}

const DOMAIN_LABEL: Record<string, string> = {
  crm: "客户",
  trade: "交易",
  mail: "邮件",
  reminder: "提醒",
};

const SCOPE_TYPE_LABEL: Record<string, string> = {
  USERS: "指定成员",
  DEPARTMENTS: "指定部门",
  ALL: "全部",
};

const CAPABILITY_LABEL: Record<string, string> = {
  read: "可读",
  write: "可写",
  manage: "可管理",
};

function formatDay(value: string | null): string {
  if (!value) {
    return "长期有效";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

type ScopeDialog = {
  granteeUserId: string;
  domain: string;
  scopeType: string;
  capability: string;
  validUntil: string;
  reason: string;
  refs: string[];
} | null;

type ShareDialog = {
  resourceId: string;
  granteeUserId: string;
  capability: string;
  validUntil: string;
  reason: string;
} | null;

type RevokeTarget = { kind: "scope"; row: ScopeGrantRow } | { kind: "share"; row: ResourceShareRow } | null;

/** 例外授权与资源共享：L1 可创建、可撤销；有效期到期即失效 */
export function ScopeGrantsPanel({
  scopes,
  shares,
  members,
  departments,
  accounts,
}: {
  scopes: ScopeGrantRow[];
  shares: ResourceShareRow[];
  members: ScopeMember[];
  departments: { id: string; name: string }[];
  accounts: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const [scopeDialog, setScopeDialog] = useState<ScopeDialog>(null);
  const [shareDialog, setShareDialog] = useState<ShareDialog>(null);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget>(null);

  function openScope() {
    setScopeDialog({
      granteeUserId: members[0]?.id ?? "",
      domain: "crm",
      scopeType: "USERS",
      capability: "read",
      validUntil: "",
      reason: "",
      refs: [],
    });
  }

  function openShare() {
    setShareDialog({
      resourceId: accounts[0]?.id ?? "",
      granteeUserId: members[0]?.id ?? "",
      capability: "read",
      validUntil: "",
      reason: "",
    });
  }

  function toggleRef(id: string) {
    setScopeDialog((current) => {
      if (!current) {
        return current;
      }
      const refs = current.refs.includes(id)
        ? current.refs.filter((item) => item !== id)
        : [...current.refs, id];
      return { ...current, refs };
    });
  }

  function submitScope() {
    if (!scopeDialog) {
      return;
    }
    startTransition(async () => {
      const result = await saveScopeGrant({
        granteeUserId: scopeDialog.granteeUserId,
        domain: scopeDialog.domain,
        scopeType: scopeDialog.scopeType,
        scopeRefs: scopeDialog.scopeType === "ALL" ? [] : scopeDialog.refs,
        capability: scopeDialog.capability,
        validUntil: scopeDialog.validUntil,
        reason: scopeDialog.reason,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setScopeDialog(null);
        router.refresh();
      }
    });
  }

  function submitShare() {
    if (!shareDialog) {
      return;
    }
    startTransition(async () => {
      const result = await shareResource({
        resourceType: "crm_account",
        resourceId: shareDialog.resourceId,
        granteeUserId: shareDialog.granteeUserId,
        capability: shareDialog.capability,
        validUntil: shareDialog.validUntil,
        reason: shareDialog.reason,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setShareDialog(null);
        router.refresh();
      }
    });
  }

  function confirmRevoke() {
    if (!revokeTarget) {
      return;
    }
    const target = revokeTarget;
    startTransition(async () => {
      const result =
        target.kind === "scope"
          ? await deleteScopeGrant({ id: target.row.id })
          : await unshareResource({ id: target.row.id });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      setRevokeTarget(null);
      if (result.ok) {
        router.refresh();
      }
    });
  }

  const refCandidates =
    scopeDialog?.scopeType === "DEPARTMENTS"
      ? departments.map((item) => ({ id: item.id, label: item.name }))
      : members.map((item) => ({
          id: item.id,
          label: `${item.name}（${item.departmentName}）`,
        }));

  return (
    <div className="space-y-4">
      {notice ? (
        <p
          className={`rounded-2xl px-4 py-3 text-[13px] ${
            notice.kind === "error" ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"
          }`}
          role="status"
        >
          {notice.text}
        </p>
      ) : null}

      <div className={`${card} mb-0`}>
        <div className={cardHead}>
          <div>
            <h2 className={cardTitle}>数据范围例外</h2>
            <p className={`${cardDesc} mb-0`}>
              临时把某个成员的数据范围扩到指定成员 / 部门，到期自动失效；只影响读写的行级范围，不影响权限点。
            </p>
          </div>
          <button type="button" className={btnBlue} onClick={openScope} disabled={pending}>
            新增例外
          </button>
        </div>

        {scopes.length === 0 ? (
          <p className={emptyState}>还没有数据范围例外。</p>
        ) : (
          <ul className="divide-y divide-black/[0.04]">
            {scopes.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="w-24 shrink-0 truncate text-[13px] font-medium text-zinc-900">
                  {row.granteeName}
                </span>
                <span className={badge("blue")}>{DOMAIN_LABEL[row.domain] ?? row.domain}</span>
                <span className={badge("muted")}>{SCOPE_TYPE_LABEL[row.scopeType] ?? row.scopeType}</span>
                <span className={badge("muted")}>{CAPABILITY_LABEL[row.capability] ?? row.capability}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">
                  {row.scopeType === "ALL" ? "全租户" : row.refNames.join("、") || "—"}
                  {row.reason ? ` · ${row.reason}` : ""}
                </span>
                <span className={meta}>{formatDay(row.validUntil)}</span>
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => setRevokeTarget({ kind: "scope", row })}
                  disabled={pending}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`${card} mb-0`}>
        <div className={cardHead}>
          <div>
            <h2 className={cardTitle}>资源共享</h2>
            <p className={`${cardDesc} mb-0`}>
              单条客户的例外授权：被共享人无需拥有该部门范围即可读 / 写该客户；「可管理」还能继续转授权。
            </p>
          </div>
          <button type="button" className={btnBlue} onClick={openShare} disabled={pending}>
            新增共享
          </button>
        </div>

        {shares.length === 0 ? (
          <p className={emptyState}>还没有资源共享记录。</p>
        ) : (
          <ul className="divide-y divide-black/[0.04]">
            {shares.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-900">
                  {row.accountLabel}
                </span>
                <span className="shrink-0 text-[12px] text-zinc-600">{row.granteeName}</span>
                <span className={badge("muted")}>{CAPABILITY_LABEL[row.capability] ?? row.capability}</span>
                {row.reason ? (
                  <span className="max-w-[220px] shrink-0 truncate text-[12px] text-zinc-500">
                    {row.reason}
                  </span>
                ) : null}
                <span className={meta}>{formatDay(row.validUntil)}</span>
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => setRevokeTarget({ kind: "share", row })}
                  disabled={pending}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={scopeDialog !== null}
        title="新增数据范围例外"
        description="到期即失效；变更会写入审计日志"
        pending={pending}
        onClose={() => {
          if (!pending) {
            setScopeDialog(null);
          }
        }}
        footer={
          <>
            <button type="button" className={btnGhost} onClick={() => setScopeDialog(null)} disabled={pending}>
              取消
            </button>
            <button
              type="button"
              className={btnBlue}
              onClick={submitScope}
              disabled={
                pending ||
                !scopeDialog?.granteeUserId ||
                (scopeDialog.scopeType !== "ALL" && scopeDialog.refs.length === 0)
              }
            >
              {pending ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        {scopeDialog ? (
          <div className={formGrid}>
            <label>
              <span className={fieldLabel}>被授权成员 *</span>
              <Select
                className="w-full"
                value={scopeDialog.granteeUserId}
                onValueChange={(value) =>
                  setScopeDialog((current) => current && { ...current, granteeUserId: value })
                }
                options={[
                  { value: "", label: "请选择成员" },
                  ...members.map((member) => ({
                    value: member.id,
                    label: `${member.name}（${member.departmentName}）`,
                  })),
                ]}
              />
            </label>
            <label>
              <span className={fieldLabel}>授权域</span>
              <Select
                className="w-full"
                value={scopeDialog.domain}
                onValueChange={(value) =>
                  setScopeDialog((current) => current && { ...current, domain: value })
                }
                options={[
                  { value: "crm", label: "客户" },
                  { value: "trade", label: "交易" },
                  { value: "mail", label: "邮件" },
                  { value: "reminder", label: "提醒" },
                ]}
              />
            </label>
            <label>
              <span className={fieldLabel}>范围</span>
              <Select
                className="w-full"
                value={scopeDialog.scopeType}
                onValueChange={(value) =>
                  setScopeDialog((current) => current && { ...current, scopeType: value, refs: [] })
                }
                options={[
                  { value: "USERS", label: "指定成员" },
                  { value: "DEPARTMENTS", label: "指定部门" },
                  { value: "ALL", label: "全部（全租户）" },
                ]}
              />
            </label>
            <label>
              <span className={fieldLabel}>能力</span>
              <Select
                className="w-full"
                value={scopeDialog.capability}
                onValueChange={(value) =>
                  setScopeDialog((current) => current && { ...current, capability: value })
                }
                options={[
                  { value: "read", label: "可读" },
                  { value: "write", label: "可写" },
                  { value: "manage", label: "可管理（含转授权）" },
                ]}
              />
            </label>
            {scopeDialog.scopeType !== "ALL" ? (
              <div className="sm:col-span-2">
                <span className={fieldLabel}>
                  {scopeDialog.scopeType === "DEPARTMENTS" ? "授权部门 *" : "授权成员 *"}
                </span>
                <div className="max-h-44 overflow-auto rounded-2xl bg-apple-canvas p-2">
                  {refCandidates.length === 0 ? (
                    <p className={`${meta} px-2 py-1`}>没有可选对象。</p>
                  ) : (
                    refCandidates.map((item) => (
                      <label
                        key={item.id}
                        className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-[12px] text-zinc-700 hover:bg-white"
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-zinc-300"
                          checked={scopeDialog.refs.includes(item.id)}
                          onChange={() => toggleRef(item.id)}
                        />
                        <span className="truncate">{item.label}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : null}
            <label>
              <span className={fieldLabel}>失效日期</span>
              <input
                className={input}
                type="date"
                value={scopeDialog.validUntil}
                onChange={(event) =>
                  setScopeDialog((current) => current && { ...current, validUntil: event.target.value })
                }
              />
            </label>
            <label>
              <span className={fieldLabel}>原因</span>
              <input
                className={input}
                value={scopeDialog.reason}
                maxLength={200}
                onChange={(event) =>
                  setScopeDialog((current) => current && { ...current, reason: event.target.value })
                }
                placeholder="如：临时协作，月底前有效"
              />
            </label>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={shareDialog !== null}
        title="新增资源共享"
        description="当前版本支持共享客户；到期即失效"
        pending={pending}
        onClose={() => {
          if (!pending) {
            setShareDialog(null);
          }
        }}
        footer={
          <>
            <button type="button" className={btnGhost} onClick={() => setShareDialog(null)} disabled={pending}>
              取消
            </button>
            <button
              type="button"
              className={btnBlue}
              onClick={submitShare}
              disabled={pending || !shareDialog?.resourceId || !shareDialog?.granteeUserId}
            >
              {pending ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        {shareDialog ? (
          <div className={formGrid}>
            <label className="sm:col-span-2">
              <span className={fieldLabel}>客户 *</span>
              <Select
                className="w-full"
                value={shareDialog.resourceId}
                onValueChange={(value) =>
                  setShareDialog((current) => current && { ...current, resourceId: value })
                }
                options={[
                  { value: "", label: "请选择客户" },
                  ...accounts.map((account) => ({
                    value: account.id,
                    label: `${account.name}（${account.code}）`,
                  })),
                ]}
              />
            </label>
            <label>
              <span className={fieldLabel}>共享给 *</span>
              <Select
                className="w-full"
                value={shareDialog.granteeUserId}
                onValueChange={(value) =>
                  setShareDialog((current) => current && { ...current, granteeUserId: value })
                }
                options={[
                  { value: "", label: "请选择成员" },
                  ...members.map((member) => ({
                    value: member.id,
                    label: `${member.name}（${member.departmentName}）`,
                  })),
                ]}
              />
            </label>
            <label>
              <span className={fieldLabel}>能力</span>
              <Select
                className="w-full"
                value={shareDialog.capability}
                onValueChange={(value) =>
                  setShareDialog((current) => current && { ...current, capability: value })
                }
                options={[
                  { value: "read", label: "可读" },
                  { value: "write", label: "可写" },
                  { value: "manage", label: "可管理（含转授权）" },
                ]}
              />
            </label>
            <label>
              <span className={fieldLabel}>失效日期</span>
              <input
                className={input}
                type="date"
                value={shareDialog.validUntil}
                onChange={(event) =>
                  setShareDialog((current) => current && { ...current, validUntil: event.target.value })
                }
              />
            </label>
            <label>
              <span className={fieldLabel}>原因</span>
              <input
                className={input}
                value={shareDialog.reason}
                maxLength={200}
                onChange={(event) =>
                  setShareDialog((current) => current && { ...current, reason: event.target.value })
                }
                placeholder="如：协同跟进同一客户"
              />
            </label>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={revokeTarget?.kind === "share" ? "撤销资源共享？" : "撤销数据范围例外？"}
        description={
          revokeTarget?.kind === "share"
            ? `「${revokeTarget.row.granteeName}」将立即失去对「${revokeTarget.row.accountLabel}」的例外权限。`
            : revokeTarget?.kind === "scope"
              ? `「${revokeTarget.row.granteeName}」的这条${DOMAIN_LABEL[revokeTarget.row.domain] ?? ""}例外将立即失效。`
              : undefined
        }
        confirmLabel="撤销"
        danger
        pending={pending}
        onConfirm={confirmRevoke}
        onCancel={() => {
          if (!pending) {
            setRevokeTarget(null);
          }
        }}
      />
    </div>
  );
}
