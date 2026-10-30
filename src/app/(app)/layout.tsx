import Link from "next/link";

import { signOutAction } from "@/lib/auth/actions";
import { requireSession } from "@/lib/auth/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link href="/ai-employees" className="brand">
          Jxf-AI 工作台
        </Link>
        <nav className="topnav">
          <Link href="/ai-employees">AI 员工</Link>
          <Link href="/me/permissions">我的权限</Link>
          <Link href="/health">健康</Link>
        </nav>
        <div className="userbox">
          <span className="mono">{user.email}</span>
          <form action={signOutAction}>
            <button type="submit" className="link-danger">
              退出
            </button>
          </form>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
