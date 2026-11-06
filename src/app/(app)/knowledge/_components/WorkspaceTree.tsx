"use client";

import Link from "next/link";
import { useState } from "react";

import {
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  LayersIcon,
} from "@/components/ui/icons";
import type { TreeFolder, TreeItem, WorkspaceTree } from "@/lib/knowledge/workspace";

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

function itemStatusLabel(item: TreeItem): string {
  const table = item.kind === "card" ? CARD_STATUS_LABEL : DOC_STATUS_LABEL;
  return table[item.status] ?? item.status;
}

/** 左侧常驻目录：公司资料（共享） + 部门 → 岗位 → 10 个标准目录 */
export function WorkspaceTree({ tree, selected }: WorkspaceTreeProps) {
  const firstDepartment = tree.departments[0];
  const firstRole = firstDepartment?.roles[0];

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    "shared": true,
    ...(firstDepartment ? { [`dep:${firstDepartment.id}`]: true } : {}),
    ...(firstDepartment && firstRole ? { [`role:${firstDepartment.id}:${firstRole.name}`]: true } : {}),
  }));

  const isOpen = (key: string, fallback = false) => expanded[key] ?? fallback;

  function toggle(key: string) {
    setExpanded((current) => ({ ...current, [key]: !current[key] }));
  }

  function itemRow(item: TreeItem, depth: number) {
    const active = selected?.kind === (item.kind === "card" ? "card" : "doc") && selected.id === item.id;
    const href =
      item.kind === "card"
        ? `/knowledge?tab=scout&card=${item.id}`
        : `/knowledge?tab=scout&doc=${item.id}`;
    return (
      <Link
        key={`${item.kind}:${item.id}`}
        href={href}
        scroll={false}
        title={`${item.title} · ${itemStatusLabel(item)}`}
        aria-current={active ? "true" : undefined}
        className={`flex items-center gap-2 rounded-lg py-1.5 pr-2 text-[12px] transition-colors ${
          active
            ? "bg-white text-zinc-900 ring-1 ring-black/5"
            : "text-zinc-600 hover:bg-white/70 hover:text-zinc-900"
        }`}
        style={{ paddingLeft: `${depth * 10 + 6}px` }}
      >
        {item.kind === "card" ? (
          <LayersIcon size={13} className="shrink-0 text-zinc-400" />
        ) : (
          <FileTextIcon size={13} className="shrink-0 text-zinc-400" />
        )}
        <span className="truncate">{item.title}</span>
        <span className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(item.status)}`} />
      </Link>
    );
  }

  function folderBlock(folder: TreeFolder, depth: number, keyPrefix: string) {
    const key = `${keyPrefix}:${folder.key}`;
    const open = isOpen(key);
    const hasItems = folder.items.length > 0;
    return (
      <div key={key}>
        <button
          type="button"
          onClick={() => hasItems && toggle(key)}
          aria-expanded={hasItems ? open : undefined}
          className={`flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[12px] transition-colors ${
            hasItems ? "text-zinc-600 hover:bg-white/70 hover:text-zinc-900" : "text-zinc-400"
          }`}
          style={{ paddingLeft: `${depth * 10 + 6}px` }}
        >
          <ChevronRightIcon
            size={12}
            className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""} ${
              hasItems ? "" : "invisible"
            }`}
          />
          <FolderIcon size={13} className="shrink-0 text-zinc-400" />
          <span className="truncate">{folder.label}</span>
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-400">
            {folder.items.length}
          </span>
        </button>
        {open && hasItems ? folder.items.map((item) => itemRow(item, depth + 1)) : null}
      </div>
    );
  }

  function groupHead(key: string, label: string, count: number, depth: number) {
    const open = isOpen(key);
    return (
      <button
        type="button"
        onClick={() => toggle(key)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[12px] text-zinc-600 transition-colors hover:bg-white/70 hover:text-zinc-900"
        style={{ paddingLeft: `${depth * 10 + 6}px` }}
      >
        <ChevronRightIcon
          size={13}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-400">{count}</span>
      </button>
    );
  }

  function sectionHead(key: string, label: string, count: number) {
    const open = isOpen(key);
    return (
      <button
        type="button"
        onClick={() => toggle(key)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-[12px] font-semibold text-zinc-700 transition-colors hover:bg-white/70"
      >
        <ChevronRightIcon
          size={14}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 text-[10px] font-normal tabular-nums text-zinc-400">
          {count}
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="知识库目录"
      className="min-w-0 max-h-[360px] overflow-y-auto rounded-2xl border border-hairline bg-[#f7f8fa] p-2 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]"
    >
      <p className="px-2 pb-1 pt-1 text-[11px] font-medium text-zinc-500">知识库目录</p>

      {sectionHead("shared", "公司资料（共享）", tree.shared.count)}
      {isOpen("shared") ? (
        <div className="mb-1">
          {tree.shared.folders.map((folder) => folderBlock(folder, 2, "shared"))}
        </div>
      ) : null}

      {tree.departments.length === 0 ? (
        <p className="px-2 py-2 text-[11px] text-zinc-400">当前账号没有可见部门</p>
      ) : null}

      {tree.departments.map((department) => {
        const deptKey = `dep:${department.id}`;
        const deptCount = department.roles.reduce(
          (sum, role) => sum + role.folders.reduce((n, folder) => n + folder.items.length, 0),
          0,
        );
        return (
          <div key={department.id}>
            {sectionHead(deptKey, department.name, deptCount)}
            {isOpen(deptKey) ? (
              <div className="mb-1">
                {department.roles.length === 0 ? (
                  <p className="px-2 py-1 text-[11px] text-zinc-400">该部门暂无岗位</p>
                ) : null}
                {department.roles.map((role) => {
                  const roleKey = `role:${department.id}:${role.name}`;
                  const roleCount = role.folders.reduce((sum, folder) => sum + folder.items.length, 0);
                  return (
                    <div key={roleKey}>
                      {groupHead(roleKey, `角色·${role.name}`, roleCount, 2)}
                      {isOpen(roleKey)
                        ? role.folders.map((folder) => folderBlock(folder, 3, roleKey))
                        : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}
