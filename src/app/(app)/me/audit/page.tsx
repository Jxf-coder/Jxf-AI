import { redirect } from "next/navigation";

/** 审计日志已并入 /admin/permissions?tab=audit，保留旧地址做兼容跳转 */
export default function AuditPage() {
  redirect("/admin/permissions?tab=audit");
}
