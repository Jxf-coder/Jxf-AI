"use client";

import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { NoticeBar } from "@/components/ui/notice-bar";

import { approveRemoval, cancelRemoval, rejectRemoval } from "./actions";

export interface PendingApproval {
  id: string;
  membershipId: string;
  memberName: string;
  departmentName: string;
  title: string;
  level: "L1" | "L2" | "L3";
  requesterName: string;
  submittedAt: string;
  assetCount: number;
  items: Array<{ assetType: string; assetId: string; toName: string }>;
}

export interface DecidedApproval {
  id: string;
  memberName: string;
  departmentName: string;
  status: string;
  decidedAt: string | null;
  assetCount: number;
}

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  approved: { text: "已通过", className: "perm-tag perm-tag-allow" },
  rejected: { text: "已驳回", className: "perm-tag perm-tag-deny" },
  cancelled: { text: "已撤回", className: "perm-tag perm-tag-template" },
};

export function ApprovalsClient({
  pending,
  decided,
}: {
  pending: PendingApproval[];
  decided: DecidedApproval[];
}) {
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    item: PendingApproval;
    action: "approve" | "reject";
  } | null>(null);
  const [reason, setReason] = useState("");

  async function execute(
    id: string,
    action: "approve" | "reject" | "cancel",
    rejectReason: string,
  ): Promise<void> {
    if (busy) {
      return;
    }

    setBusy(id);
    try {
      const result =
        action === "approve"
          ? await approveRemoval(id)
          : action === "reject"
            ? await rejectRemoval(id, rejectReason)
            : await cancelRemoval(id);
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
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

      <section className="settings-group">
        <h2 className="settings-group-title">待审批（{pending.length}）</h2>
        {pending.length === 0 ? (
          <p className="hint">暂无待审批的交接申请。</p>
        ) : (
          pending.map((item) => (
            <div className="settings-card" key={item.id}>
              <div className="settings-row">
                <span className="settings-label">成员</span>
                <div className="settings-value">
                  {item.memberName || "未命名成员"}
                  <span className={`badge level-${(item.level ?? "L3").toLowerCase()}`}>
                    {item.level === "L1" ? "老板" : item.level || "—"}
                  </span>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">部门 / 岗位</span>
                <div className="settings-value">
                  {item.departmentName || "未知部门"} · {item.title || "—"}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">发起人</span>
                <div className="settings-value">
                  {item.requesterName || "未知"} · {item.submittedAt || "—"}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">待交接资产</span>
                <div className="settings-value">
                  {item.assetCount ?? 0} 项
                  {(item.items?.length ?? 0) > 0 ? (
                    <ul className="approval-items">
                      {item.items?.map((asset) => (
                        <li key={`${asset.assetType}:${asset.assetId}`}>
                          <span className="perm-tag">{asset.assetType || "资产"}</span>
                          <code className="perm-key">{asset.assetId}</code>
                          <span className="perm-muted">→ {asset.toName || "未指定"}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">操作</span>
                <div className="settings-value approval-actions">
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => {
                      setReason("");
                      setDialog({ item, action: "reject" });
                    }}
                    disabled={busy !== null}
                  >
                    驳回
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => void execute(item.id, "cancel", "")}
                    disabled={busy !== null}
                  >
                    撤回
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setReason("");
                      setDialog({ item, action: "approve" });
                    }}
                    disabled={busy !== null}
                  >
                    {busy === item.id ? "处理中…" : "通过并停用"}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="settings-group">
        <h2 className="settings-group-title">已处理</h2>
        {decided.length === 0 ? (
          <p className="hint">暂无历史记录。</p>
        ) : (
          <div className="settings-card">
            {decided.map((item) => {
              const status = STATUS_LABEL[item.status] ?? {
                text: item.status || "未知状态",
                className: "perm-tag",
              };
              return (
                <div className="settings-row" key={item.id}>
                  <span className="settings-label">
                    {item.memberName || "未命名成员"}
                    <span className="perm-muted"> · {item.departmentName || "未知部门"}</span>
                  </span>
                  <div className="settings-value approval-history-meta">
                    <span className={status.className}>{status.text}</span>
                    <span className="perm-muted">
                      {item.assetCount ?? 0} 项资产
                      {item.decidedAt ? ` · ${item.decidedAt}` : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.action === "approve" ? "确认通过并停用？" : "驳回交接申请"}
        description={
          dialog?.action === "approve"
            ? "通过后资产完成转移，该成员将立即停用。"
            : "驳回后任用与账号将恢复为在职；可填写驳回原因（选填）。"
        }
        confirmLabel={dialog?.action === "approve" ? "通过并停用" : "确认驳回"}
        danger={dialog?.action === "reject"}
        pending={busy !== null}
        onConfirm={() => {
          if (!dialog) {
            return;
          }
          const current = dialog;
          setDialog(null);
          void execute(current.item.id, current.action, reason);
        }}
        onCancel={() => setDialog(null)}
      >
        {dialog?.action === "reject" ? (
          <label className="confirm-field">
            驳回原因
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
              placeholder="选填，最多 200 字"
            />
          </label>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
