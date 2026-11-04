import { redirect } from "next/navigation";

/** 组织架构已迁移到 /admin/organization，保留旧地址做兼容跳转 */
export default function OrgPositionsPage() {
  redirect("/admin/organization");
}
