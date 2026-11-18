"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import {
  alert,
  badge,
  btnBlue,
  btnGhost,
  card,
  cardDesc,
  cardHead,
  cardTitle,
  emptyState,
  fieldLabel,
  formGrid,
  headerRow,
  input,
  meta,
  pageSubtitle,
  pageTitle,
  pageWrap,
} from "@/components/knowledge/tokens";
import { CRM_DICTIONARY_TYPES } from "@/lib/crm/dictionary";

import { removeHolderCap, saveCodeRule, saveDictionaryItem, saveHolderCap, savePoolPolicy } from "./actions";

export interface CodeRuleRow {
  codeType: string;
  label: string;
  prefix: string;
  configured: boolean;
}

export interface DictionaryItem {
  id: string;
  dictType: string;
  code: string;
  label: string;
  sort: number;
  enabled: boolean;
}

export interface PolicyRow {
  departmentId: string;
  departmentName: string;
  holderCap: number;
  managerHolderCap: number;
  keyGradeThreshold: number;
  keyPendingTtlDays: number;
  claimMode: string;
  configured: boolean;
  canWrite: boolean;
}

export interface HolderCapRow {
  userId: string;
  userName: string;
  holderCap: number | null;
  reason: string;
  validUntil: string | null;
}

export interface SettingsMember {
  id: string;
  name: string;
  departmentName: string;
}

const CLAIM_MODE_LABEL: Record<string, string> = {
  self: "自助领用",
  assign: "主管分配",
};

function formatDay(value: string | null): string {
  if (!value) {
    return "长期有效";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

type DictDialog = { mode: "create" } | { mode: "edit"; item: DictionaryItem } | null;
type PolicyDialog = PolicyRow | null;
type CapDialog = { userId: string; holderCap: string; reason: string; validUntil: string } | null;

export function CrmSettingsClient({
  dictionaries,
  policies,
  caps,
  members,
  dictTypes,
  codeRules,
  canDict,
  canPool,
  canCap,
  isL1,
}: {
  dictionaries: DictionaryItem[];
  policies: PolicyRow[];
  caps: HolderCapRow[];
  members: SettingsMember[];
  dictTypes: string[];
  codeRules: CodeRuleRow[];
  canDict: boolean;
  canPool: boolean;
  canCap: boolean;
  isL1: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const [dictDialog, setDictDialog] = useState<DictDialog>(null);
  const [dictType, setDictType] = useState("");
  const [dictCode, setDictCode] = useState("");
  const [dictLabel, setDictLabel] = useState("");
  const [dictSort, setDictSort] = useState("0");
  const [dictEnabled, setDictEnabled] = useState(true);

  const [policyDialog, setPolicyDialog] = useState<PolicyDialog>(null);
  const [policyHolderCap, setPolicyHolderCap] = useState("150");
  const [policyManagerCap, setPolicyManagerCap] = useState("500");
  const [policyThreshold, setPolicyThreshold] = useState("80");
  const [policyTtl, setPolicyTtl] = useState("7");
  const [policyClaimMode, setPolicyClaimMode] = useState("self");

  const [capDialog, setCapDialog] = useState<CapDialog>(null);
  const [removeTarget, setRemoveTarget] = useState<HolderCapRow | null>(null);

  const [codePrefixes, setCodePrefixes] = useState<Record<string, string>>(() =>
    Object.fromEntries(codeRules.map((rule) => [rule.codeType, rule.prefix])),
  );

  const dictEditable = canDict && isL1;

  const typeOptions = [
    ...CRM_DICTIONARY_TYPES.map((type) => ({
      value: type.key,
      label: `${type.label}（${type.key}）`,
    })),
    ...dictTypes
      .filter((type) => !CRM_DICTIONARY_TYPES.some((item) => item.key === type))
      .map((type) => ({ value: type, label: type })),
  ];

  const grouped = new Map<string, DictionaryItem[]>();
  for (const item of dictionaries) {
    const bucket = grouped.get(item.dictType);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(item.dictType, [item]);
    }
  }

  function openCreateDict() {
    setDictType(CRM_DICTIONARY_TYPES[0]?.key ?? "");
    setDictCode("");
    setDictLabel("");
    setDictSort("0");
    setDictEnabled(true);
    setDictDialog({ mode: "create" });
  }

  function openEditDict(item: DictionaryItem) {
    setDictType(item.dictType);
    setDictCode(item.code);
    setDictLabel(item.label);
    setDictSort(String(item.sort));
    setDictEnabled(item.enabled);
    setDictDialog({ mode: "edit", item });
  }

  function submitDict() {
    const editing = dictDialog?.mode === "edit" ? dictDialog.item : null;
    startTransition(async () => {
      const result = await saveDictionaryItem({
        id: editing?.id,
        dictType,
        code: dictCode,
        label: dictLabel,
        sort: Number(dictSort || 0),
        enabled: dictEnabled,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setDictDialog(null);
        router.refresh();
      }
    });
  }

  function submitCodeRule(rule: CodeRuleRow) {
    startTransition(async () => {
      const result = await saveCodeRule({
        codeType: rule.codeType,
        prefix: codePrefixes[rule.codeType] ?? "",
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        router.refresh();
      }
    });
  }

  function openPolicy(row: PolicyRow) {
    setPolicyHolderCap(String(row.holderCap));
    setPolicyManagerCap(String(row.managerHolderCap));
    setPolicyThreshold(String(row.keyGradeThreshold));
    setPolicyTtl(String(row.keyPendingTtlDays));
    setPolicyClaimMode(row.claimMode);
    setPolicyDialog(row);
  }

  function submitPolicy() {
    if (!policyDialog) {
      return;
    }
    startTransition(async () => {
      const result = await savePoolPolicy({
        departmentId: policyDialog.departmentId,
        holderCap: Number(policyHolderCap || 0),
        managerHolderCap: Number(policyManagerCap || 0),
        keyGradeThreshold: Number(policyThreshold || 0),
        keyPendingTtlDays: Number(policyTtl || 1),
        claimMode: policyClaimMode,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setPolicyDialog(null);
        router.refresh();
      }
    });
  }

  function openCap(row?: HolderCapRow) {
    setCapDialog({
      userId: row?.userId ?? members[0]?.id ?? "",
      holderCap: row?.holderCap === null || row?.holderCap === undefined ? "" : String(row.holderCap),
      reason: row?.reason ?? "",
      validUntil: row?.validUntil ? row.validUntil.slice(0, 10) : "",
    });
  }

  function submitCap() {
    if (!capDialog) {
      return;
    }
    startTransition(async () => {
      const result = await saveHolderCap({
        userId: capDialog.userId,
        holderCap: capDialog.holderCap.trim() === "" ? null : Number(capDialog.holderCap),
        reason: capDialog.reason,
        validUntil: capDialog.validUntil,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setCapDialog(null);
        router.refresh();
      }
    });
  }

  function confirmRemoveCap() {
    if (!removeTarget) {
      return;
    }
    const userId = removeTarget.userId;
    startTransition(async () => {
      const result = await removeHolderCap({ userId });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      setRemoveTarget(null);
      if (result.ok) {
        router.refresh();
      }
    });
  }

  return (
    <div className={pageWrap}>
      <div className={headerRow}>
        <div>
          <h1 className={pageTitle}>CRM 设置</h1>
          <p className={pageSubtitle}>
            业务字典、编号规则与公共池策略的唯一入口 · 字典仅 L1 可改，公共池策略由 L1 或本部门 L2 维护
          </p>
        </div>
      </div>

      {notice ? (
        <p className={`${alert(notice.kind)} mt-4`} role="status">
          {notice.text}
        </p>
      ) : null}

      {canDict ? (
        <section className={`${card} mt-4`}>
          <div className={cardHead}>
            <div>
              <h2 className={cardTitle}>业务字典</h2>
              <p className={`${cardDesc} mb-0`}>
                客户等级、来源、区域、客户类型等下拉选项都取自这里；停用后不再出现在新建表单中。
              </p>
            </div>
            <button
              type="button"
              className={btnBlue}
              onClick={openCreateDict}
              disabled={!dictEditable || pending}
            >
              新增字典项
            </button>
          </div>

          {!dictEditable ? (
            <p className={`${meta} mt-3`}>字典是租户级配置，当前账号只有查看权限。</p>
          ) : null}

          {grouped.size === 0 ? (
            <p className={`${emptyState} mt-4`}>还没有字典项。新增后即可在客户表单中选择。</p>
          ) : (
            <div className="mt-4 space-y-5">
              {[...grouped.entries()].map(([type, items]) => (
                <div key={type}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-zinc-900">
                      {CRM_DICTIONARY_TYPES.find((item) => item.key === type)?.label ?? type}
                    </span>
                    <span className="text-[11px] text-zinc-400">（{type}）</span>
                    <span className={meta}>{items.length} 项</span>
                  </div>
                  <ul className="divide-y divide-black/[0.04] rounded-2xl bg-apple-canvas/60 px-3">
                    {items.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center gap-3 py-2">
                        <span className="w-24 shrink-0 truncate text-[11px] text-zinc-400">
                          {item.code}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-900">
                          {item.label}
                        </span>
                        <span className={meta}>排序 {item.sort}</span>
                        <span className={badge(item.enabled ? "ok" : "muted")}>
                          {item.enabled ? "启用" : "停用"}
                        </span>
                        <button
                          type="button"
                          className={btnGhost}
                          onClick={() => openEditDict(item)}
                          disabled={!dictEditable || pending}
                        >
                          编辑
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {canDict ? (
        <section className={`${card} mt-4`}>
          <div className={cardHead}>
            <div>
              <h2 className={cardTitle}>编号规则</h2>
              <p className={`${cardDesc} mb-0`}>
                编号格式为「前缀 + 年月 + 4 位序号」；保存后只影响之后生成的新编号，历史编号不变。
              </p>
            </div>
          </div>
          <ul className="divide-y divide-black/[0.04]">
            {codeRules.map((rule) => (
              <li key={rule.codeType} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="w-24 shrink-0 text-[13px] font-medium text-zinc-900">
                  {rule.label}
                </span>
                <input
                  className={`${input} w-24`}
                  value={codePrefixes[rule.codeType] ?? ""}
                  maxLength={4}
                  disabled={!dictEditable || pending}
                  onChange={(event) =>
                    setCodePrefixes((current) => ({
                      ...current,
                      [rule.codeType]: event.target.value.toUpperCase(),
                    }))
                  }
                  aria-label={`${rule.label}前缀`}
                />
                <span className={meta}>
                  示例：{(codePrefixes[rule.codeType] || rule.prefix) + "2026110001"}
                </span>
                <span className={badge(rule.configured ? "blue" : "muted")}>
                  {rule.configured ? "已自定义" : "默认前缀"}
                </span>
                <button
                  type="button"
                  className={`${btnGhost} ml-auto`}
                  onClick={() => submitCodeRule(rule)}
                  disabled={!dictEditable || pending}
                >
                  保存
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canPool ? (
        <section className={`${card} mt-4`}>
          <div className={cardHead}>
            <div>
              <h2 className={cardTitle}>公共池策略</h2>
              <p className={`${cardDesc} mb-0`}>
                按部门配置私海上限、重点池阈值与候选有效期；成员个体上限优先于这里。
              </p>
            </div>
          </div>

          <ul className="divide-y divide-black/[0.04]">
            {policies.map((row) => (
              <li key={row.departmentId} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="w-32 shrink-0 truncate text-[13px] font-medium text-zinc-900">
                  {row.departmentName}
                </span>
                <span className={meta}>
                  成员上限 {row.holderCap} · 主管上限 {row.managerHolderCap} · 重点池 ≥
                  {row.keyGradeThreshold} · 候选 {row.keyPendingTtlDays} 天
                </span>
                <span className={badge(row.configured ? "blue" : "muted")}>
                  {row.configured ? "已配置" : "默认值"}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <span className={meta}>{CLAIM_MODE_LABEL[row.claimMode] ?? row.claimMode}</span>
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => openPolicy(row)}
                    disabled={!row.canWrite || pending}
                  >
                    配置
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canCap ? (
        <section className={`${card} mt-4`}>
          <div className={cardHead}>
            <div>
              <h2 className={cardTitle}>个体私海上限</h2>
              <p className={`${cardDesc} mb-0`}>
                单独覆盖某个成员的持有上限，留空表示沿用部门策略；可带失效时间，到期自动回落。
              </p>
            </div>
            <button type="button" className={btnBlue} onClick={() => openCap()} disabled={pending}>
              新增覆盖
            </button>
          </div>

          {caps.length === 0 ? (
            <p className={emptyState}>还没有个体上限覆盖，所有成员都按部门策略计算。</p>
          ) : (
            <ul className="divide-y divide-black/[0.04]">
              {caps.map((row) => (
                <li key={row.userId} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="w-28 shrink-0 truncate text-[13px] font-medium text-zinc-900">
                    {row.userName}
                  </span>
                  <span className={meta}>
                    {row.holderCap === null ? "按部门策略" : `上限 ${row.holderCap}`}
                  </span>
                  <span className={meta}>{formatDay(row.validUntil)}</span>
                  {row.reason ? (
                    <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">
                      {row.reason}
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1" />
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={() => openCap(row)}
                      disabled={pending}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={() => setRemoveTarget(row)}
                      disabled={pending}
                    >
                      清除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <Modal
        open={dictDialog !== null}
        title={dictDialog?.mode === "edit" ? "编辑字典项" : "新增字典项"}
        description="同一类型下编码唯一；编码创建后不可修改"
        pending={pending}
        onClose={() => {
          if (!pending) {
            setDictDialog(null);
          }
        }}
        footer={
          <>
            <button type="button" className={btnGhost} onClick={() => setDictDialog(null)} disabled={pending}>
              取消
            </button>
            <button
              type="button"
              className={btnBlue}
              onClick={submitDict}
              disabled={pending || !dictType.trim() || !dictLabel.trim()}
            >
              {pending ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <div className={formGrid}>
          <label>
            <span className={fieldLabel}>字典类型 *</span>
            <Select
              value={dictType}
              onValueChange={setDictType}
              className="w-full"
              options={typeOptions}
            />
            <span className={meta}>
              {dictDialog?.mode === "edit"
                ? "改类型会把该选项移到另一组；已在客户档案中用它的记录仍保留原编码"
                : "决定这组选项用在哪里；括号里是程序内部标识"}
            </span>
          </label>
          <label>
            <span className={fieldLabel}>编码</span>
            <input
              className={input}
              value={dictCode}
              onChange={(event) => setDictCode(event.target.value)}
              maxLength={40}
              disabled={dictDialog?.mode === "edit"}
              placeholder="留空自动按显示名称生成"
            />
            <span className={meta}>真正存进数据库的值，创建后不可修改</span>
          </label>
          <label>
            <span className={fieldLabel}>显示名称 *</span>
            <input
              className={input}
              value={dictLabel}
              onChange={(event) => setDictLabel(event.target.value)}
              maxLength={80}
              placeholder="如：A 级（重点客户）"
            />
          </label>
          <label>
            <span className={fieldLabel}>排序</span>
            <input
              className={input}
              type="number"
              min={0}
              max={9999}
              value={dictSort}
              onChange={(event) => setDictSort(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-zinc-300"
              checked={dictEnabled}
              onChange={(event) => setDictEnabled(event.target.checked)}
            />
            <span className="text-[12px] text-zinc-600">启用（停用后不再出现在新建表单）</span>
          </label>
        </div>
      </Modal>

      <Modal
        open={policyDialog !== null}
        title={`${policyDialog?.departmentName ?? ""} · 公共池策略`}
        description="0 表示不限；重点池阈值按 ICP 分数 0-100 判定"
        pending={pending}
        onClose={() => {
          if (!pending) {
            setPolicyDialog(null);
          }
        }}
        footer={
          <>
            <button type="button" className={btnGhost} onClick={() => setPolicyDialog(null)} disabled={pending}>
              取消
            </button>
            <button type="button" className={btnBlue} onClick={submitPolicy} disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <div className={formGrid}>
          <label>
            <span className={fieldLabel}>成员私海上限</span>
            <input
              className={input}
              type="number"
              min={0}
              value={policyHolderCap}
              onChange={(event) => setPolicyHolderCap(event.target.value)}
            />
          </label>
          <label>
            <span className={fieldLabel}>主管私海上限</span>
            <input
              className={input}
              type="number"
              min={0}
              value={policyManagerCap}
              onChange={(event) => setPolicyManagerCap(event.target.value)}
            />
          </label>
          <label>
            <span className={fieldLabel}>重点池阈值</span>
            <input
              className={input}
              type="number"
              min={0}
              max={100}
              value={policyThreshold}
              onChange={(event) => setPolicyThreshold(event.target.value)}
            />
          </label>
          <label>
            <span className={fieldLabel}>候选有效期（天）</span>
            <input
              className={input}
              type="number"
              min={1}
              max={90}
              value={policyTtl}
              onChange={(event) => setPolicyTtl(event.target.value)}
            />
          </label>
          <label className="sm:col-span-2">
            <span className={fieldLabel}>领取方式</span>
            <Select
              className="w-full"
              value={policyClaimMode}
              onValueChange={setPolicyClaimMode}
              options={[
                { value: "self", label: "自助领用（成员自己从公共池领取）" },
                { value: "assign", label: "主管分配（仅主管分配）" },
              ]}
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={capDialog !== null}
        title="个体私海上限"
        description="优先于部门策略；留空表示不覆盖"
        pending={pending}
        onClose={() => {
          if (!pending) {
            setCapDialog(null);
          }
        }}
        footer={
          <>
            <button type="button" className={btnGhost} onClick={() => setCapDialog(null)} disabled={pending}>
              取消
            </button>
            <button
              type="button"
              className={btnBlue}
              onClick={submitCap}
              disabled={pending || !capDialog?.userId}
            >
              {pending ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        {capDialog ? (
          <div className={formGrid}>
            <label className="sm:col-span-2">
              <span className={fieldLabel}>成员 *</span>
              <Select
                className="w-full"
                value={capDialog.userId}
                onValueChange={(value) => setCapDialog((current) => current && { ...current, userId: value })}
                options={[
                  { value: "", label: "请选择成员" },
                  ...members.map((member) => ({
                    value: member.id,
                    label: `${member.name}（${member.departmentName}）`,
                  })),
                ]}
              />
            </label>
            <label>
              <span className={fieldLabel}>私海上限</span>
              <input
                className={input}
                type="number"
                min={0}
                value={capDialog.holderCap}
                onChange={(event) =>
                  setCapDialog((current) => current && { ...current, holderCap: event.target.value })
                }
                placeholder="留空 = 按部门策略"
              />
            </label>
            <label>
              <span className={fieldLabel}>失效日期</span>
              <input
                className={input}
                type="date"
                value={capDialog.validUntil}
                onChange={(event) =>
                  setCapDialog((current) => current && { ...current, validUntil: event.target.value })
                }
              />
            </label>
            <label className="sm:col-span-2">
              <span className={fieldLabel}>原因</span>
              <input
                className={input}
                value={capDialog.reason}
                maxLength={200}
                onChange={(event) =>
                  setCapDialog((current) => current && { ...current, reason: event.target.value })
                }
                placeholder="如：新客户攻坚期临时扩容"
              />
            </label>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={removeTarget !== null}
        title="清除个体上限？"
        description={`「${removeTarget?.userName ?? ""}」将回落到部门策略计算私海上限。`}
        confirmLabel="清除"
        danger
        pending={pending}
        onConfirm={confirmRemoveCap}
        onCancel={() => {
          if (!pending) {
            setRemoveTarget(null);
          }
        }}
      />
    </div>
  );
}
