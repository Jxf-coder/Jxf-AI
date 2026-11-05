"use client";

import { useState, useTransition } from "react";

import { runRegressionAction, seedRegressionAction } from "./actions";

export function RegressionPanel() {
  const [pending, startTransition] = useTransition();
  const [buildTag, setBuildTag] = useState("");
  const [message, setMessage] = useState("");

  return (
    <div className="card">
      <div className="card-title">检索回归门禁</div>
      <p className="hint">
        用已确认卡片标题生成基线题；每次改动分块或向量模型后跑一轮，保留率低于 90% 或任一道未通过即判失败。
      </p>

      <div className="form-grid">
        <label>
          构建标记
          <input
            type="text"
            value={buildTag}
            onChange={(event) => setBuildTag(event.target.value)}
            maxLength={40}
            placeholder="例如：chunk-800 / bge-m3"
          />
        </label>
      </div>

      <div className="card-actions-row">
        <button
          type="button"
          className="button-secondary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await seedRegressionAction();
              setMessage(result.message);
            })
          }
        >
          生成基线题
        </button>
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await runRegressionAction(buildTag);
              setMessage(result.message);
            })
          }
        >
          {pending ? "运行中…" : "运行回归"}
        </button>
      </div>

      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}
