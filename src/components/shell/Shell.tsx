"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { usePermission } from "@/components/permissions/usePermission";
import { BrandMark } from "@/components/brand/BrandMark";
import { AiIcon, BellIcon, ChatIcon, CloseIcon, KnowledgeIcon, LayersIcon, MenuIcon, PlugIcon, SearchIcon, SkillIcon } from "@/components/ui/icons";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { DepartmentSwitcher, type DepartmentOption } from "@/components/shell/DepartmentSwitcher";
import { ProfileMenu } from "@/components/shell/ProfileMenu";

interface ShellProps {
  email: string;
  name: string;
  siteName: string;
  accessLevel: string | null;
  activeDepartmentId: string | null;
  memberships: DepartmentOption[];
  pendingApprovals: number;
  pendingWorkReviews: number;
  children: ReactNode;
}

export function Shell({
  email,
  name,
  siteName,
  accessLevel,
  activeDepartmentId,
  memberships,
  pendingApprovals,
  pendingWorkReviews,
  children,
}: ShellProps) {
  const { can } = usePermission();
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const chatLink = can("skill:use") ? (
    <Link
      href="/chat"
      className={`nav-item nav-item-primary${pathname.startsWith("/chat") ? " is-active" : ""}`}
      aria-current={pathname.startsWith("/chat") ? "page" : undefined}
    >
      <span className="nav-icon">
        <ChatIcon size={18} />
      </span>
      <span className="nav-label">Agent</span>
    </Link>
  ) : null;

  const mcpLink = can("token:issue") ? (
    <Link
      href="/settings/mcp"
      className={`nav-item${pathname.startsWith("/settings/mcp") ? " is-active" : ""}`}
      aria-current={pathname.startsWith("/settings/mcp") ? "page" : undefined}
    >
      <span className="nav-icon">
        <PlugIcon size={18} />
      </span>
      <span className="nav-label">MCP 连接</span>
    </Link>
  ) : null;

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

  const pipelinesLink = can("pipeline:use") ? (
    <Link
      href="/pipelines"
      className={`nav-item${pathname.startsWith("/pipelines") ? " is-active" : ""}`}
      aria-current={pathname.startsWith("/pipelines") ? "page" : undefined}
    >
      <span className="nav-icon">
        <LayersIcon size={18} />
      </span>
      <span className="nav-label">自动化</span>
    </Link>
  ) : null;

  const skillsLink = can("skill:use") ? (
    <Link
      href="/skills"
      className={`nav-item${pathname.startsWith("/skills") ? " is-active" : ""}`}
      aria-current={pathname.startsWith("/skills") ? "page" : undefined}
    >
      <span className="nav-icon">
        <SkillIcon size={18} />
      </span>
      <span className="nav-label">Skill</span>
    </Link>
  ) : null;

  const aiEmployeesLink = (
    <Link
      href="/ai-employees"
      className={`nav-item${pathname.startsWith("/ai-employees") ? " is-active" : ""}`}
      aria-current={pathname.startsWith("/ai-employees") ? "page" : undefined}
    >
      <span className="nav-icon">
        <AiIcon size={18} />
      </span>
      <span className="nav-label">AI 员工</span>
      {pendingWorkReviews > 0 ? (
        <span className="nav-badge">{pendingWorkReviews > 99 ? "99+" : pendingWorkReviews}</span>
      ) : null}
    </Link>
  );

  const navContent = (
    <>
      {chatLink}
      {mcpLink}
      <div className="nav-section">
        <p className="nav-section-label">Workspace</p>
        {knowledgeLink}
        {skillsLink}
        {pipelinesLink}
      </div>
      <div className="nav-section">
        <p className="nav-section-label">AI Employees</p>
        {aiEmployeesLink}
      </div>
    </>
  );

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
          <BrandMark size="md" label={siteName} />
        </div>

        {/* 主侧边栏只承载主业务（Agent / 知识库）；管理入口收敛到顶栏与个人菜单 */}
        <nav className="sidebar-nav" aria-label="主导航">
          {navContent}
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
            <span className="topbar-logo">
              <BrandMark size="sm" label={siteName} />
            </span>

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
              <BrandMark size="sm" label={siteName} />
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
              {navContent}
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
