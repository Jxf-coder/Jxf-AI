import { redirect } from "next/navigation";

/** 权限管理已迁移到 /admin/permissions，保留旧地址做兼容跳转 */
export default function MyPermissionsPage() {
  redirect("/admin/permissions");
}
