"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        service: "web",
        msg: "route_render_failed",
        error: error.message,
        digest: error.digest ?? null,
      }),
    );
  }, [error]);

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">页面加载失败</h1>
          <p className="page-subtitle">错误已被记录，可尝试重试</p>
        </div>
        <span className="badge badge-error">ERROR</span>
      </header>

      <div className="alert-error">
        {error.message || "未知错误"}
        {error.digest ? ` (digest: ${error.digest})` : ""}
      </div>

      <button className="button" type="button" onClick={reset}>
        重试
      </button>
    </main>
  );
}
