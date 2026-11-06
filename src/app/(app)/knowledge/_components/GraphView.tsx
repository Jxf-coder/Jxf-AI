import Link from "next/link";

import { EmptyState } from "@/components/knowledge/EmptyState";
import type { GraphData } from "@/lib/knowledge/workspace";

const STROKE: Record<"evidence" | "unverified" | "conflict", string> = {
  evidence: "rgba(0, 113, 227, 0.45)",
  unverified: "rgba(0, 113, 227, 0.2)",
  conflict: "rgba(225, 29, 72, 0.4)",
};

/** 知识图谱：左列卡片、右列文档，边来自证据链与冲突关系 */
export function GraphView({ data }: { data: GraphData }) {
  const cards = data.nodes.filter((node) => node.kind === "card");
  const documents = data.nodes.filter((node) => node.kind === "document");

  if (data.nodes.length === 0) {
    return (
      <section className="rounded-2xl border border-hairline bg-white p-4 shadow-card sm:p-6">
        <h2 className="text-base font-semibold tracking-tight text-zinc-900">知识关系图谱</h2>
        <div className="mt-3">
          <EmptyState>还没有知识卡。上传文档并确认几张卡之后，这里会画出卡片与证据文档的关系。</EmptyState>
        </div>
      </section>
    );
  }

  const position = new Map<string, { x: number; y: number }>();
  cards.forEach((node, index) => {
    position.set(node.id, { x: 24, y: (100 * (index + 1)) / (cards.length + 1) });
  });
  documents.forEach((node, index) => {
    position.set(node.id, { x: 76, y: (100 * (index + 1)) / (documents.length + 1) });
  });

  return (
    <section className="rounded-2xl border border-hairline bg-white p-4 shadow-card sm:p-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight text-zinc-900">知识关系图谱</h2>
        <span className="text-[11px] tabular-nums text-zinc-500">
          节点 {data.nodes.length} · 关系 {data.edges.length}
        </span>
      </div>

      <div className="relative h-[420px] overflow-hidden rounded-xl bg-[#f7f8fa] sm:h-[520px]">
        <svg
          aria-hidden
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {data.edges.map((edge) => {
            const from = position.get(edge.from);
            const to = position.get(edge.to);
            if (!from || !to) {
              return null;
            }
            return (
              <line
                key={`${edge.tone}:${edge.from}:${edge.to}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={STROKE[edge.tone]}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={edge.tone === "evidence" ? undefined : "3 3"}
              />
            );
          })}
        </svg>

        {data.nodes.map((node) => {
          const point = position.get(node.id);
          if (!point) {
            return null;
          }
          const href =
            node.kind === "card"
              ? `/knowledge?tab=scout&card=${node.id}`
              : `/knowledge?tab=scout&doc=${node.id}`;
          return (
            <Link
              key={node.id}
              href={href}
              title={node.label}
              className={`absolute flex max-w-[42%] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
                node.kind === "card"
                  ? "border-black/5 bg-white text-zinc-800 hover:border-apple-blue/40 hover:text-apple-blue"
                  : "border-black/5 bg-white text-zinc-600 hover:border-apple-blue/40 hover:text-apple-blue"
              }`}
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  node.status === "confirmed" || node.status === "parsed"
                    ? "bg-emerald-500"
                    : node.status === "failed"
                      ? "bg-rose-500"
                      : "bg-amber-500"
                }`}
              />
              <span className="truncate">{node.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-apple-blue/60" />
          已核对证据
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 border-t border-dashed border-apple-blue/40" />
          未核对证据
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 border-t border-dashed border-rose-400/60" />
          说法冲突
        </span>
        <span className="ml-auto tabular-nums">
          全库 {data.totals.cards} 张卡 · {data.totals.documents} 份文档
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
        图谱按证据关系取样：优先已确认卡，单次最多 24 张卡；点任意节点在右侧打开对应条目。
      </p>
    </section>
  );
}
