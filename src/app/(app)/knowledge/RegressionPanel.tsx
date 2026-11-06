"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { actions, badge, btnBlue, btnGhost, input } from "@/components/knowledge/tokens";
import { runRegressionAction, seedRegressionAction } from "./actions";

export function RegressionPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [buildTag, setBuildTag] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  return (
    <SectionCard
      title="检索回归门禁"
      right={<span className={badge()}>retained ≥ 90%</span>}
      desc="用已确认卡片标题生成基线题；改动分块或向量模型后跑一轮，保留率低于 90% 或任一道未通过即判失败。"
    >
      <Field label="构建标记" className="block max-w-md">
        <input
          className={input}
          type="text"
          value={buildTag}
          onChange={(event) => setBuildTag(event.target.value)}
          maxLength={40}
          placeholder="例如：chunk-800 / bge-m3"
        />
      </Field>

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
              if (result.ok) {
                router.refresh();
              }
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
              if (result.ok) {
                router.refresh();
              }
            })
          }
        >
          {pending ? "运行中…" : "运行回归"}
        </button>
      </div>

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-4 mb-0">
          {message}
        </InlineMessage>
      ) : null}
    </SectionCard>
  );
}
