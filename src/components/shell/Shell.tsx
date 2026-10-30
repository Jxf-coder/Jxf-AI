"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { CommandPalette } from "@/components/shell/CommandPalette";
import { ProfileMenu } from "@/components/shell/ProfileMenu";

interface ShellProps {
  email: string;
  name: string;
  accessLevel: string | null;
  siteName: string;
  children: ReactNode;
}

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
}

function IconOrg() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7.6" y="2.6" width="4.8" height="3.8" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.4" y="13.4" width="4.8" height="3.8" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="12.8" y="13.4" width="4.8" height="3.8" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 6.6v3.1M4.8 13.2v-1.7a1.8 1.8 0 0 1 1.8-1.8h6.8a1.8 1.8 0 0 1 1.8 1.8v1.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg className="search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="5.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.2 13.2l3.4 3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** 只放已经落地的入口；未开发的功能不占位，避免出现空壳项 */
const NAV_ITEMS: NavItem[] = [{ label: "组织与岗位", href: "/org/positions", icon: <IconOrg /> }];

export function Shell({ email, name, accessLevel, siteName, children }: ShellProps) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
          {NAV_ITEMS.map((item) => renderNavItem(item))}
        </nav>

        <div className="sidebar-profile">
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
              <IconSearch />
              <span className="search-label">搜索岗位、成员、审计</span>
              <kbd className="search-kbd" title="⌘K / Ctrl K">
                ⌘K
              </kbd>
            </button>

            <button
              type="button"
              className="burger"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开导航菜单"
              aria-expanded={drawerOpen}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3.2 6h13.6M3.2 10h13.6M3.2 14h13.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
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
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M5.6 5.6l8.8 8.8M14.4 5.6l-8.8 8.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
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
              <IconSearch />
              <span className="search-label">搜索岗位、成员或页面</span>
            </button>

            <nav className="sidebar-nav" aria-label="主导航">
              {NAV_ITEMS.map((item) => renderNavItem(item))}
            </nav>

            <div className="drawer-bottom">
              <div className="sidebar-footer">
                <span className="sidebar-dot" aria-hidden="true" />
                私有化部署
              </div>
              <ProfileMenu email={email} name={name} accessLevel={accessLevel} />
            </div>
          </aside>
        </div>
      ) : null}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
