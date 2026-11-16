"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { actions, btnBlue, input } from "@/components/knowledge/tokens";

import { recalcRouteStatsAction } from "./actions";

/** 纠偏统计的重算入口：把最近 N 天反馈汇总进聚合表（仅 L1 可用） */
export function RouteStatsPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [days, setDays] = useState(30);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  return (
    <SectionCard
      title="重算纠偏统计"
      desc="把最近 N 天的目录纠偏记录重新汇总进日聚合表；重复重算只覆盖计数，不会产生重复行。"
    >
      <div className={actions}>
        <label className="flex items-center gap-2 text-[13px] text-zinc-700">
          统计窗口
          <select
            className={`${input} w-28`}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
          </select>
        </label>
        <button
          type="button"
          className={btnBlue}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await recalcRouteStatsAction(days);
              setFailed(!result.ok);
              setMessage(result.message);
              if (result.ok) {
                router.refresh();
              }
            })
          }
        >
          {pending ? "重算中…" : "重算"}
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
