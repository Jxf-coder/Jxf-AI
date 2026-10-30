import { errorMessage } from "@/lib/logger";
import { runReadinessChecks, type ReadinessReport } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  let report: ReadinessReport | null = null;
  let failure: string | null = null;

  try {
    report = await runReadinessChecks();
  } catch (error) {
    failure = errorMessage(error);
  }

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">系统健康状态</h1>
          <p className="page-subtitle">空库可启动性检查 · Phase 0</p>
        </div>
        {report ? (
          <span className={`badge ${report.status === "ok" ? "badge-ok" : "badge-error"}`}>
            {report.status === "ok" ? "READY" : "DEGRADED"}
          </span>
        ) : (
          <span className="badge badge-error">FAILED</span>
        )}
      </header>

      {failure ? <div className="alert-error">健康检查执行失败：{failure}</div> : null}

      {report ? (
        <>
          <section className="card">
            <h2 className="card-title">实例信息</h2>
            <dl className="meta-grid">
              <div>
                <div className="meta-label">服务</div>
                <div className="meta-value">{report.service}</div>
              </div>
              <div>
                <div className="meta-label">版本</div>
                <div className="meta-value">{report.version}</div>
              </div>
              <div>
                <div className="meta-label">运行环境</div>
                <div className="meta-value">{report.app_env}</div>
              </div>
              <div>
                <div className="meta-label">已运行</div>
                <div className="meta-value">{report.uptime_s}s</div>
              </div>
              <div>
                <div className="meta-label">检查时间</div>
                <div className="meta-value">{report.timestamp}</div>
              </div>
            </dl>
          </section>

          <section className="card">
            <h2 className="card-title">依赖检查</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>组件</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {report.checks.map((check) => (
                  <tr key={check.name}>
                    <td className="mono">{check.name}</td>
                    <td>
                      <span className={`badge ${check.status === "ok" ? "badge-ok" : "badge-error"}`}>
                        {check.status === "ok" ? "OK" : "ERROR"}
                      </span>
                    </td>
                    <td className="mono">{check.latency_ms}ms</td>
                    <td className="mono">{check.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              postgres 检查同时校验 pgvector / pg_bigm / pg_trgm 三个必装扩展；任一缺失即判为
              DEGRADED。
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}
