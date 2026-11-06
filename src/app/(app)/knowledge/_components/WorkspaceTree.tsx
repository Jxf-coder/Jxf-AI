"use client";

import Link from "next/link";
import { useState } from "react";

import { ChevronRightIcon, FileTextIcon, FolderIcon, LayersIcon } from "@/components/ui/icons";
import type { TreeCard, TreeDocument, WorkspaceTree } from "@/lib/knowledge/workspace";

interface WorkspaceTreeProps {
  tree: WorkspaceTree;
  selected: { kind: "doc" | "card"; id: string } | null;
}

const DOC_STATUS_LABEL: Record<string, string> = {
  parsed: "已解析",
  needs_ocr: "待 OCR",
  failed: "解析失败",
  revoked: "已撤回",
};

const CARD_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  dropped: "已丢弃",
};

function statusDot(status: string): string {
  if (status === "parsed" || status === "confirmed") return "bg-emerald-500";
  if (status === "pending" || status === "needs_ocr") return "bg-amber-500";
  if (status === "failed") return "bg-rose-500";
  return "bg-zinc-400";
}

/** 左侧常驻目录：00-知识卡 / 01-文档 / 02-待处理 */
export function WorkspaceTree({ tree, selected }: WorkspaceTreeProps) {
  const [sections, setSections] = useState<Record<string, boolean>>({
    cards: true,
    docs: true,
    pending: false,
  });
  const [groups, setGroups] = useState<Record<string, boolean>>({});

  const isOpen = (key: string, fallback = false) => groups[key] ?? fallback;

  function toggleSection(key: string) {
    setSections((current) => ({ ...current, [key]: !current[key] }));
  }

  function toggleGroup(key: string) {
    setGroups((current) => ({ ...current, [key]: !current[key] }));
  }

  function cardRow(card: TreeCard, depth: number) {
    const active = selected?.kind === "card" && selected.id === card.id;
    return (
      <Link
        key={card.id}
        href={`/knowledge?tab=scout&card=${card.id}`}
        aria-current={active ? "true" : undefined}
        className={`flex items-center gap-2 rounded-lg py-1.5 pr-2 text-[12px] transition-colors ${
          active
            ? "bg-white text-zinc-900 ring-1 ring-black/5"
            : "text-zinc-600 hover:bg-white/70 hover:text-zinc-900"
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(card.status)}`} />
        <span className="truncate">{card.title}</span>
        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
          {CARD_STATUS_LABEL[card.status] ?? card.status}
        </span>
      </Link>
    );
  }

  function documentRow(document: TreeDocument, depth: number) {
    const active = selected?.kind === "doc" && selected.id === document.id;
    return (
      <Link
        key={document.id}
        href={`/knowledge?tab=scout&doc=${document.id}`}
        aria-current={active ? "true" : undefined}
        className={`flex items-center gap-2 rounded-lg py-1.5 pr-2 text-[12px] transition-colors ${
          active
            ? "bg-white text-zinc-900 ring-1 ring-black/5"
            : "text-zinc-600 hover:bg-white/70 hover:text-zinc-900"
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <FileTextIcon size={13} className="shrink-0 text-zinc-400" />
        <span className="truncate">{document.title}</span>
        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
          {DOC_STATUS_LABEL[document.status] ?? document.status}
        </span>
      </Link>
    );
  }

  function GroupHead({
    groupKey,
    label,
    count,
    depth,
  }: {
    groupKey: string;
    label: string;
    count: number;
    depth: number;
  }) {
    const open = isOpen(groupKey);
    return (
      <button
        type="button"
        onClick={() => toggleGroup(groupKey)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[12px] text-zinc-600 transition-colors hover:bg-white/70 hover:text-zinc-900"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <ChevronRightIcon
          size={13}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <FolderIcon size={13} className="shrink-0 text-zinc-400" />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-400">{count}</span>
      </button>
    );
  }

  function SectionHead({
    sectionKey,
    label,
    count,
  }: {
    sectionKey: string;
    label: string;
    count: number;
  }) {
    const open = sections[sectionKey] ?? false;
    return (
      <button
        type="button"
        onClick={() => toggleSection(sectionKey)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-[12px] font-semibold text-zinc-700 transition-colors hover:bg-white/70"
      >
        <ChevronRightIcon
          size={14}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <LayersIcon size={14} className="shrink-0 text-zinc-400" />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 text-[10px] font-normal tabular-nums text-zinc-400">
          {count}
        </span>
      </button>
    );
  }

  const pendingEmpty = tree.totals.pending === 0;

  return (
    <aside
      aria-label="知识库目录"
      className="max-h-[360px] overflow-y-auto rounded-2xl border border-hairline bg-[#f7f8fa] p-2 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]"
    >
      <p className="px-2 pb-1 pt-1 text-[11px] font-medium text-zinc-500">知识库目录</p>

      <SectionHead sectionKey="cards" label="00-知识卡" count={tree.totals.cards} />
      {sections.cards ? (
        <div className="mb-1">
          {tree.cardGroups.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-zinc-400">还没有知识卡</p>
          ) : (
            tree.cardGroups.map((group) => {
              const key = `cards:${group.category}`;
              const open = isOpen(key, tree.cardGroups.length <= 3);
              return (
                <div key={key}>
                  <GroupHead groupKey={key} label={group.category} count={group.cards.length} depth={1} />
                  {open ? group.cards.map((card) => cardRow(card, 3)) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}

      <SectionHead sectionKey="docs" label="01-文档" count={tree.totals.documents} />
      {sections.docs ? (
        <div className="mb-1">
          {tree.departments.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-zinc-400">还没有文档</p>
          ) : (
            tree.departments.map((department) => {
              const key = `dep:${department.id}`;
              const open = isOpen(key, tree.departments.length === 1);
              return (
                <div key={department.id}>
                  <GroupHead
                    groupKey={key}
                    label={department.name}
                    count={department.runs.reduce((sum, run) => sum + run.documents.length, 0)}
                    depth={1}
                  />
                  {open
                    ? department.runs.map((run) => {
                        const runKey = `run:${run.id}`;
                        const runOpen = isOpen(runKey, department.runs.length === 1);
                        return (
                          <div key={runKey}>
                            <GroupHead
                              groupKey={runKey}
                              label={run.label}
                              count={run.documents.length}
                              depth={2}
                            />
                            {runOpen ? run.documents.map((document) => documentRow(document, 3)) : null}
                          </div>
                        );
                      })
                    : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}

      <SectionHead sectionKey="pending" label="02-待处理" count={tree.totals.pending} />
      {sections.pending ? (
        <div className="pb-1">
          {pendingEmpty ? (
            <p className="px-2 py-1.5 text-[11px] text-zinc-400">没有待处理项</p>
          ) : (
            <>
              {tree.pending.needsOcr.length > 0 ? (
                <p className="px-2 pt-1 text-[11px] text-zinc-500">
                  待 OCR {tree.pending.needsOcr.length}
                </p>
              ) : null}
              {tree.pending.needsOcr.map((document) => documentRow(document, 2))}
              {tree.pending.failed.length > 0 ? (
                <p className="px-2 pt-2 text-[11px] text-zinc-500">
                  解析失败 {tree.pending.failed.length}
                </p>
              ) : null}
              {tree.pending.failed.map((document) => documentRow(document, 2))}
              {tree.pending.pendingCards.length > 0 ? (
                <p className="px-2 pt-2 text-[11px] text-zinc-500">
                  待确认卡 {tree.pending.pendingCards.length}
                </p>
              ) : null}
              {tree.pending.pendingCards.map((card) => cardRow(card, 2))}
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
