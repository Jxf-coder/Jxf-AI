"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { usePermission } from "@/components/permissions/usePermission";
import {
  BellIcon,
  CloseIcon,
  InboxIcon,
  MenuIcon,
  OrgIcon,
  SearchIcon,
  ShieldIcon,
} from "@/components/ui/icons";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { DepartmentSwitcher, type DepartmentOption } from "@/components/shell/DepartmentSwitcher";
import { ProfileMenu } from "@/components/shell/ProfileMenu";
import type { PermissionKey } from "@/types/permission";
import type { AccessLevel } from "@/types/profile";

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

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  /** 无该权限时隐藏导航入口 */
  permission?: PermissionKey;
  /** 仅指定等级可见（用于 L1 专属的权限管理） */
  requiresLevel?: AccessLevel;
}

/** 只放已经落地的入口；未开发的功能不占位，避免出现空壳项 */
const NAV_ITEMS: NavItem[] = [
  { label: "组织架构", href: "/org/positions", icon: <OrgIcon size={18} />, permission: "org:view" },
  {
    label: "审批中心",
    href: "/me/approvals",
    icon: <InboxIcon size={18} />,
    permission: "member:manage",
  },
  {
    label: "权限管理",
    href: "/settings/permissions",
    icon: <ShieldIcon size={18} />,
    requiresLevel: "L1",
  },
];

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
  const pathname = usePathname();
  const { can, level } = usePermission();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const visibleNavItems = NAV_ITEMS.filter(
    (item) =>
      (!item.permission || can(item.permission)) &&
      (!item.requiresLevel || item.requiresLevel === level),
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

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function renderNavItem(item: NavItem) {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`nav-item${active ? " is-active" : ""}`}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        onClick={() => setDrawerOpen(false)}
      >
        <span className="nav-icon">{item.icon}</span>
        <span className="nav-label">{item.label}</span>
      </Link>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-brand-text">{siteName}</span>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {visibleNavItems.map((item) => renderNavItem(item))}
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

            <nav className="sidebar-nav" aria-label="主导航">
              {visibleNavItems.map((item) => renderNavItem(item))}
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
