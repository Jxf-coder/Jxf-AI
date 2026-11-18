"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { NoticeBar } from "@/components/ui/notice-bar";

import { decideClaimRequest } from "@/app/(app)/crm/accounts/actions";

export interface ClaimApprovalItem {
  id: string;
  accountId: string;
  accountLabel: string;
  departmentName: string;
  requesterName: string;
  requesterLevel: string;
  submittedAt: string;
}

/** 审批中心里的客户领用申请：与 CRM 公共池里的「审批 N」同源，处理一次即全局消失 */
export function ClaimApprovals({ requests }: { requests: ClaimApprovalItem[] }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ item: ClaimApprovalItem; approve: boolean } | null>(null);
  const [note, setNote] = useState("");

  async function decide(item: ClaimApprovalItem, approve: boolean, decisionNote: string) {
    if (busyId) {
      return;
    }
    setBusyId(item.id);
    try {
      const result = await decideClaimRequest({
        requestId: item.id,
        approve,
        note: decisionNote,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        router.refresh();
      }
    } finally {
      setBusyId(null);
    }
  }

  const dialogDescription = dialog
    ? dialog.approve
      ? `通过后「${dialog.item.accountLabel}」将进入 ${dialog.item.requesterName} 的私海，其他待审批申请自动取消。`
      : `驳回后「${dialog.item.accountLabel}」仍留在公共池，申请人可以稍后重新提交。`
    : "";

  // 处理完最后一条后列表会被刷新清空，此时仍要保留成功提示
  if (requests.length === 0 && !notice) {
    return null;
  }

  return (
    <div>
      {notice ? (
        <NoticeBar kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </NoticeBar>
      ) : null}

      {requests.length > 0 ? (
        <section className="settings-group">
          <h2 className="settings-group-title">客户领用申请（{requests.length}）</h2>
          {requests.map((item) => (
          <div className="settings-card" key={item.id}>
            <div className="settings-row">
              <span className="settings-label">客户</span>
              <div className="settings-value">
                <Link className="link-action" href={`/crm/accounts/${item.accountId}`}>
                  {item.accountLabel}
                </Link>
                <span className="perm-muted"> · {item.departmentName}</span>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">申请人</span>
              <div className="settings-value">
                {item.requesterName}
                <span className={`badge level-${item.requesterLevel.toLowerCase()}`}>
                  {item.requesterLevel === "L1" ? "老板" : item.requesterLevel}
                </span>
                <span className="perm-muted"> · {item.submittedAt}</span>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">操作</span>
              <div className="settings-value approval-actions">
                <Link className="button button-ghost" href="/crm/accounts?view=pool">
                  去公共池处理
                </Link>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => {
                    setNote("");
                    setDialog({ item, approve: false });
                  }}
                  disabled={busyId !== null}
                >
                  驳回
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setNote("");
                    setDialog({ item, approve: true });
                  }}
                  disabled={busyId !== null}
                >
                  {busyId === item.id ? "处理中…" : "批准领用"}
                </button>
              </div>
            </div>
          </div>
          ))}
        </section>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.approve ? "通过领用申请？" : "驳回领用申请"}
        description={dialogDescription}
        confirmLabel={dialog?.approve ? "确认通过" : "确认驳回"}
        danger={dialog ? !dialog.approve : false}
        pending={busyId !== null}
        onConfirm={() => {
          if (!dialog) {
            return;
          }
          const current = dialog;
          setDialog(null);
          void decide(current.item, current.approve, note);
        }}
        onCancel={() => setDialog(null)}
      >
        {dialog && !dialog.approve ? (
          <label className="confirm-field">
            驳回原因
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={200}
              placeholder="选填，最多 200 字"
            />
          </label>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
