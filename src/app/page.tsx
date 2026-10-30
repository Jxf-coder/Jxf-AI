export default function HomePage() {
  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Jxf-AI 工作台</h1>
          <p className="page-subtitle">Phase 0 · 环境底座已就绪</p>
        </div>
        <span className="badge badge-ok">P0</span>
      </header>

      <section className="card">
        <h2 className="card-title">当前阶段</h2>
        <p>
          本实例只提供健康检查与全局错误页，业务功能从 Phase 1（组织治理 + 身份链路）开始。
        </p>
        <p>
          <a className="button" href="/health">
            查看系统健康状态
          </a>
        </p>
        <p className="hint">
          健康检查接口：<span className="mono">/api/health</span>（就绪）与{" "}
          <span className="mono">/api/health/live</span>（存活）
        </p>
      </section>
    </main>
  );
}
