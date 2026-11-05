"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { usePermission } from "@/components/permissions/usePermission";
import { BellIcon, CloseIcon, KnowledgeIcon, MenuIcon, SearchIcon } from "@/components/ui/icons";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { DepartmentSwitcher, type DepartmentOption } from "@/components/shell/DepartmentSwitcher";
import { ProfileMenu } from "@/components/shell/ProfileMenu";

interface ShellProps {
  email: string;
  name: string;
  accessLevel: string | null;
  activeDepartmentId: string | null;
  memberships: DepartmentOption[];
  siteName: string;
  pendingApprovals: number;
  children: ReactNode;
}

export function Shell({
  email,
  name,
  accessLevel,
  activeDepartmentId,
  memberships,
  siteName,
  pendingApprovals,
  children,
}: ShellProps) {
  const { can } = usePermission();
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const knowledgeLink = can("knowledge:read") ? (
    <Link
      href="/knowledge"
      className={`nav-item${pathname.startsWith("/knowledge") ? " is-active" : ""}`}
      aria-current={pathname.startsWith("/knowledge") ? "page" : undefined}
    >
      <span className="nav-icon">
        <KnowledgeIcon size={18} />
      </span>
      <span className="nav-label">知识库</span>
    </Link>
  ) : null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-brand-text">{siteName}</span>
        </div>

        {/* 主侧边栏只承载主业务（AI 工作台 / Agent / 知识库）；管理入口收敛到顶栏与个人菜单 */}
        <nav className="sidebar-nav" aria-label="主导航">
          {knowledgeLink}
        </nav>

        <div className="sidebar-profile">
          <DepartmentSwitcher
            activeDepartmentId={activeDepartmentId}
            memberships={memberships}
          />
          <ProfileMenu email={email} name={name} accessLevel={accessLevel} />
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <div className="topbar-inner">
            <span className="topbar-logo">{siteName}</span>

            <button
              type="button"
              className="search"
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
              aria-label="打开全局搜索"
            >
              <SearchIcon className="search-icon" />
              <span className="search-label">搜索岗位、成员、审计</span>
              <kbd className="search-kbd" title="⌘K / Ctrl K">
                ⌘K
              </kbd>
            </button>

            {can("member:manage") ? (
              <Link
                href="/me/approvals"
                className="topbar-bell"
                aria-label={
                  pendingApprovals > 0 ? `审批中心，${pendingApprovals} 条待审批` : "审批中心"
                }
                title="审批中心"
              >
                <BellIcon size={18} />
                {pendingApprovals > 0 ? (
                  <span className="topbar-bell-count">
                    {pendingApprovals > 99 ? "99+" : pendingApprovals}
                  </span>
                ) : null}
              </Link>
            ) : null}

            <button
              type="button"
              className="burger"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开导航菜单"
              aria-expanded={drawerOpen}
            >
              <MenuIcon size={18} />
            </button>
          </div>
        </header>

        <main className="app-main">{children}</main>
      </div>

      {drawerOpen ? (
        <div className="drawer-layer">
          <button
            type="button"
            className="drawer-backdrop"
            aria-label="关闭导航菜单"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="导航">
            <div className="drawer-header">
              <span className="sidebar-brand-text">{siteName}</span>
              <button type="button" className="drawer-close" aria-label="关闭" onClick={() => setDrawerOpen(false)}>
                <CloseIcon size={18} />
              </button>
            </div>

            <button
              type="button"
              className="drawer-search"
              onClick={() => {
                setDrawerOpen(false);
                setPaletteOpen(true);
              }}
              aria-haspopup="dialog"
              aria-label="打开全局搜索"
            >
              <SearchIcon className="search-icon" />
              <span className="search-label">搜索岗位、成员或页面</span>
            </button>

            <nav className="sidebar-nav" aria-label="移动导航">
              {knowledgeLink}
            </nav>

            <div className="drawer-bottom">
              <div className="sidebar-footer">
                <span className="sidebar-dot" aria-hidden="true" />
                私有化部署
              </div>
              <DepartmentSwitcher
                activeDepartmentId={activeDepartmentId}
                memberships={memberships}
              />
              <ProfileMenu email={email} name={name} accessLevel={accessLevel} />
            </div>
          </aside>
        </div>
      ) : null}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
