"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { signOutAction } from "@/lib/auth/actions";

interface ProfileMenuProps {
  email: string;
  name: string;
  accessLevel: string | null;
  /** up：侧边栏底部向上弹出；down：手机顶栏向下弹出 */
  placement: "up" | "down";
}

function IconSettings() {
  return (
    <svg className="menu-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 3.4v1.5M10 15.1v1.5M3.4 10h1.5M15.1 10h1.5M5.3 5.3l1.1 1.1M13.6 13.6l1.1 1.1M14.7 5.3l-1.1 1.1M6.4 13.6l-1.1 1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconUser() {
  return (
    <svg className="menu-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="7" r="2.9" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4.8 16.2c.6-2.5 2.6-4 5.2-4s4.6 1.5 5.2 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconShield() {
  return (
    <svg className="menu-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
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

function IconLogOut() {
  return (
    <svg className="menu-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M11.2 3.4H6.1a1.9 1.9 0 0 0-1.9 1.9v9.4a1.9 1.9 0 0 0 1.9 1.9h5.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M13 7l3 3-3 3M16 10H8.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ProfileMenu({ email, name, accessLevel, placement }: ProfileMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const initial = (name || email || "J").trim().charAt(0).toUpperCase();

  return (
    <div className="profile" ref={rootRef}>
      <button
        type="button"
        className={`profile-trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="个人菜单"
        title={name || email}
      >
        <span className="avatar">{initial}</span>
        <span className="profile-meta">
          <span className="profile-name">{name || "未命名账号"}</span>
          {accessLevel ? <span className="badge badge-accent">{accessLevel}</span> : null}
        </span>
        <svg className="chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className={`menu menu-${placement}`} role="menu">
          <div className="menu-header">
            <span className="menu-name">{name || "未命名账号"}</span>
            <span className="menu-email">{email}</span>
          </div>
          <Link href="/health" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
            <IconSettings />
            设置
          </Link>
          <Link href="/me/permissions" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
            <IconUser />
            权限
          </Link>
          <Link href="/me/permissions#audit" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
            <IconShield />
            审计
          </Link>
          <div className="menu-sep" role="separator" />
          <form action={signOutAction} onSubmit={() => setOpen(false)}>
            <button type="submit" role="menuitem" className="menu-item menu-item-danger">
              <IconLogOut />
              退出登录
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
