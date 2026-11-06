import type { UserContext } from "@/lib/db/user-context";
import { listGaps } from "@/lib/knowledge/gaps";

import { GapsClient } from "./GapsClient";

interface GapsTabProps {
  context: UserContext;
  canWrite: boolean;
  statusParam?: string;
}

export async function GapsTab({ context, canWrite, statusParam }: GapsTabProps) {
  const status =
    statusParam === "closed" || statusParam === "all" ? statusParam : "open";

  const gaps = await listGaps(context, status);

  return (
    <GapsClient
      status={status}
      canWrite={canWrite}
      gaps={gaps.map((gap) => ({
        id: gap.id,
        question: gap.question,
        status: gap.status,
        source: gap.source,
        repeatCount: gap.repeatCount,
        createdAt: gap.createdAt.toISOString(),
      }))}
    />
  );
}
