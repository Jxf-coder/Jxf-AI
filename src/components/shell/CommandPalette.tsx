"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { usePermission } from "@/components/permissions/usePermission";
import { SearchIcon } from "@/components/ui/icons";
import type { PermissionKey } from "@/types/permission";
import type { AccessLevel } from "@/types/profile";

interface CommandItem {
  label: string;
  hint: string;
  href: string;
  keywords: string[];
  /** 无该权限时不出现在搜索结果里 */
  permission?: PermissionKey;
  /** 仅指定等级可见（L1 专属的权限管理） */
  requiresLevel?: AccessLevel;
}

const ITEMS: CommandItem[] = [
  {
    label: "组织架构",
    hint: "部门树 · 成员",
    href: "/org/positions",
    keywords: ["org", "position", "role", "岗位", "组织"],
    permission: "org:view",
  },
  { label: "我的权限", hint: "请求上下文", href: "/me/permissions", keywords: ["permission", "权限", "角色"] },
  {
    label: "审批中心",
    hint: "离职交接 · 待审批",
    href: "/me/approvals",
    keywords: ["approval", "handover", "审批", "交接"],
    permission: "member:manage",
  },
  {
    label: "权限管理",
    hint: "角色模板 · 成员授权 · 变更记录",
    href: "/settings/permissions",
    keywords: ["permission", "admin", "权限", "模板", "授权"],
    requiresLevel: "L1",
  },
  {
    label: "审计日志",
    hint: "组织与资料变更记录",
    href: "/me/audit",
    keywords: ["audit", "审计", "日志"],
    permission: "audit:read",
  },
  { label: "系统状态", hint: "依赖与健康检查", href: "/health", keywords: ["health", "status", "健康", "系统"] },
];

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

/** macOS 风格 Command Palette：当前提供页面级跳转，数据检索待 P3 接入 */
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const { can, level } = usePermission();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo(() => {
    const allowed = ITEMS.filter(
      (item) =>
        (!item.permission || can(item.permission)) &&
        (!item.requiresLevel || item.requiresLevel === level),
    );
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return allowed;
    }
    return allowed.filter(
      (item) =>
        item.label.toLowerCase().includes(keyword) ||
        item.hint.toLowerCase().includes(keyword) ||
        item.keywords.some((word) => word.includes(keyword)),
    );
  }, [query, can]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => (items.length === 0 ? 0 : (index + 1) % items.length));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (items.length === 0 ? 0 : (index - 1 + items.length) % items.length));
      } else if (event.key === "Enter") {
        const item = items[active];
        if (item) {
          event.preventDefault();
          router.push(item.href);
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, items, active, onClose, router]);

  if (!open) {
    return null;
  }

  return (
    <div className="palette-layer">
      <button type="button" className="palette-backdrop" aria-label="关闭全局搜索" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div className="palette-input-row">
          <SearchIcon className="search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder="搜索岗位、成员或页面"
            aria-label="全局搜索"
            autoComplete="off"
          />
          <kbd className="search-kbd">Esc</kbd>
        </div>

        <div className="palette-list" role="listbox" aria-label="搜索结果">
          {items.length === 0 ? (
            <p className="palette-empty">没有匹配项。数据检索将在 P3 随运行态上线。</p>
          ) : (
            items.map((item, index) => (
              <button
                key={item.href}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`palette-item${index === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  router.push(item.href);
                  onClose();
                }}
              >
                <span className="palette-item-label">{item.label}</span>
                <span className="palette-item-hint">{item.hint}</span>
              </button>
            ))
          )}
        </div>

        <div className="palette-footer">↑↓ 选择 · ↵ 打开 · Esc 关闭 · 全文检索 P3 上线</div>
      </div>
    </div>
  );
}
