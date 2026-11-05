"use client";

import { useState, useTransition } from "react";

import { actions, alert, badge, btnBlue, btnGhost, card, cardDesc, cardHead, cardTitle, input, label } from "./ui";
import { runRegressionAction, seedRegressionAction } from "./actions";

export function RegressionPanel() {
  const [pending, startTransition] = useTransition();
  const [buildTag, setBuildTag] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  return (
    <div className={card}>
      <div className={cardHead}>
        <h2 className={cardTitle}>检索回归门禁</h2>
        <span className={badge()}>retained ≥ 90%</span>
      </div>
      <p className={cardDesc}>
        用已确认卡片标题生成基线题；改动分块或向量模型后跑一轮，保留率低于 90% 或任一道未通过即判失败。
      </p>

      <label className="block max-w-md">
        <span className={label}>构建标记</span>
        <input
          className={input}
          type="text"
          value={buildTag}
          onChange={(event) => setBuildTag(event.target.value)}
          maxLength={40}
          placeholder="例如：chunk-800 / bge-m3"
        />
      </label>

      <div className={actions}>
        <button
          type="button"
          className={btnGhost}
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
          className={btnBlue}
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
        <div className={`${alert(failed ? "error" : "info")} mt-4 mb-0`}>{message}</div>
      ) : null}
    </div>
  );
}
