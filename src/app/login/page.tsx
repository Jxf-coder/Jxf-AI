"use client";

import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirect: false,
    });

    setPending(false);

    if (!result || result.error) {
      setError("邮箱或密码错误，或该账号没有有效任用");
      return;
    }

    window.location.href = "/ai-employees";
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <h1 className="login-title">Jxf-AI 工作台</h1>
        <p className="page-subtitle">使用组织账号登录</p>

        {error ? <div className="alert-error">{error}</div> : null}

        <form onSubmit={onSubmit} className="form-grid">
          <label>
            邮箱
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            密码
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "登录中…" : "登录"}
          </button>
        </form>

        <p className="hint">会话由 Auth.js 签发；权限每次请求从数据库重新解析。</p>
      </div>
    </main>
  );
}
