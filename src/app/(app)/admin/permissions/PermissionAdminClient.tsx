"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { NoticeBar } from "@/components/ui/notice-bar";
import type {
  AdminGrant,
  AdminGrantMap,
  AdminMember,
  AdminModule,
  AdminTemplate,
} from "@/types/permission-admin";
import type { PermissionKey, PermissionScope } from "@/types/permission";
import type { AccessLevel } from "@/types/profile";

import { MemberPanel } from "./MemberPanel";
import { TemplatePanel } from "./TemplatePanel";
import { defaultScope } from "./parts";
import { resetMemberGrants, saveMemberGrants, saveTemplateGrants } from "./actions";

type AdminMode = "roles" | "grants";

type PendingConfirm =
  | { kind: "template"; level: AccessLevel }
  | { kind: "member"; userId: string }
  | { kind: "reset" }
  | null;

function buildTemplateMap(templates: AdminTemplate[]): Record<AccessLevel, AdminGrantMap> {
  const find = (level: AccessLevel) => {
    const template = templates.find((item) => item.level === level);
    return template ? { ...template.grants } : {};
  };
  return { L1: find("L1"), L2: find("L2"), L3: find("L3") };
}

function buildMemberMap(members: AdminMember[]): Record<string, AdminGrantMap> {
  const map: Record<string, AdminGrantMap> = {};
  for (const member of members) {
    map[member.userId] = { ...member.grants };
  }
  return map;
}

function grantsEqual(a: AdminGrantMap, b: AdminGrantMap): boolean {
  const aKeys = Object.keys(a) as PermissionKey[];
  const bKeys = Object.keys(b) as PermissionKey[];
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return Boolean(left && right && left.scope === right.scope && left.effect === right.effect);
  });
}

export function PermissionAdminClient({
  mode,
  modules,
  templates,
  members,
  currentUserId,
  ceilings,
}: {
  mode: AdminMode;
  modules: AdminModule[];
  templates: AdminTemplate[];
  members: AdminMember[];
  currentUserId: string;
  ceilings: Record<AccessLevel, readonly PermissionKey[]>;
}) {
  const router = useRouter();
  const [templateLevel, setTemplateLevel] = useState<AccessLevel>("L2");
  const [templateSearch, setTemplateSearch] = useState("");
  const [collapsedModules, setCollapsedModules] = useState<ReadonlySet<string>>(new Set());

  const [savedTemplates, setSavedTemplates] = useState<Record<AccessLevel, AdminGrantMap>>(() =>
    buildTemplateMap(templates),
  );
  const [templateDrafts, setTemplateDrafts] = useState<Record<AccessLevel, AdminGrantMap>>(() =>
    buildTemplateMap(templates),
  );
  const [savedMemberGrants, setSavedMemberGrants] = useState<Record<string, AdminGrantMap>>(() =>
    buildMemberMap(members),
  );
  const [memberDrafts, setMemberDrafts] = useState<Record<string, AdminGrantMap>>(() =>
    buildMemberMap(members),
  );

  const initialMemberId =
    members.find((member) => member.level !== "L1")?.userId ?? members[0]?.userId ?? "";
  const [selectedMemberId, setSelectedMemberId] = useState(initialMemberId);

  const [pending, setPending] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirming, setConfirming] = useState<PendingConfirm>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const selectedMember = members.find((member) => member.userId === selectedMemberId) ?? null;
  const activeTemplate = templates.find((template) => template.level === templateLevel) ?? null;

  const templateDraft = templateDrafts[templateLevel] ?? {};
  const savedTemplateDraft = savedTemplates[templateLevel] ?? {};
  const memberDraft = memberDrafts[selectedMemberId] ?? {};
  const savedMemberDraft = savedMemberGrants[selectedMemberId] ?? {};

  const templateDirty = !grantsEqual(templateDraft, savedTemplateDraft);
  const memberDirty = !grantsEqual(memberDraft, savedMemberDraft);
  const dirty = mode === "roles" ? templateDirty : memberDirty;

  const nodesByKey = useMemo(() => {
    const map = new Map<PermissionKey, AdminModule["nodes"][number]>();
    for (const module of modules) {
      for (const node of module.nodes) {
        map.set(node.key, node);
      }
    }
    return map;
  }, [modules]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function changeTemplateLevel(level: AccessLevel) {
    if (level === templateLevel) {
      return;
    }
    if (templateDirty) {
      setConfirming({ kind: "template", level });
      return;
    }
    setTemplateLevel(level);
    setNotice(null);
  }

  function selectMember(userId: string) {
    if (userId === selectedMemberId) {
      return;
    }
    if (memberDirty) {
      setConfirming({ kind: "member", userId });
      return;
    }
    setSelectedMemberId(userId);
    setNotice(null);
  }

  function updateTemplateGrant(key: PermissionKey, grant: AdminGrant | null) {
    setTemplateDrafts((current) => {
      const next = { ...current[templateLevel] };
      if (grant) {
        next[key] = grant;
      } else {
        delete next[key];
      }
      return { ...current, [templateLevel]: next };
    });
  }

  function updateMemberGrant(key: PermissionKey, grant: AdminGrant | null) {
    setMemberDrafts((current) => {
      const next = { ...(current[selectedMemberId] ?? {}) };
      if (grant) {
        next[key] = grant;
      } else {
        delete next[key];
      }
      return { ...current, [selectedMemberId]: next };
    });
  }

  function toggleTemplateNode(key: PermissionKey, enabled: boolean) {
    const node = nodesByKey.get(key);
    if (!node) {
      return;
    }
    updateTemplateGrant(key, enabled ? { scope: defaultScope(node), effect: "allow" } : null);
  }

  function changeTemplateScope(key: PermissionKey, scope: PermissionScope) {
    const current = templateDrafts[templateLevel]?.[key];
    if (!current) {
      return;
    }
    updateTemplateGrant(key, { ...current, scope });
  }

  function changeMemberMode(key: PermissionKey, mode: "inherit" | "allow" | "deny") {
    if (!selectedMember || selectedMember.level === "L1") {
      return;
    }
    const node = nodesByKey.get(key);
    if (!node) {
      return;
    }
    if (mode === "inherit") {
      updateMemberGrant(key, null);
      return;
    }
    const existing = memberDraft[key];
    const templateGrant = savedTemplates[selectedMember.level]?.[key];
    const fallbackScope =
      existing?.scope ??
      (templateGrant?.effect === "allow" ? templateGrant.scope : undefined) ??
      defaultScope(node);
    updateMemberGrant(key, { scope: fallbackScope, effect: mode });
  }

  function changeMemberScope(key: PermissionKey, scope: PermissionScope) {
    const current = memberDraft[key];
    if (!current) {
      return;
    }
    updateMemberGrant(key, { ...current, scope });
  }

  async function handleSaveTemplate() {
    if (!activeTemplate || templateLevel === "L1" || pending) {
      return;
    }
    const allowed = new Set(ceilings[templateLevel]);
    const grants = (Object.entries(templateDraft) as Array<[PermissionKey, AdminGrant]>)
      .filter(([permissionKey]) => allowed.has(permissionKey))
      .map(([permissionKey, grant]) => ({
        permissionKey,
        scope: grant.scope,
        effect: grant.effect,
      }));

    setPending("template");
    try {
      const result = await saveTemplateGrants({ templateId: activeTemplate.id, grants });
      if (result.ok) {
        const savedMap = Object.fromEntries(
          grants.map((grant) => [grant.permissionKey, { scope: grant.scope, effect: grant.effect }]),
        ) as AdminGrantMap;
        setSavedTemplates((current) => ({ ...current, [templateLevel]: savedMap }));
        setTemplateDrafts((current) => ({ ...current, [templateLevel]: savedMap }));
        setNotice({
          kind: "info",
          text: "角色权限已更新，已登录的相关用户将在下一次页面刷新或重新加载时生效",
        });
        router.refresh();
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setPending(null);
    }
  }

  async function handleSaveMember() {
    if (!selectedMember || selectedMember.level === "L1" || pending) {
      return;
    }
    const allowed = new Set(ceilings[selectedMember.level]);
    const grants = (Object.entries(memberDraft) as Array<[PermissionKey, AdminGrant]>)
      .filter(([permissionKey]) => allowed.has(permissionKey) && nodesByKey.get(permissionKey)?.grantable)
      .map(([permissionKey, grant]) => ({
        permissionKey,
        scope: grant.scope,
        effect: grant.effect,
      }));

    setPending("member");
    try {
      const result = await saveMemberGrants({ userId: selectedMember.userId, grants });
      if (result.ok) {
        const savedMap = Object.fromEntries(
          grants.map((grant) => [grant.permissionKey, { scope: grant.scope, effect: grant.effect }]),
        ) as AdminGrantMap;
        setSavedMemberGrants((current) => ({
          ...current,
          [selectedMember.userId]: savedMap,
        }));
        setMemberDrafts((current) => ({
          ...current,
          [selectedMember.userId]: savedMap,
        }));
        setNotice({ kind: "info", text: result.message });
        router.refresh();
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setPending(null);
    }
  }

  function requestResetMember() {
    if (!selectedMember || selectedMember.level === "L1" || resetting) {
      return;
    }
    setConfirming({ kind: "reset" });
  }

  async function performResetMember() {
    if (!selectedMember || selectedMember.level === "L1" || resetting) {
      return;
    }

    setResetting(true);
    try {
      const result = await resetMemberGrants({ userId: selectedMember.userId });
      if (result.ok) {
        setMemberDrafts((current) => ({ ...current, [selectedMember.userId]: {} }));
        setSavedMemberGrants((current) => ({ ...current, [selectedMember.userId]: {} }));
        setNotice({ kind: "info", text: result.message });
        router.refresh();
      } else {
        setNotice({ kind: "error", text: result.message });
      }
    } finally {
      setResetting(false);
    }
  }

  function discardChanges() {
    if (mode === "roles") {
      setTemplateDrafts((current) => ({
        ...current,
        [templateLevel]: { ...savedTemplates[templateLevel] },
      }));
    } else {
      setMemberDrafts((current) => ({
        ...current,
        [selectedMemberId]: { ...savedMemberGrants[selectedMemberId] },
      }));
    }
    setNotice(null);
  }

  function saveActiveTab() {
    if (mode === "roles") {
      void handleSaveTemplate();
    } else {
      void handleSaveMember();
    }
  }

  const confirmCopy =
    confirming?.kind === "template"
      ? {
          title: "放弃未保存的模板更改？",
          description: "当前角色模板有未保存的更改，切换等级后将丢失这些更改。",
          confirmLabel: "放弃并切换",
        }
      : confirming?.kind === "member"
        ? {
            title: "放弃未保存的授权更改？",
            description: "当前成员有未保存的授权更改，切换成员后将丢失这些更改。",
            confirmLabel: "放弃并切换",
          }
        : confirming?.kind === "reset"
          ? {
              title: "恢复默认权限？",
              description: `确定恢复「${selectedMember?.name?.trim() || selectedMember?.phone || "该成员"}」为角色模板默认权限吗？`,
              confirmLabel: "恢复默认",
            }
          : null;

  function handleConfirm() {
    const current = confirming;
    setConfirming(null);
    if (!current) {
      return;
    }
    if (current.kind === "template") {
      setTemplateLevel(current.level);
      setNotice(null);
      return;
    }
    if (current.kind === "member") {
      setSelectedMemberId(current.userId);
      setNotice(null);
      return;
    }
    void performResetMember();
  }

  return (
    <div className="perm-root">
      {notice ? (
        <NoticeBar kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </NoticeBar>
      ) : null}

      {mode === "roles" ? (
        <>
          <div className="perm-toolbar">
            <div className="perm-segmented" role="group" aria-label="角色等级">
              {(["L1", "L2", "L3"] as AccessLevel[]).map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`perm-segment${templateLevel === level ? " is-active" : ""}`}
                  onClick={() => changeTemplateLevel(level)}
                >
                  {level === "L1" ? "L1 老板" : level === "L2" ? "L2 管理者" : "L3 成员"}
                </button>
              ))}
            </div>
            <p className="perm-toolbar-hint">
              {templateLevel === "L1"
                ? "L1 默认拥有全部非保护区权限，模板只读。"
                : "只显示该等级上限内的节点；写类动作不能使用「本部门及子部门」。"}
            </p>
          </div>

          <TemplatePanel
            modules={modules}
            ceiling={ceilings[templateLevel]}
            draft={templateLevel === "L1" ? savedTemplates.L1 : templateDraft}
            readOnly={templateLevel === "L1"}
            search={templateSearch}
            onSearch={setTemplateSearch}
            collapsed={collapsedModules}
            onToggleModule={(moduleKey) =>
              setCollapsedModules((current) => {
                const next = new Set(current);
                if (next.has(moduleKey)) {
                  next.delete(moduleKey);
                } else {
                  next.add(moduleKey);
                }
                return next;
              })
            }
            onToggleNode={toggleTemplateNode}
            onScopeChange={changeTemplateScope}
          />
        </>
      ) : (
        <MemberPanel
          modules={modules}
          ceilings={ceilings}
          members={members.map((member) =>
            member.userId === currentUserId
              ? { ...member, name: `${member.name || member.phone || "我"}（我）` }
              : member,
          )}
          templates={savedTemplates}
          selectedMemberId={selectedMemberId}
          draft={memberDraft}
          onSelectMember={selectMember}
          onModeChange={changeMemberMode}
          onScopeChange={changeMemberScope}
          onReset={requestResetMember}
          resetting={resetting}
        />
      )}

      {dirty ? (
        <div className="perm-savebar">
          <div className="perm-savebar-text">
            <strong>未保存的更改</strong>
            <span>
              {mode === "roles"
                ? `角色模板 ${templateLevel}`
                : `成员「${selectedMember?.name || selectedMember?.phone || ""}」`}
            </span>
          </div>
          <div className="perm-savebar-actions">
            <button type="button" className="button button-ghost" onClick={discardChanges}>
              放弃
            </button>
            <button
              type="button"
              className="button"
              onClick={saveActiveTab}
              disabled={pending !== null || (mode === "roles" && templateLevel === "L1")}
            >
              {pending === "template" || pending === "member" ? "保存中…" : "保存更改"}
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={confirmCopy?.title ?? ""}
        description={confirmCopy?.description}
        confirmLabel={confirmCopy?.confirmLabel}
        danger={confirming?.kind === "reset"}
        pending={resetting}
        onConfirm={handleConfirm}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
