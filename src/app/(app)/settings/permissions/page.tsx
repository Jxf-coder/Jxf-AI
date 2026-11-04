import { redirect } from "next/navigation";

/** 角色管理已并入 /admin/permissions?tab=roles，保留旧地址做兼容跳转 */
export default function PermissionSettingsPage() {
  redirect("/admin/permissions?tab=roles");
}
