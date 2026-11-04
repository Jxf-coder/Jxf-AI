"use client";

import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { NoticeBar } from "@/components/ui/notice-bar";
import { Select } from "@/components/ui/select";
import type {
  AccessLevel,
  ProfilePermissions,
  UserMembershipSummary,
  UserProfile,
} from "@/types/profile";

import {
  addEmailIdentity,
  removeEmailIdentity,
  setPrimaryEmailIdentity,
  updateCoreProfile,
  updateMembershipAssignment,
} from "./actions";

interface DepartmentOption {
  id: string;
  name: string;
  parentId: string | null;
}

interface Notice {
  kind: "info" | "error";
  text: string;
}

function LevelBadge({ level }: { level: AccessLevel }) {
  return (
    <span className={`badge level-${level.toLowerCase()}`}>{level === "L1" ? "老板" : level}</span>
  );
}

export function ProfileClient({
  profile,
  permissions,
  departments,
}: {
  profile: UserProfile;
  permissions: ProfilePermissions;
  departments: DepartmentOption[];
}) {
  const [name, setName] = useState(profile.name);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [password, setPassword] = useState("");
  const [avatarDraft, setAvatarDraft] = useState<string | null | undefined>(undefined);
  const [emailInput, setEmailInput] = useState("");
  const [titleDraft, setTitleDraft] = useState<Record<string, string>>({});
  const [deptDraft, setDeptDraft] = useState<Record<string, string>>({});
  const [levelDraft, setLevelDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const avatarSrc = avatarDraft === undefined ? profile.avatarUrl : avatarDraft;
  const initial = (name || profile.phone || "J").trim().charAt(0).toUpperCase();
  const phoneChanged = phone.replace(/[\s-]/g, "") !== (profile.phone ?? "");

  function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setNotice({ kind: "error", text: "头像仅支持 PNG / JPEG / WebP" });
      return;
    }
    if (file.size > 300 * 1024) {
      setNotice({ kind: "error", text: "头像图片需小于 300KB" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setAvatarDraft(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleCoreSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!permissions.canEditCore) {
      return;
    }
    const formData = new FormData();
    formData.set("targetUserId", profile.id);
    formData.set("name", name);
    formData.set("phone", phone);
    if (password) {
      formData.set("currentPassword", password);
    }
    if (avatarDraft !== undefined) {
      formData.set("avatar", avatarDraft ?? "");
    }

    setPending("core");
    try {
      const result = await updateCoreProfile(formData);
      if (result.ok) {
        setNotice({ kind: "info", text: "核心资料已保存" });
        setAvatarDraft(undefined);
        setPassword("");
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setPending(null);
    }
  }

  async function handleAddEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!permissions.canEditCore || !emailInput.trim()) {
      return;
    }
    const formData = new FormData();
    formData.set("targetUserId", profile.id);
    formData.set("email", emailInput.trim());

    setPending("email-add");
    try {
      const result = await addEmailIdentity(formData);
      if (result.ok) {
        setNotice({ kind: "info", text: `已添加邮箱「${emailInput.trim()}」` });
        setEmailInput("");
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setPending(null);
    }
  }

  async function handleSetPrimary(identityId: string, email: string) {
    if (!permissions.canEditCore) {
      return;
    }
    const formData = new FormData();
    formData.set("targetUserId", profile.id);
    formData.set("identityId", identityId);

    setPending(`primary-${identityId}`);
    try {
      const result = await setPrimaryEmailIdentity(formData);
      if (result.ok) {
        setNotice({ kind: "info", text: `已将「${email}」设为默认主邮箱` });
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setPending(null);
    }
  }

  async function handleRemoveEmail(identityId: string, email: string) {
    if (!permissions.canEditCore) {
      return;
    }
    const formData = new FormData();
    formData.set("targetUserId", profile.id);
    formData.set("identityId", identityId);

    setPending(`remove-${identityId}`);
    try {
      const result = await removeEmailIdentity(formData);
      if (result.ok) {
        setNotice({ kind: "info", text: `已解绑邮箱「${email}」` });
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setPending(null);
    }
  }

  async function handleMembershipSubmit(
    event: FormEvent<HTMLFormElement>,
    membership: UserMembershipSummary,
  ) {
    event.preventDefault();
    if (!permissions.canEditTitle && !permissions.canEditOrg) {
      return;
    }
    const formData = new FormData();
    formData.set("membershipId", membership.id);
    formData.set("title", titleDraft[membership.id] ?? membership.title);
    formData.set("departmentId", deptDraft[membership.id] ?? membership.departmentId);
    formData.set("accessLevel", levelDraft[membership.id] ?? membership.accessLevel);

    setPending(`membership-${membership.id}`);
    try {
      const result = await updateMembershipAssignment(formData);
      if (result.ok) {
        setNotice({ kind: "info", text: "组织与头衔已更新" });
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      {notice ? (
        <NoticeBar kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </NoticeBar>
      ) : null}

      <section className="settings-group">
        <h2 className="settings-group-title">核心资料</h2>
        <form className="settings-card" onSubmit={handleCoreSubmit}>
          <div className="settings-row">
            <span className="settings-label">头像</span>
            <div className="settings-value profile-avatar-row">
              <span className="profile-avatar">
                {avatarSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarSrc} alt="成员头像" />
                ) : (
                  <span>{initial}</span>
                )}
              </span>
              {permissions.canEditCore ? (
                <>
                  <label className="button button-secondary profile-upload">
                    上传 / 更换头像
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleAvatarChange}
                      hidden
                    />
                  </label>
                  {avatarSrc ? (
                    <button
                      type="button"
                      className="link-danger"
                      onClick={() => setAvatarDraft(null)}
                    >
                      移除头像
                    </button>
                  ) : null}
                  <span className="settings-hint">支持 PNG / JPEG / WebP，小于 300KB</span>
                </>
              ) : (
                <span className="lock-tag">🔒 只读</span>
              )}
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">姓名</span>
            <div className="settings-value">
              <input
                className="settings-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                placeholder="真实姓名"
                disabled={!permissions.canEditCore}
              />
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">手机号</span>
            <div className="settings-value">
              <input
                className="settings-input"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                inputMode="tel"
                maxLength={20}
                placeholder="13800000000"
                disabled={!permissions.canEditCore}
              />
              <p className="settings-hint">
                主账号唯一标识，可用于邮箱或手机号登录与身份绑定；修改后请使用新手机号登录。
              </p>
            </div>
          </div>

          {permissions.canEditCore && permissions.isSelf ? (
            <div className="settings-row">
              <span className="settings-label">当前密码</span>
              <div className="settings-value">
                <input
                  className="settings-input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={phoneChanged ? "修改手机号时需验证" : "仅修改手机号时需要"}
                  autoComplete="current-password"
                />
              </div>
            </div>
          ) : null}

          <div className="settings-actions">
            {!permissions.canEditCore ? (
              <span className="lock-tag">🔒 无编辑权限</span>
            ) : (
              <button type="submit" className="button" disabled={pending === "core"}>
                {pending === "core" ? "保存中…" : "保存核心资料"}
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="settings-group">
        <h2 className="settings-group-title">组织与头衔</h2>
        <div className="settings-card">
          {profile.memberships.length === 0 ? (
            <p className="settings-empty">暂无有效任用</p>
          ) : (
            profile.memberships.map((membership) => {
              const departmentValue = deptDraft[membership.id] ?? membership.departmentId;
              const levelValue = levelDraft[membership.id] ?? membership.accessLevel;
              const titleValue = titleDraft[membership.id] ?? membership.title;
              const editable = permissions.canEditTitle || permissions.canEditOrg;

              return (
                <form
                  key={membership.id}
                  className="membership-form"
                  onSubmit={(event) => handleMembershipSubmit(event, membership)}
                >
                  <div className="settings-row">
                    <span className="settings-label">所属部门</span>
                    <div className="settings-value">
                      {permissions.canEditOrg ? (
                        <Select
                          className="settings-select-wrap"
                          value={departmentValue}
                          options={departments.map((department) => ({
                            value: department.id,
                            label: department.name,
                          }))}
                          onValueChange={(next) =>
                            setDeptDraft((current) => ({
                              ...current,
                              [membership.id]: next,
                            }))
                          }
                        />
                      ) : (
                        <span className="settings-static">
                          {membership.departmentName} <span className="lock-tag">🔒</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="settings-row">
                    <span className="settings-label">业务岗位</span>
                    <div className="settings-value">
                      {permissions.canEditTitle ? (
                        <input
                          className="settings-input"
                          value={titleValue}
                          onChange={(event) =>
                            setTitleDraft((current) => ({
                              ...current,
                              [membership.id]: event.target.value,
                            }))
                          }
                          maxLength={40}
                          placeholder="例如：交付经理、架构师"
                        />
                      ) : (
                        <span className="settings-static">
                          {membership.title} <span className="lock-tag">🔒</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="settings-row">
                    <span className="settings-label">权限等级</span>
                    <div className="settings-value">
                      {permissions.canEditOrg ? (
                        <Select
                          className="settings-select-wrap"
                          value={levelValue}
                          options={[
                            { value: "L1", label: "L1 · 老板" },
                            { value: "L2", label: "L2 · 管理者" },
                            { value: "L3", label: "L3 · 普通成员" },
                          ]}
                          onValueChange={(next) =>
                            setLevelDraft((current) => ({
                              ...current,
                              [membership.id]: next,
                            }))
                          }
                        />
                      ) : (
                        <span className="settings-static">
                          <LevelBadge level={membership.accessLevel} />
                          <span className="lock-tag">🔒</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {editable ? (
                    <div className="settings-actions">
                      <button
                        type="submit"
                        className="button button-secondary"
                        disabled={pending === `membership-${membership.id}`}
                      >
                        {pending === `membership-${membership.id}` ? "保存中…" : "保存组织与头衔"}
                      </button>
                    </div>
                  ) : (
                    <div className="settings-actions">
                      <span className="lock-tag">🔒 仅 L1 可修改所属部门与权限等级</span>
                    </div>
                  )}
                </form>
              );
            })
          )}
        </div>
        <p className="settings-group-hint">
          业务岗位：L1 可改所有人，L2 仅可改下级 L3，L3 只读；所属部门与权限等级仅 L1 可修改。
        </p>
      </section>

      <section className="settings-group">
        <h2 className="settings-group-title">多邮箱与 CRM 通讯</h2>
        <div className="settings-card">
          {profile.emails.length === 0 ? (
            <p className="settings-empty">尚未绑定邮箱</p>
          ) : (
            profile.emails.map((identity) => (
              <div className="settings-row" key={identity.id}>
                <span className="settings-label">邮箱</span>
                <div className="settings-value email-line">
                  <span className="email-address">{identity.email}</span>
                  {identity.isPrimary ? (
                    <span className="badge badge-accent">默认主邮箱</span>
                  ) : (
                    <span className="badge">备用邮箱</span>
                  )}
                  {identity.verifiedAt ? (
                    <span className="badge badge-ok">已验证</span>
                  ) : (
                    <span className="badge">待验证</span>
                  )}
                </div>
                <div className="email-actions">
                  {permissions.canEditCore && !identity.isPrimary ? (
                    <>
                      <button
                        type="button"
                        className="link-action"
                        onClick={() => handleSetPrimary(identity.id, identity.email)}
                        disabled={pending === `primary-${identity.id}`}
                      >
                        设为主邮箱
                      </button>
                      <button
                        type="button"
                        className="link-danger"
                        onClick={() => handleRemoveEmail(identity.id, identity.email)}
                        disabled={pending === `remove-${identity.id}`}
                      >
                        移除
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ))
          )}

          <div className="settings-row">
            <span className="settings-label">添加邮箱</span>
            <div className="settings-value">
              {permissions.canEditCore ? (
                <form className="inline-form" onSubmit={handleAddEmail}>
                  <input
                    className="settings-input"
                    type="email"
                    value={emailInput}
                    onChange={(event) => setEmailInput(event.target.value)}
                    placeholder="project_a@jxf.com"
                    maxLength={254}
                    required
                  />
                  <button type="submit" className="button" disabled={pending === "email-add"}>
                    {pending === "email-add" ? "添加中…" : "添加"}
                  </button>
                </form>
              ) : (
                <span className="lock-tag">🔒 只读</span>
              )}
              <p className="settings-hint">
                可绑定多个业务 / 项目邮箱；默认主邮箱同时用于登录、系统发件与 CRM 消息同步。
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
