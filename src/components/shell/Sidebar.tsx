"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface NavItem {
  label: string;
  href?: string;
  phase?: string;
  icon: ReactNode;
}

function IconWorkbench() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.75" y="2.75" width="6" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11.25" y="2.75" width="6" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.75" y="11.25" width="6" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11.25" y="11.25" width="6" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconSparkles() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M9 3.2l1.25 3.3 3.3 1.25-3.3 1.25L9 12.3 7.75 9 4.45 7.75l3.3-1.25L9 3.2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14.6 11.4l.7 1.85 1.85.7-1.85.7-.7 1.85-.7-1.85-1.85-.7 1.85-.7.7-1.85Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconOrg() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7.6" y="2.6" width="4.8" height="3.8" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.4" y="13.4" width="4.8" height="3.8" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="12.8" y="13.4" width="4.8" height="3.8" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6.6v3.1M4.8 13.2v-1.7a1.8 1.8 0 0 1 1.8-1.8h6.8a1.8 1.8 0 0 1 1.8 1.8v1.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2.6l5.6 2.1v4.6c0 3.4-2.2 6.3-5.6 8.1-3.4-1.8-5.6-4.7-5.6-8.1V4.7L10 2.6Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7.7 9.9l1.6 1.6 3-3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { label: "工作台", phase: "P3", icon: <IconWorkbench /> },
  { label: "AI 员工", phase: "P2", icon: <IconSparkles /> },
  { label: "组织与岗位", href: "/org/positions", icon: <IconOrg /> },
  { label: "权限与审计", href: "/me/permissions", icon: <IconShield /> },
];

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
          const active = item.href ? pathname === item.href || pathname.startsWith(`${item.href}/`) : false;

          if (!item.href) {
            return (
              <span key={item.label} className="nav-item is-disabled" aria-disabled="true">
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
                <span className="nav-tag">{item.phase}</span>
              </span>
            );
          }

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
        私有化部署 · P1
      </div>
    </aside>
  );
}
