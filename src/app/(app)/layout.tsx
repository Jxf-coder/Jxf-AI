import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { requireSession } from "@/lib/auth/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-body">
        <Topbar email={user.email} name={user.name} />
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
