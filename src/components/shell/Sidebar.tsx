"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
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

/** 只放已经落地的入口；未开发的功能不占位，避免侧边栏出现空壳项 */
const NAV_ITEMS: NavItem[] = [{ label: "组织与岗位", href: "/org/positions", icon: <IconOrg /> }];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark" aria-hidden="true" />
        <span className="sidebar-brand-text">Jxf-AI</span>
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <Link
              key={item.label}
              href={item.href}
              className={`nav-item${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <span className="sidebar-dot" aria-hidden="true" />
        私有化部署
      </div>
    </aside>
  );
}
