"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  LayersIcon,
} from "@/components/ui/icons";
import type { TreeFolder, TreeItem, WorkspaceTree } from "@/lib/knowledge/workspace";

import { emptyTrashAction } from "../actions";

interface WorkspaceTreeProps {
  tree: WorkspaceTree;
  selected: { kind: "doc" | "card"; id: string } | null;
  /** 目录标题搜索词（服务端检索，不受目录 500 条上限影响） */
  query: string;
  matches: TreeItem[];
  /** 当前 Tab，保证搜索提交后不跳出当前视图 */
  tab: string;
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
export function WorkspaceTree({ tree, selected, query, matches, tab }: WorkspaceTreeProps) {
  const router = useRouter();
  const firstDepartment = tree.departments[0];
  const firstRole = firstDepartment?.roles[0];

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    "shared": true,
    ...(firstDepartment ? { [`dep:${firstDepartment.id}`]: true } : {}),
    ...(firstDepartment && firstRole ? { [`role:${firstDepartment.id}:${firstRole.name}`]: true } : {}),
  }));
  /** 待二次确认清空的部门 */
  const [emptyingFor, setEmptyingFor] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState("");

  const isOpen = (key: string, fallback = false) => expanded[key] ?? fallback;

  function toggle(key: string) {
    setExpanded((current) => ({ ...current, [key]: !current[key] }));
  }

  async function emptyTrash(departmentId: string) {
    if (emptyingFor !== departmentId) {
      setEmptyingFor(departmentId);
      return;
    }
    setEmptyingFor(null);
    setClearing(true);
    const result = await emptyTrashAction(departmentId);
    setClearing(false);
    setNotice(result.message);
    if (result.ok) {
      router.refresh();
    }
  }

  function itemRow(item: TreeItem, depth: number, keepQuery = false) {
    const active = selected?.kind === (item.kind === "card" ? "card" : "doc") && selected.id === item.id;
    const base =
      item.kind === "card"
        ? `/knowledge?tab=scout&card=${item.id}`
        : `/knowledge?tab=scout&doc=${item.id}`;
    const href = keepQuery && query ? `${base}&treeQ=${encodeURIComponent(query)}` : base;
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

  function folderBlock(
    folder: TreeFolder,
    depth: number,
    keyPrefix: string,
    departmentId?: string,
  ) {
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
        {open && hasItems ? (
          <>
            {folder.items.map((item) => itemRow(item, depth + 1))}
            {folder.key === "99-trash" && departmentId ? (
              <div
                className="flex justify-end pr-1"
                style={{ paddingLeft: `${(depth + 1) * 10 + 6}px` }}
              >
                <button
                  type="button"
                  disabled={clearing}
                  onClick={() => emptyTrash(departmentId)}
                  className="rounded-md px-1 py-0.5 text-[10px] text-zinc-400 transition-colors hover:text-zinc-700 disabled:opacity-50"
                >
                  {clearing
                    ? "清空中…"
                    : emptyingFor === departmentId
                      ? "确认清空"
                      : "清空回收站"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
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

      <form action="/knowledge" method="get" className="px-1 pb-2">
        <input type="hidden" name="tab" value={tab} />
        <input
          name="treeQ"
          defaultValue={query}
          maxLength={60}
          placeholder="搜索标题…"
          aria-label="搜索知识库标题"
          className="w-full rounded-lg border border-black/[0.06] bg-white px-2 py-1.5 text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-black/20"
        />
      </form>

      {query ? (
        <div className="mb-2 rounded-xl border border-black/[0.05] bg-white/80 p-1">
          <p className="px-1.5 py-1 text-[11px] text-zinc-500">
            搜索「{query}」 · {matches.length} 条
          </p>
          {matches.length === 0 ? (
            <p className="px-1.5 pb-1 text-[11px] text-zinc-400">没有匹配的知识卡或文档</p>
          ) : (
            matches.map((item) => itemRow(item, 1, true))
          )}
          <Link
            href={`/knowledge?tab=${tab}`}
            scroll={false}
            className="block px-1.5 py-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-700"
          >
            清除搜索
          </Link>
        </div>
      ) : null}

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
        const deptCount =
          department.folders.reduce((sum, folder) => sum + folder.items.length, 0) +
          department.roles.reduce(
            (sum, role) => sum + role.folders.reduce((n, folder) => n + folder.items.length, 0),
            0,
          );
        return (
          <div key={department.id}>
            {sectionHead(deptKey, department.name, deptCount)}
            {isOpen(deptKey) ? (
              <div className="mb-1">
                {department.roles.length === 0
                  ? department.folders.map((folder) => folderBlock(folder, 2, deptKey, department.id))
                  : department.roles.map((role) => {
                      const roleKey = `role:${department.id}:${role.name}`;
                      const roleCount = role.folders.reduce((sum, folder) => sum + folder.items.length, 0);
                      return (
                        <div key={roleKey}>
                          {groupHead(roleKey, `角色·${role.name}`, roleCount, 2)}
                          {isOpen(roleKey)
                            ? role.folders.map((folder) =>
                                folderBlock(folder, 3, roleKey, department.id),
                              )
                            : null}
                        </div>
                      );
                    })}
              </div>
            ) : null}
          </div>
        );
      })}

      {tree.totals.truncated ? (
        <p className="px-2 pt-1 text-[10px] leading-relaxed text-zinc-400">
          条目较多，目录仅显示最近 500 条；用上方搜索可定位更早的内容
        </p>
      ) : null}

      {notice ? (
        <p role="status" className="px-2 py-1 text-[11px] text-zinc-500">
          {notice}
        </p>
      ) : null}
    </aside>
  );
}
