import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

const REASON_MESSAGES: Record<string, string> = {
  pending_handover: "账号正在办理离职交接，请联系管理员。",
  disabled: "账号已停用，请联系管理员。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawReason = Array.isArray(params.reason) ? params.reason[0] : params.reason;
  const notice = rawReason ? REASON_MESSAGES[rawReason] : null;

  return (
    <main className="login-page">
      <div className="login-card">
        <h1 className="login-title">Jxf-AI 工作台</h1>
        <p className="page-subtitle">使用组织账号登录</p>

        {notice ? <div className="alert-error">{notice}</div> : null}

        <LoginForm />
      </div>
    </main>
  );
}
