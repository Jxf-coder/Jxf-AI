"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { signOutAction } from "@/lib/auth/actions";

interface TopbarProps {
  email: string;
  name: string;
}

export function Topbar({ email, name }: TopbarProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }

    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  function onSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchNotice("全局搜索将在 P3 随运行态上线，当前仅支持岗位与权限页面内浏览。");
  }

  const initial = (name || email || "J").trim().charAt(0).toUpperCase();

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-spacer" aria-hidden="true" />

        <form className="search" role="search" onSubmit={onSearchSubmit}>
          <svg className="search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="5.4" stroke="currentColor" strokeWidth="1.6" />
            <path d="M13.2 13.2l3.4 3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            className="search-input"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchNotice(null);
            }}
            placeholder="搜索岗位、成员、审计"
            aria-label="全局搜索"
          />
          <kbd className="search-kbd" title="⌘K / Ctrl K">⌘K</kbd>
        </form>

        <div className="topbar-right" ref={menuRef}>
          <button
            type="button"
            className={`avatar-button${menuOpen ? " is-open" : ""}`}
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="个人菜单"
          >
            <span className="avatar">{initial}</span>
            <svg className="chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 4.5L6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {menuOpen ? (
            <div className="menu" role="menu">
              <div className="menu-header">
                <span className="menu-name">{name || "未命名账号"}</span>
                <span className="menu-email">{email}</span>
              </div>
              <Link
                href="/me/permissions"
                role="menuitem"
                className="menu-item"
                onClick={() => setMenuOpen(false)}
              >
                <span aria-hidden="true">👤</span>
                个人资料
              </Link>
              <Link href="/health" role="menuitem" className="menu-item" onClick={() => setMenuOpen(false)}>
                <span aria-hidden="true">⚙️</span>
                系统设置
              </Link>
              <Link
                href="/me/permissions#audit"
                role="menuitem"
                className="menu-item"
                onClick={() => setMenuOpen(false)}
              >
                <span aria-hidden="true">🛡️</span>
                安全审计
              </Link>
              <div className="menu-sep" role="separator" />
              <form action={signOutAction} onSubmit={() => setMenuOpen(false)}>
                <button type="submit" role="menuitem" className="menu-item menu-item-danger">
                  <span aria-hidden="true">🚪</span>
                  退出登录
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </div>

      {searchNotice ? (
        <p className="search-notice" role="status">
          {searchNotice}
        </p>
      ) : null}
    </header>
  );
}
