import { EmptyState } from "@/components/knowledge/EmptyState";
import { SectionCard } from "@/components/knowledge/SectionCard";
import type { UserContext } from "@/lib/db/user-context";
import { listExperienceFailures } from "@/lib/knowledge/experience/admin";

import { ExperienceJobsPanel } from "./ExperienceJobsPanel";

interface ExperienceJobsTabProps {
  context: UserContext;
}

/** 沉淀任务：失败/死信列表 + 重试（RLS 限制在当前可读部门内） */
export async function ExperienceJobsTab({ context }: ExperienceJobsTabProps) {
  const rows = await listExperienceFailures(context, 50);

  return (
    <SectionCard
      title="失败重试"
      count={rows.length}
      desc="进入死信或失败的经验任务。重试会清空尝试次数与错误，由 worker 在下一轮领取；不会重复产卡。"
    >
      {rows.length === 0 ? (
        <EmptyState>当前范围内没有失败任务，队列运行正常。</EmptyState>
      ) : (
        <ExperienceJobsPanel rows={rows} />
      )}
    </SectionCard>
  );
}
