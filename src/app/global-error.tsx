"use client";

/**
 * 全局错误页：渲染在最外层（替换 root layout），因此必须自带 html / body。
 * 不依赖外部样式，避免样式加载失败时页面不可读。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f7f9fc",
          color: "#16202b",
          fontFamily:
            '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
          padding: "24px",
        }}
      >
        <main
          style={{
            maxWidth: "640px",
            width: "100%",
            background: "#fff",
            border: "1px solid #d7e0ec",
            borderRadius: "10px",
            padding: "32px",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "22px", color: "#0b2545" }}>系统开小差了</h1>
          <p style={{ color: "#5b6b7d", fontSize: "14px" }}>
            页面渲染失败。请重试；若持续失败，请联系管理员并提供下方错误摘要。
          </p>
          <p
            style={{
              fontFamily: '"Cascadia Mono", Consolas, monospace',
              fontSize: "13px",
              background: "#fdf1f0",
              border: "1px solid #f0c5c2",
              color: "#b3261e",
              borderRadius: "8px",
              padding: "12px",
              wordBreak: "break-all",
            }}
          >
            {error.message || "未知错误"}
            {error.digest ? ` (digest: ${error.digest})` : ""}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              border: "1px solid #1d5b8c",
              background: "#1d5b8c",
              color: "#fff",
              borderRadius: "8px",
              padding: "8px 18px",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </main>
      </body>
    </html>
  );
}
