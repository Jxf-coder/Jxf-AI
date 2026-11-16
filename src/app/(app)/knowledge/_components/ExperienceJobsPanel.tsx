"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { badge, meta } from "@/components/knowledge/tokens";
import type { ExperienceJobFailure } from "@/lib/knowledge/experience/admin";

import { retryExperienceJobAction } from "../actions";

const CHANNEL_LABEL: Record<string, string> = {
  document: "文档",
  skill: "技能",
  pipeline: "产线",
  review: "验收",
  retro: "复盘",
  connector: "连接器",
  manual: "手动",
};

function formatTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}

/** 失败任务列表：逐条重试；重试成功后由 router.refresh 拉取最新状态 */
export function ExperienceJobsPanel({ rows }: { rows: ExperienceJobFailure[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function retry(jobId: string) {
    setActiveId(jobId);
    startTransition(async () => {
      const result = await retryExperienceJobAction(jobId);
      setFailed(!result.ok);
      setMessage(result.message);
      setActiveId(null);
      if (result.ok) {
        router.refresh();
      }
    });
  }

  return (
    <>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-separate border-spacing-y-1 text-[13px]">
          <thead>
            <tr className={`${meta} text-left`}>
              <th className="px-2 py-1 font-medium">部门</th>
              <th className="px-2 py-1 font-medium">通道</th>
              <th className="px-2 py-1 font-medium">来源</th>
              <th className="px-2 py-1 font-medium">状态</th>
              <th className="px-2 py-1 font-medium">尝试</th>
              <th className="px-2 py-1 font-medium">错误</th>
              <th className="px-2 py-1 font-medium">结束时间</th>
              <th className="px-2 py-1 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="bg-apple-canvas/60">
                <td className="rounded-l-xl px-2 py-1.5 text-zinc-800">{row.departmentName}</td>
                <td className="px-2 py-1.5 text-zinc-700">
                  {CHANNEL_LABEL[row.channel] ?? row.channel}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-zinc-500">
                  {row.sourceType}
                </td>
                <td className="px-2 py-1.5">
                  <span className={badge(row.status === "dead" ? "error" : "warn")}>
                    {row.status === "dead" ? "死信" : "失败"}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-zinc-700">{row.attempts}</td>
                <td className="max-w-[280px] truncate px-2 py-1.5 text-zinc-500" title={row.error ?? ""}>
                  {row.error ?? "—"}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-zinc-500">
                  {formatTime(row.finishedAt)}
                </td>
                <td className="rounded-r-xl px-2 py-1.5 text-right">
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-[12px] font-medium text-apple-blue hover:bg-white"
                    disabled={pending}
                    onClick={() => retry(row.id)}
                  >
                    {pending && activeId === row.id ? "重试中…" : "重试"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-3">
          {message}
        </InlineMessage>
      ) : null}
    </>
  );
}
