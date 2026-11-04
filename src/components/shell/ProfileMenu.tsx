"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { usePermission } from "@/components/permissions/usePermission";
import {
  ChevronIcon,
  InboxIcon,
  LogoutIcon,
  SettingsIcon,
  ShieldIcon,
  UserIcon,
} from "@/components/ui/icons";
import { signOutAction } from "@/lib/auth/actions";

interface ProfileMenuProps {
  email: string;
  name: string;
  accessLevel: string | null;
}

export function ProfileMenu({ email, name, accessLevel }: ProfileMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { can, level } = usePermission();
  const [open, setOpen] = useState(false);

  const canViewProfile = can("profile:view_self");
  const canReadAudit = can("audit:read");
  const canManageMembers = can("member:manage");
  const canManagePermissions = level === "L1";

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
        <ChevronIcon className={`chevron${open ? " is-open" : ""}`} size={12} strokeWidth={1.4} />
      </button>

      {open ? (
        <div className="menu menu-up" role="menu">
          <div className="menu-header">
            <span className="menu-name">{name || "未命名账号"}</span>
            <span className="menu-email">{email}</span>
          </div>
          <Link href="/health" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
            <SettingsIcon className="menu-icon" />
            设置
          </Link>
          {canViewProfile ? (
            <Link href="/me/profile" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
              <UserIcon className="menu-icon" />
              个人资料
            </Link>
          ) : null}
          {canManageMembers ? (
            <Link
              href="/me/approvals"
              role="menuitem"
              className="menu-item"
              onClick={() => setOpen(false)}
            >
              <InboxIcon className="menu-icon" />
              审批中心
            </Link>
          ) : null}
          {canManagePermissions ? (
            <Link
              href="/settings/permissions"
              role="menuitem"
              className="menu-item"
              onClick={() => setOpen(false)}
            >
              <ShieldIcon className="menu-icon" />
              权限管理
            </Link>
          ) : null}
          <Link href="/me/permissions" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
            <UserIcon className="menu-icon" />
            权限
          </Link>
          {canReadAudit ? (
            <Link href="/me/audit" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
              <ShieldIcon className="menu-icon" />
              审计日志
            </Link>
          ) : null}
          <div className="menu-sep" role="separator" />
          <form action={signOutAction} onSubmit={() => setOpen(false)}>
            <button type="submit" role="menuitem" className="menu-item menu-item-danger">
              <LogoutIcon className="menu-icon" />
              退出登录
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
