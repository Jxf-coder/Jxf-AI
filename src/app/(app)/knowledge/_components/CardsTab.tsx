import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { listCardFacets, listCards, type CardFilterStatus, type CardFilters } from "@/lib/knowledge/cards";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { CardsClient } from "./CardsClient";

const FILTER_STATUS: readonly string[] = ["pending", "confirmed", "dropped", "all"];

export interface CardsSearchParams {
  status?: string;
  kind?: string;
  category?: string;
  product?: string;
  q?: string;
  problems?: string;
}

interface CardsTabProps {
  context: UserContext;
  searchParams: CardsSearchParams;
}

/** 知识卡 Tab：服务端取数（RLS 内），交互全部交给客户端组件 */
export async function CardsTab({ context, searchParams }: CardsTabProps) {
  const status: CardFilterStatus =
    searchParams.status && FILTER_STATUS.includes(searchParams.status)
      ? (searchParams.status as CardFilterStatus)
      : "pending";

  const filters: CardFilters = {
    status,
    kind: searchParams.kind || undefined,
    category: searchParams.category || undefined,
    product: searchParams.product || undefined,
    q: searchParams.q?.trim() || undefined,
    problems: searchParams.problems === "1",
  };

  const access = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }
    return {
      canRead: actor ? authorize(actor, "knowledge:read").allowed : false,
      canWrite: actor ? authorize(actor, "knowledge:write").allowed : false,
      canConfirm: actor ? authorize(actor, "knowledge:confirm").allowed : false,
    };
  });

  if (!access.canRead) {
    return (
      <InlineMessage tone="error">当前账号没有「知识库查看」权限，请联系 L1 管理员授权。</InlineMessage>
    );
  }

  const cards = await listCards(context, filters);
  const facets = await listCardFacets(context);

  return (
    <CardsClient
      cards={cards}
      facets={facets}
      canWrite={access.canWrite}
      canConfirm={access.canConfirm}
      filter={{
        status,
        kind: filters.kind ?? "",
        category: filters.category ?? "",
        product: filters.product ?? "",
        q: filters.q ?? "",
        problems: filters.problems ?? false,
      }}
    />
  );
}
