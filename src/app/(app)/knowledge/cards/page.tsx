import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** 旧入口保留：知识卡已并入 /knowledge?tab=cards */
export default async function KnowledgeCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  redirect(status ? `/knowledge?tab=cards&status=${status}` : "/knowledge?tab=cards");
}
