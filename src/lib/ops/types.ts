/**
 * 运维任务共享类型（客户端可安全导入，不含 Node / 数据库依赖）。
 */

export type OpsTaskKind = "backup" | "restore_verify";

export type OpsTaskStatus = "queued" | "running" | "done" | "failed";

export interface OpsTaskView {
  id: string;
  kind: OpsTaskKind;
  status: OpsTaskStatus;
  cold: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const OPS_TASK_KIND_LABEL: Record<OpsTaskKind, string> = {
  backup: "备份",
  restore_verify: "恢复演练",
};
