"use client";

import { useState, useTransition } from "react";

import { runRegressionAction, seedRegressionAction } from "./actions";

export function RegressionPanel() {
  const [pending, startTransition] = useTransition();
  const [buildTag, setBuildTag] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  return (
    <div className="akb-card">
      <div className="akb-card-head">
        <h2 className="akb-card-title">检索回归门禁</h2>
        <span className="akb-badge">retained ≥ 90%</span>
      </div>
      <p className="akb-card-desc">
        用已确认卡片标题生成基线题；改动分块或向量模型后跑一轮，保留率低于 90% 或任一道未通过即判失败。
      </p>

      <div className="akb-form">
        <label className="akb-field">
          <span className="akb-label">构建标记</span>
          <input
            className="akb-input"
            type="text"
            value={buildTag}
            onChange={(event) => setBuildTag(event.target.value)}
            maxLength={40}
            placeholder="例如：chunk-800 / bge-m3"
          />
        </label>
      </div>

      <div className="akb-actions">
        <button
          type="button"
          className="akb-btn is-ghost"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await seedRegressionAction();
              setFailed(!result.ok);
              setMessage(result.message);
            })
          }
        >
          生成基线题
        </button>
        <button
          type="button"
          className="akb-btn is-blue"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await runRegressionAction(buildTag);
              setFailed(!result.ok);
              setMessage(result.message);
            })
          }
        >
          {pending ? "运行中…" : "运行回归"}
        </button>
      </div>

      {message ? (
        <div className={failed ? "akb-alert is-error" : "akb-alert"}>{message}</div>
      ) : null}
    </div>
  );
}
