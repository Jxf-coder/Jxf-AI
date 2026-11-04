"use client";

import { useRouter } from "next/navigation";

import { Select } from "@/components/ui/select";

export type AuditLogType = "all" | "permission" | "system";
export type AuditOrder = "desc" | "asc";

const TYPE_OPTIONS: Array<{ value: AuditLogType; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "permission", label: "权限变更" },
  { value: "system", label: "系统操作" },
];

const ORDER_OPTIONS: Array<{ value: AuditOrder; label: string }> = [
  { value: "desc", label: "最新优先（倒序）" },
  { value: "asc", label: "最早优先（正序）" },
];

/** 审计日志筛选：日志类型 + 毫秒级时间戳排序（倒序 / 正序） */
export function AuditTypeFilter({
  type,
  order,
}: {
  type: AuditLogType;
  order: AuditOrder;
}) {
  const router = useRouter();

  function push(nextType: AuditLogType, nextOrder: AuditOrder) {
    const params = new URLSearchParams({
      tab: "audit",
      type: nextType,
      order: nextOrder,
    });
    router.push(`/admin/permissions?${params.toString()}`);
  }

  return (
    <div className="audit-filter">
      <span className="perm-muted">日志类型</span>
      <Select
        className="audit-type-select"
        value={type}
        aria-label="日志类型"
        options={TYPE_OPTIONS}
        onValueChange={(next) => push(next as AuditLogType, order)}
      />
      <span className="perm-muted">排序</span>
      <Select
        className="audit-type-select"
        value={order}
        aria-label="日志排序"
        options={ORDER_OPTIONS}
        onValueChange={(next) => push(type, next as AuditOrder)}
      />
    </div>
  );
}
