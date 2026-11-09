import { cache } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { getPool } from "@/lib/db/pool";

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
}

/** 同一请求内复用账号状态查询，避免 layout / page / action 重复打库。 */
const loadAccountStatus = cache(async (userId: string): Promise<string> => {
  // 此时还没建立用户上下文，users 的 RLS 会把直查清空，只能走 SECURITY DEFINER 函数
  const { rows } = await getPool().query<{ status: string | null }>(
    "select app.user_status($1) as status",
    [userId],
  );
  return rows[0]?.status ?? "disabled";
});

/** 服务端组件 / Server Action 的统一登录校验；未登录或账号冻结直接跳转登录页 */
export async function requireSession(): Promise<SessionUser> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/login");
  }

  const status = await loadAccountStatus(userId);
  if (status !== "active") {
    redirect(`/login?reason=${encodeURIComponent(status)}`);
  }

  return {
    userId,
    email: session?.user?.email ?? "",
    name: session?.user?.name ?? "",
  };
}
