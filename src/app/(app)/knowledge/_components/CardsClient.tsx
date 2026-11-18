"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { EmptyState } from "@/components/knowledge/EmptyState";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { btnBlue, btnGhost, input, inputInline } from "@/components/knowledge/tokens";
import { Select } from "@/components/ui/select";
import type { CardFacets, CardMetaPatch, CardView } from "@/lib/knowledge/cards";
import { STANDARD_FOLDERS } from "@/lib/knowledge/folders";

import { bulkDecideAction } from "../cards/actions";
import { CardItem } from "./CardItem";
import { NewCardPanel } from "./NewCardPanel";
import { RetroPanel } from "./RetroPanel";
import { CARD_KIND_LABEL, CARD_STATUS_LABEL } from "./card-labels";

export interface CardsFilterState {
  status: string;
  kind: string;
  category: string;
  product: string;
  q: string;
  problems: boolean;
}

interface CardsClientProps {
  cards: CardView[];
  facets: CardFacets;
  canWrite: boolean;
  canConfirm: boolean;
  filter: CardsFilterState;
}

const STATUS_TABS = ["pending", "confirmed", "dropped", "all"] as const;

export function CardsClient({ cards, facets, canWrite, canConfirm, filter }: CardsClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(filter.q);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [bulk, setBulk] = useState({
    category: "",
    product: "",
    owner: "",
    validUntil: "",
    external: "" as "" | "yes" | "no",
    folder: "",
  });

  const allPicked = cards.length > 0 && cards.every((card) => picked.has(card.id));

  function apply(next: Partial<CardsFilterState>) {
    const merged: CardsFilterState = { ...filter, ...next, q };
    const search = new URLSearchParams();
    search.set("tab", "cards");
    search.set("status", merged.status);
    if (merged.kind) search.set("kind", merged.kind);
    if (merged.category) search.set("category", merged.category);
    if (merged.product) search.set("product", merged.product);
    if (merged.q) search.set("q", merged.q);
    if (merged.problems) search.set("problems", "1");
    router.push(`/knowledge?${search.toString()}`);
  }

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function runBulk(action: "confirm" | "drop" | "patch") {
    const ids = Array.from(picked);
    if (ids.length === 0) {
      return;
    }

    const patch: CardMetaPatch = {};
    if (bulk.category) patch.category = bulk.category;
    if (bulk.product) patch.product = bulk.product;
    if (bulk.owner) patch.owner = bulk.owner;
    if (bulk.validUntil) patch.validUntil = bulk.validUntil;
    if (bulk.external === "yes") patch.externalOk = true;
    if (bulk.external === "no") patch.externalOk = false;
    if (bulk.folder) patch.folderKey = bulk.folder;

    if (action === "patch" && Object.keys(patch).length === 0) {
      setFailed(true);
      setMessage("没有要修改的字段");
      return;
    }

    startTransition(async () => {
      const result = await bulkDecideAction(ids, action, patch);
      setMessage(result.message);
      setFailed(!result.ok);
      setPicked(new Set());
      router.refresh();
    });
  }

  return (
    <SectionCard
      title="知识卡"
      count={`${cards.length} 张`}
      desc="巡读与蒸馏生成的卡都先是「待确认」；证据没对上原文的，先改正文或来源再确认。"
    >
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((status) => {
          const active = filter.status === status;
          return (
            <button
              key={status}
              type="button"
              onClick={() => apply({ status })}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                active
                  ? "bg-apple-blue-soft font-semibold text-apple-blue"
                  : "bg-apple-canvas text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {status === "all" ? "全部" : CARD_STATUS_LABEL[status]}
            </button>
          );
        })}
        <label className="flex items-center gap-1.5 text-[12px] text-zinc-500">
          <input
            type="checkbox"
            checked={filter.problems}
            onChange={(event) => apply({ problems: event.target.checked })}
          />
          只看有问题的（冲突 / 过期 / 证据没对上）
        </label>
      </div>

      <form
        className="mt-3 grid gap-2 sm:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          apply({});
        }}
      >
        <Select
          className="w-full"
          value={filter.kind}
          aria-label="按类型筛选"
          onValueChange={(value) => apply({ kind: value })}
          options={[
            { value: "", label: "全部类型" },
            ...Object.entries(CARD_KIND_LABEL).map(([value, text]) => ({ value, label: text })),
          ]}
        />
        <Select
          className="w-full"
          value={filter.category}
          aria-label="按分类筛选"
          onValueChange={(value) => apply({ category: value })}
          options={[
            { value: "", label: "全部分类" },
            ...facets.categories.map((item) => ({
              value: item.value,
              label: `${item.value}（${item.count}）`,
            })),
          ]}
        />
        <Select
          className="w-full"
          value={filter.product}
          aria-label="按产品筛选"
          onValueChange={(value) => apply({ product: value })}
          options={[
            { value: "", label: "全部产品" },
            ...facets.products.map((product) => ({ value: product, label: product })),
          ]}
        />
        <input
          className={`${input} sm:col-span-2`}
          value={q}
          placeholder="搜标题 / 正文 / 来源"
          aria-label="搜索知识卡"
          onChange={(event) => setQ(event.target.value)}
        />
      </form>

      {canWrite ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-hairline p-2.5">
          <label className="flex items-center gap-1.5 text-[12px] text-zinc-500">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={(event) => setPicked(event.target.checked ? new Set(cards.map((card) => card.id)) : new Set())}
            />
            全选本页
          </label>
          <span className="text-[12px] text-zinc-500">已选 {picked.size}</span>

          <Select
            className="w-auto"
            value={bulk.category}
            aria-label="批量分类"
            onValueChange={(value) => setBulk((current) => ({ ...current, category: value }))}
            options={[
              { value: "", label: "分类不变" },
              ...facets.categories
                .filter((item) => item.value !== "未分类")
                .map((item) => ({ value: item.value, label: item.value })),
            ]}
          />
          <input
            className={`${inputInline} w-[120px]`}
            value={bulk.product}
            placeholder="产品不变"
            aria-label="批量产品"
            onChange={(event) => setBulk((current) => ({ ...current, product: event.target.value }))}
          />
          <input
            className={`${inputInline} w-[100px]`}
            value={bulk.owner}
            placeholder="负责人不变"
            aria-label="批量负责人"
            onChange={(event) => setBulk((current) => ({ ...current, owner: event.target.value }))}
          />
          <input
            className={`${inputInline} w-[140px]`}
            type="date"
            value={bulk.validUntil}
            aria-label="批量有效期"
            onChange={(event) => setBulk((current) => ({ ...current, validUntil: event.target.value }))}
          />
          <Select
            className="w-auto"
            value={bulk.external}
            aria-label="批量对外策略"
            onValueChange={(value) =>
              setBulk((current) => ({
                ...current,
                external: value as "" | "yes" | "no",
              }))
            }
            options={[
              { value: "", label: "对外不变" },
              { value: "yes", label: "可对外" },
              { value: "no", label: "仅内部" },
            ]}
          />

          <Select
            className="w-auto"
            value={bulk.folder}
            aria-label="批量目录"
            onValueChange={(value) => setBulk((current) => ({ ...current, folder: value }))}
            options={[
              { value: "", label: "目录不变" },
              ...STANDARD_FOLDERS.filter((folder) => folder.key !== "99-trash").map((folder) => ({
                value: folder.key,
                label: folder.label,
              })),
            ]}
          />
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btnGhost}
              disabled={picked.size === 0 || pending}
              onClick={() => runBulk("patch")}
            >
              只改字段
            </button>
            <button
              type="button"
              className={btnBlue}
              disabled={picked.size === 0 || pending}
              onClick={() => runBulk("confirm")}
            >
              确认所选
            </button>
            <button
              type="button"
              className={btnGhost}
              disabled={picked.size === 0 || pending}
              onClick={() => runBulk("drop")}
            >
              丢弃所选
            </button>
          </span>
        </div>
      ) : null}

      {canWrite ? <NewCardPanel /> : null}
      {canWrite ? <RetroPanel /> : null}

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-3 mb-0">
          {message}
        </InlineMessage>
      ) : null}

      {cards.length === 0 ? (
        <div className="mt-3">
          <EmptyState>
            {filter.status === "pending"
              ? "没有待确认的卡。去「巡读上传」读一批资料，或手写一张。"
              : "这个筛选下没有知识卡。"}
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-2 list-none divide-y divide-black/[0.04] p-0">
          {cards.map((card) => (
            <CardItem
              key={card.id}
              card={card}
              selected={picked.has(card.id)}
              onToggle={toggle}
              canWrite={canWrite}
              canConfirm={canConfirm}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
