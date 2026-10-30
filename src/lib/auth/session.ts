import { redirect } from "next/navigation";

import { auth } from "@/auth";

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
}

/** 服务端组件 / Server Action 的统一登录校验；未登录直接跳转登录页 */
export async function requireSession(): Promise<SessionUser> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/login");
  }

  return {
    userId,
    email: session?.user?.email ?? "",
    name: session?.user?.name ?? "",
  };
}
