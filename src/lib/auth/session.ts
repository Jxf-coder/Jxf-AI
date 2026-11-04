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
  const { rows } = await getPool().query<{ status: string }>(
    "select status from users where id = $1",
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
