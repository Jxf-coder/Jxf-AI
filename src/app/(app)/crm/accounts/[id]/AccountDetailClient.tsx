"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  card,
  cardDesc,
  cardHead,
  cardTitle,
  divider,
  emptyState,
  fieldLabel,
  formGrid,
  gradeBadge,
  headerRow,
  input,
  meta,
  pageSubtitle,
  pageTitle,
  pageWrap,
  subNavActive,
  subNavIdle,
  subNavScroll,
  subNavTrack,
} from "@/components/knowledge/tokens";
import type { CrmDictionaryFieldOptions } from "@/lib/crm/dictionary";

import { createContact, createInteraction, deleteContact, deleteInteraction, mergeAccount, updateAccount } from "../actions";
import { deleteAccountDocument } from "./documents-actions";

export interface AccountDetail {
  id: string;
  code: string;
  name: string;
  companyName: string;
  region: string;
  country: string;
  address: string;
  email: string;
  website: string;
  fax: string;
  postalCode: string;
  salesRegion: string;
  enterpriseType: string;
  brand: string;
  salesChannel: string;
  source: string;
  grade: string;
  customerType: string;
  mainProducts: string;
  interestedProducts: string;
  competitors: string;
  annualRevenue: string;
  employeeCount: string;
  foundedYear: string;
  marketContact: string;
  purchaseFrequency: string;
  requiredQuality: string;
  trafficContent: string;
  analysis: string;
  contactStatus: string;
  dealStatus: string;
  poolStatus: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactRow {
  id: string;
  name: string;
  jobTitle: string;
  roleType: string;
  mobile: string;
  phone: string;
  email: string;
  wechat: string;
  whatsapp: string;
  isPrimary: boolean;
}

export interface HistoryEntry {
  action: string;
  actorName: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface MergeCandidate {
  id: string;
  code: string;
  name: string;
}

export interface InteractionRow {
  id: string;
  purpose: string;
  direction: string;
  channel: string;
  occurredAt: string;
  nextFollowAt: string | null;
  subject: string;
  content: string;
  status: string;
  isOpportunity: boolean;
  interestedProducts: string;
  category: string;
  contactName: string;
}

export interface DocumentRow {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  uploaderName: string;
  createdAt: string;
}

const CHANNEL_LABEL: Record<string, string> = {
  call: "电话",
  mail: "邮件",
  wechat: "微信",
  whatsapp: "WhatsApp",
  meeting: "会面",
  note: "备注",
  task: "任务",
};

const DIRECTION_LABEL: Record<string, string> = {
  in: "客户发起",
  out: "我方发起",
  internal: "内部沟通",
};

const PURPOSE_OPTIONS = [
  "确认产品",
  "报价",
  "议价",
  "提供样品",
  "催客户下单",
  "确认订单",
  "确认交期",
  "确认验货",
  "催收货款",
  "售后",
  "其他",
];

const TABS: { key: string; label: string; stage?: string }[] = [
  { key: "profile", label: "档案" },
  { key: "interactions", label: "联系记录" },
  { key: "products", label: "商品信息", stage: "W2" },
  { key: "documents", label: "相关文档" },
  { key: "quotes", label: "报价历史", stage: "W2" },
  { key: "deals", label: "成交历史", stage: "W2" },
  { key: "samples", label: "寄样历史", stage: "W2" },
  { key: "shipments", label: "出运历史", stage: "W2" },
  { key: "complaints", label: "投诉历史", stage: "W2" },
  { key: "banks", label: "银行信息", stage: "W2" },
  { key: "insurance", label: "中信保", stage: "W2" },
  { key: "history", label: "修改历史" },
  { key: "chat", label: "聊天记录", stage: "W3" },
];

const CONTACT_STATUS_LABEL: Record<string, string> = {
  untouched: "未联系",
  mailed: "已发邮件",
  wechat: "已加微信",
  replied: "已回复",
  no_reply: "未回复",
  unreachable: "联系不上",
};

const DEAL_STATUS_LABEL: Record<string, string> = {
  potential: "潜在",
  quoting: "报价中",
  negotiating: "洽谈中",
  won: "已成交",
  lost: "已丢单",
};

const POOL_LABEL: Record<string, string> = {
  private: "私海",
  public: "公海",
  key_pending: "重点候选",
  key: "重点池",
};

const ROLE_LABEL: Record<string, string> = {
  decision: "决策人",
  tech: "技术",
  purchase: "采购",
  finance: "财务",
  other: "其他",
};

const ACTION_LABEL: Record<string, string> = {
  "crm.account.created": "建档",
  "crm.account.updated": "修改档案",
  "crm.account.imported": "导入建档",
  "crm.contact.created": "新增联系人",
  "crm.contact.deleted": "删除联系人",
  "crm.interaction.created": "新增联系记录",
  "crm.interaction.deleted": "删除联系记录",
  "crm.account.document_uploaded": "上传文档",
  "crm.account.document_deleted": "删除文档",
};

const EDIT_FIELDS: { name: keyof AccountDetail; label: string; wide?: boolean }[] = [
  { name: "name", label: "客户名称 *" },
  { name: "companyName", label: "公司名称" },
  { name: "region", label: "区域" },
  { name: "country", label: "国家 / 地区" },
  { name: "salesRegion", label: "销售区域" },
  { name: "source", label: "客户来源" },
  { name: "grade", label: "客户等级 *" },
  { name: "customerType", label: "客户类型 *" },
  { name: "enterpriseType", label: "企业类型" },
  { name: "brand", label: "品牌" },
  { name: "salesChannel", label: "销售渠道" },
  { name: "mainProducts", label: "主营产品" },
  { name: "interestedProducts", label: "关注产品" },
  { name: "purchaseFrequency", label: "采购频率" },
  { name: "requiredQuality", label: "质量要求" },
  { name: "trafficContent", label: "流量内容" },
  { name: "competitors", label: "竞争对手" },
  { name: "annualRevenue", label: "年营收" },
  { name: "employeeCount", label: "员工人数" },
  { name: "foundedYear", label: "成立年份" },
  { name: "email", label: "电子邮箱 *" },
  { name: "website", label: "公司网址" },
  { name: "fax", label: "传真" },
  { name: "postalCode", label: "邮政编码" },
  { name: "marketContact", label: "市场联系人" },
  { name: "address", label: "地址", wide: true },
  { name: "analysis", label: "分析与备注", wide: true },
];

/** 表单字段 → 数据库列名，与 actions.ts 的白名单保持一致 */
const COLUMN_OF: Record<string, string> = {
  name: "name",
  companyName: "company_name",
  region: "region",
  country: "country",
  salesRegion: "sales_region",
  source: "source",
  grade: "grade",
  customerType: "customer_type",
  enterpriseType: "enterprise_type",
  brand: "brand",
  salesChannel: "sales_channel",
  mainProducts: "main_products",
  interestedProducts: "interested_products",
  purchaseFrequency: "purchase_frequency",
  requiredQuality: "required_quality",
  trafficContent: "traffic_content",
  competitors: "competitors",
  annualRevenue: "annual_revenue",
  employeeCount: "employee_count",
  foundedYear: "founded_year",
  email: "email",
  website: "website",
  fax: "fax",
  postalCode: "postal_code",
  marketContact: "market_contact",
  address: "address",
  analysis: "analysis",
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 业务日期（跟进日期 / 下次跟进）只显示年月日，避免把日期输入显示成 08:00 */
function formatDateOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
      <p className="text-[11px] font-medium text-zinc-500">{label}</p>
      <p className="mt-0.5 break-words text-[13px] leading-relaxed text-zinc-900">{value || "—"}</p>
    </div>
  );
}

export function AccountDetailClient({
  account,
  contacts,
  history,
  interactions,
  documents,
  dictOptions,
  canWrite,
  canMerge,
  mergeCandidates,
}: {
  account: AccountDetail;
  contacts: ContactRow[];
  history: HistoryEntry[];
  interactions: InteractionRow[];
  documents: DocumentRow[];
  dictOptions: CrmDictionaryFieldOptions;
  canWrite: boolean;
  canMerge: boolean;
  mergeCandidates: MergeCandidate[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState("profile");
  const [editing, setEditing] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [pendingInteraction, setPendingInteraction] = useState<InteractionRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ContactRow | null>(null);
  const [pendingDocument, setPendingDocument] = useState<DocumentRow | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const activeTab = TABS.find((item) => item.key === tab) ?? TABS[0];

  /** 只读展示时把字典编码翻回中文，未收录的历史值原样显示 */
  function dictLabel(key: keyof CrmDictionaryFieldOptions, value: string): string {
    if (!value) {
      return "";
    }
    const hit = dictOptions[key].find((item) => item.code === value);
    return hit ? hit.label : value;
  }

  function handleSave(formData: FormData) {
    const fields: Record<string, string> = {};
    for (const field of EDIT_FIELDS) {
      const column = COLUMN_OF[String(field.name)];
      if (column) {
        fields[column] = String(formData.get(String(field.name)) ?? "");
      }
    }
    fields.contact_status = String(formData.get("contactStatus") ?? "");
    fields.deal_status = String(formData.get("dealStatus") ?? "");

    startTransition(async () => {
      const result = await updateAccount({ accountId: account.id, fields });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setEditing(false);
      }
    });
  }

  function handleAddContact(formData: FormData) {
    startTransition(async () => {
      const result = await createContact({
        accountId: account.id,
        name: String(formData.get("contactName") ?? ""),
        jobTitle: String(formData.get("jobTitle") ?? ""),
        roleType: String(formData.get("roleType") ?? ""),
        mobile: String(formData.get("mobile") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        email: String(formData.get("contactEmail") ?? ""),
        wechat: String(formData.get("wechat") ?? ""),
        whatsapp: String(formData.get("whatsapp") ?? ""),
        isPrimary: formData.get("isPrimary") === "on",
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setContactOpen(false);
      }
    });
  }

  function handleDeleteContact(contact: ContactRow) {
    startTransition(async () => {
      const result = await deleteContact({ accountId: account.id, contactId: contact.id });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
    });
  }

  function handleAddInteraction(formData: FormData) {
    startTransition(async () => {
      const result = await createInteraction({
        accountId: account.id,
        contactId: String(formData.get("contactId") ?? ""),
        purpose: String(formData.get("purpose") ?? ""),
        direction: String(formData.get("direction") ?? "out"),
        channel: String(formData.get("channel") ?? "note"),
        occurredAt: String(formData.get("occurredAt") ?? ""),
        nextFollowAt: String(formData.get("nextFollowAt") ?? ""),
        subject: String(formData.get("subject") ?? ""),
        content: String(formData.get("content") ?? ""),
        status: String(formData.get("status") ?? "followed"),
        isOpportunity: formData.get("isOpportunity") === "on",
        interestedProducts: String(formData.get("interestedProducts") ?? ""),
        category: String(formData.get("category") ?? ""),
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setInteractionOpen(false);
      }
    });
  }

  function handleDeleteInteraction(item: InteractionRow) {
    startTransition(async () => {
      const result = await deleteInteraction({ accountId: account.id, interactionId: item.id });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
    });
  }

  function handleUploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("document");
    if (!(file instanceof File) || file.size === 0) {
      setNotice({ kind: "error", text: "请选择要上传的文件" });
      return;
    }
    startTransition(async () => {
      const body = new FormData();
      body.append("accountId", account.id);
      body.append("file", file);
      try {
        const response = await fetch("/api/crm/documents/upload", { method: "POST", body });
        const payload = (await response.json()) as {
          ok?: boolean;
          message?: string;
          error?: string;
        };
        const ok = response.ok && payload.ok === true;
        setNotice({
          kind: ok ? "info" : "error",
          text: ok ? payload.message ?? "附件已上传" : payload.error ?? "上传失败",
        });
        if (ok) {
          form.reset();
          router.refresh();
        }
      } catch {
        setNotice({ kind: "error", text: "上传失败，请稍后重试" });
      }
    });
  }

  function handleDeleteDocument(document: DocumentRow) {
    startTransition(async () => {
      const result = await deleteAccountDocument({
        accountId: account.id,
        documentId: document.id,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
    });
  }

  function handleMerge() {
    startTransition(async () => {
      const result = await mergeAccount({
        sourceId: account.id,
        targetId: mergeTarget,
        reason: mergeReason,
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setMergeOpen(false);
        router.push(`/crm/accounts/${mergeTarget}`);
        router.refresh();
      }
    });
  }

  return (
    <div className={pageWrap}>
      <Link href="/crm/accounts" className="text-[12px] text-apple-blue hover:underline">
        ← 返回客户列表
      </Link>

      <div className={`${headerRow} mt-3`}>
        <div className="min-w-0">
          <h1 className={`${pageTitle} break-words`}>{account.name}</h1>
          <p className={pageSubtitle}>
            {[account.code, account.companyName, account.country || account.region]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className={actions}>
          {account.grade ? <span className={gradeBadge(account.grade)}>{account.grade} 级</span> : null}
          <span className={badge(account.poolStatus === "private" ? "muted" : "warn")}>
            {POOL_LABEL[account.poolStatus] ?? account.poolStatus}
          </span>
          <span className={badge("muted")}>负责人 {account.ownerName}</span>
          {tab === "profile" && canWrite ? (
            <button
              type="button"
              className={editing ? btnGhost : btnBlue}
              onClick={() => {
                setEditing((value) => !value);
                setNotice(null);
              }}
            >
              {editing ? "取消编辑" : "编辑档案"}
            </button>
          ) : null}
          {tab === "profile" && canMerge && !editing ? (
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setMergeTarget("");
                setMergeReason("");
                setMergeOpen(true);
                setNotice(null);
              }}
              disabled={pending}
            >
              合并客户
            </button>
          ) : null}
        </div>
      </div>

      <div className={subNavScroll}>
        <div className={subNavTrack} role="tablist">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={item.key === tab}
              className={item.key === tab ? subNavActive : subNavIdle}
              onClick={() => {
                setTab(item.key);
                setEditing(false);
                setNotice(null);
              }}
            >
              {item.label}
              {item.stage ? <span className="ml-1 text-[10px] text-zinc-400">{item.stage}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {notice ? (
        <p
          className={`mt-4 rounded-2xl px-4 py-3 text-[13px] ${
            notice.kind === "error" ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {tab === "profile" ? (
        <div className="mt-4">
          {editing ? (
            <form
              className={card}
              onSubmit={(event) => {
                event.preventDefault();
                handleSave(new FormData(event.currentTarget));
              }}
            >
              <div className={cardHead}>
                <h2 className={cardTitle}>编辑档案</h2>
              </div>
              <p className={cardDesc}>保存后只记录有变化的字段，修改历史里能看到前后值。</p>
              <div className={formGrid}>
                {EDIT_FIELDS.map((field) => {
                  const dictFieldOptions =
                    field.name === "customerType" ||
                    field.name === "source" ||
                    field.name === "region" ||
                    field.name === "country"
                      ? dictOptions[field.name]
                      : [];
                  const currentValue = account[field.name];
                  const legacyOptions =
                    dictFieldOptions.length > 0 &&
                    currentValue &&
                    !dictFieldOptions.some((item) => item.code === currentValue)
                      ? [{ value: currentValue, label: `${currentValue}（历史值）` }]
                      : [];

                  return (
                    <label key={field.name} className={field.wide ? "sm:col-span-2" : undefined}>
                      <span className={fieldLabel}>{field.label}</span>
                      {field.name === "grade" ? (
                        <Select
                          name="grade"
                          required
                          defaultValue={account.grade || ""}
                          className="w-full"
                          options={[
                            { value: "", label: "请选择" },
                            { value: "A", label: "A 级" },
                            { value: "B", label: "B 级" },
                            { value: "C", label: "C 级" },
                            { value: "D", label: "D 级" },
                          ]}
                        />
                      ) : dictFieldOptions.length > 0 ? (
                        <Select
                          name={String(field.name)}
                          required={field.name === "customerType"}
                          defaultValue={currentValue}
                          className="w-full"
                          options={[
                            ...legacyOptions,
                            { value: "", label: "未指定" },
                            ...dictFieldOptions.map((item) => ({
                              value: item.code,
                              label: item.label,
                            })),
                          ]}
                        />
                      ) : (
                        <input
                          name={String(field.name)}
                          type={field.name === "email" ? "email" : undefined}
                          defaultValue={currentValue}
                          maxLength={field.name === "name" ? 120 : 200}
                          required={
                            field.name === "name" ||
                            field.name === "email" ||
                            field.name === "customerType"
                          }
                          className={input}
                        />
                      )}
                    </label>
                  );
                })}
                <label>
                  <span className={fieldLabel}>联系状态</span>
                  <Select
                    name="contactStatus"
                    defaultValue={account.contactStatus}
                    className="w-full"
                    options={Object.entries(CONTACT_STATUS_LABEL).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />
                </label>
                <label>
                  <span className={fieldLabel}>成交状态</span>
                  <Select
                    name="dealStatus"
                    defaultValue={account.dealStatus}
                    className="w-full"
                    options={Object.entries(DEAL_STATUS_LABEL).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />
                </label>
              </div>
              <div className={actions}>
                <button type="submit" className={btnBlue} disabled={pending}>
                  {pending ? "保存中…" : "保存"}
                </button>
                <button type="button" className={btnGhost} onClick={() => setEditing(false)} disabled={pending}>
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <section className={card}>
                <div className={cardHead}>
                  <h2 className={cardTitle}>基本资料</h2>
                  <span className={meta}>更新 {formatDateTime(account.updatedAt)}</span>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="区域" value={dictLabel("region", account.region)} />
                  <Field label="国家 / 地区" value={dictLabel("country", account.country)} />
                  <Field label="销售区域" value={account.salesRegion} />
                  <Field label="客户来源" value={dictLabel("source", account.source)} />
                  <Field label="客户类型" value={dictLabel("customerType", account.customerType)} />
                  <Field label="企业类型" value={account.enterpriseType} />
                  <Field label="品牌" value={account.brand} />
                  <Field label="销售渠道" value={account.salesChannel} />
                  <Field label="电子邮箱" value={account.email} />
                  <Field label="公司网址" value={account.website} />
                  <Field label="传真" value={account.fax} />
                  <Field label="邮政编码" value={account.postalCode} />
                  <div className="sm:col-span-2 lg:col-span-3">
                    <Field label="地址" value={account.address} />
                  </div>
                </div>
              </section>

              <section className={card}>
                <div className={cardHead}>
                  <h2 className={cardTitle}>业务画像</h2>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="主营产品" value={account.mainProducts} />
                  <Field label="关注产品" value={account.interestedProducts} />
                  <Field label="采购频率" value={account.purchaseFrequency} />
                  <Field label="质量要求" value={account.requiredQuality} />
                  <Field label="流量内容" value={account.trafficContent} />
                  <Field label="竞争对手" value={account.competitors} />
                  <Field label="年营收" value={account.annualRevenue} />
                  <Field label="员工人数" value={account.employeeCount} />
                  <Field label="成立年份" value={account.foundedYear} />
                  <Field label="市场联系人" value={account.marketContact} />
                </div>
                <div className={divider} />
                <Field label="分析与备注" value={account.analysis} />
              </section>

              <section className={card}>
                <div className={cardHead}>
                  <h2 className={cardTitle}>跟进状态</h2>
                  <span className={meta}>建档 {formatDateTime(account.createdAt)}</span>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="联系状态" value={CONTACT_STATUS_LABEL[account.contactStatus] ?? account.contactStatus} />
                  <Field label="成交状态" value={DEAL_STATUS_LABEL[account.dealStatus] ?? account.dealStatus} />
                  <Field label="客户池" value={POOL_LABEL[account.poolStatus] ?? account.poolStatus} />
                </div>
              </section>
            </>
          )}

          <section className={card}>
            <div className={cardHead}>
              <h2 className={cardTitle}>联系人</h2>
              <div className={actions}>
                <span className={meta}>{contacts.length} 位</span>
                {canWrite ? (
                  <button type="button" className={btnGhost} onClick={() => setContactOpen((value) => !value)}>
                    {contactOpen ? "收起" : "新增联系人"}
                  </button>
                ) : null}
              </div>
            </div>

            {contactOpen && canWrite ? (
              <form
                className={`${formGrid} mb-4`}
                onSubmit={(event) => {
                  event.preventDefault();
                  handleAddContact(new FormData(event.currentTarget));
                }}
              >
                <label>
                  <span className={fieldLabel}>姓名 *</span>
                  <input name="contactName" required maxLength={60} className={input} />
                </label>
                <label>
                  <span className={fieldLabel}>职位</span>
                  <input name="jobTitle" maxLength={60} className={input} />
                </label>
                <label>
                  <span className={fieldLabel}>角色</span>
                  <Select
                    name="roleType"
                    defaultValue=""
                    className="w-full"
                    options={[
                      { value: "", label: "未指定" },
                      ...Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })),
                    ]}
                  />
                </label>
                <label>
                  <span className={fieldLabel}>手机</span>
                  <input name="mobile" maxLength={40} className={input} />
                </label>
                <label>
                  <span className={fieldLabel}>邮箱</span>
                  <input name="contactEmail" type="email" maxLength={120} className={input} />
                </label>
                <label>
                  <span className={fieldLabel}>电话</span>
                  <input name="phone" maxLength={40} className={input} />
                </label>
                <label>
                  <span className={fieldLabel}>微信</span>
                  <input name="wechat" maxLength={60} className={input} />
                </label>
                <label>
                  <span className={fieldLabel}>WhatsApp</span>
                  <input name="whatsapp" maxLength={60} className={input} />
                </label>
                <label className="flex items-center gap-2 sm:col-span-2">
                  <input name="isPrimary" type="checkbox" className="h-4 w-4 rounded border-zinc-300" />
                  <span className="text-[12px] text-zinc-600">设为主联系人</span>
                </label>
                <div className={`${actions} sm:col-span-2`}>
                  <button type="submit" className={btnBlue} disabled={pending}>
                    {pending ? "保存中…" : "保存联系人"}
                  </button>
                </div>
              </form>
            ) : null}

            {contacts.length === 0 ? (
              <p className={emptyState}>还没有联系人{canWrite ? "，点击「新增联系人」补录。" : "。"}</p>
            ) : (
              <ul className="divide-y divide-black/[0.04]">
                {contacts.map((contact) => (
                  <li key={contact.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-semibold text-zinc-900">{contact.name}</span>
                        {contact.isPrimary ? <span className={badge("blue")}>主联系人</span> : null}
                        {contact.roleType ? (
                          <span className={badge("muted")}>{ROLE_LABEL[contact.roleType] ?? contact.roleType}</span>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-[12px] text-zinc-500">
                        {[contact.jobTitle, contact.mobile || contact.phone, contact.email, contact.wechat]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </p>
                    </div>
                    {canWrite ? (
                      <button
                        type="button"
                        className="text-[12px] text-rose-500 hover:underline disabled:opacity-40"
                        onClick={() => setPendingDelete(contact)}
                        disabled={pending}
                      >
                        删除
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {tab === "interactions" ? (
        <div className="mt-4">
          {canWrite ? (
            <section className={card}>
              <div className={cardHead}>
                <h2 className={cardTitle}>写联系记录</h2>
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => setInteractionOpen((value) => !value)}
                  disabled={pending}
                >
                  {interactionOpen ? "收起" : "新增记录"}
                </button>
              </div>
              {interactionOpen ? (
                <form
                  className={formGrid}
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleAddInteraction(new FormData(event.currentTarget));
                  }}
                >
                  <label>
                    <span className={fieldLabel}>主题 *</span>
                    <input name="subject" required maxLength={120} className={input} />
                  </label>
                  <label>
                    <span className={fieldLabel}>联系人</span>
                    <Select
                      name="contactId"
                      defaultValue=""
                      className="w-full"
                      options={[
                        { value: "", label: "未指定" },
                        ...contacts.map((contact) => ({ value: contact.id, label: contact.name })),
                      ]}
                    />
                  </label>
                  <label>
                    <span className={fieldLabel}>目的</span>
                    <Select
                      name="purpose"
                      defaultValue=""
                      className="w-full"
                      options={[
                        { value: "", label: "未指定" },
                        ...PURPOSE_OPTIONS.map((item) => ({ value: item, label: item })),
                      ]}
                    />
                  </label>
                  <label>
                    <span className={fieldLabel}>方向</span>
                    <Select
                      name="direction"
                      defaultValue="out"
                      className="w-full"
                      options={Object.entries(DIRECTION_LABEL).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                    />
                  </label>
                  <label>
                    <span className={fieldLabel}>方式</span>
                    <Select
                      name="channel"
                      defaultValue="note"
                      className="w-full"
                      options={Object.entries(CHANNEL_LABEL).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                    />
                  </label>
                  <label>
                    <span className={fieldLabel}>记录状态</span>
                    <Select
                      name="status"
                      defaultValue="followed"
                      className="w-full"
                      options={[
                        { value: "followed", label: "已跟进" },
                        { value: "pending", label: "待跟进" },
                      ]}
                    />
                  </label>
                  <label>
                    <span className={fieldLabel}>跟进日期</span>
                    <input
                      name="occurredAt"
                      type="date"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                      className={input}
                    />
                  </label>
                  <label>
                    <span className={fieldLabel}>下次跟进</span>
                    <input name="nextFollowAt" type="date" className={input} />
                  </label>
                  <label>
                    <span className={fieldLabel}>关注产品</span>
                    <input name="interestedProducts" maxLength={120} className={input} />
                  </label>
                  <label>
                    <span className={fieldLabel}>记录分类</span>
                    <input name="category" maxLength={40} className={input} />
                  </label>
                  <label className="sm:col-span-2">
                    <span className={fieldLabel}>联系情况</span>
                    <textarea name="content" maxLength={4000} className={`${input} min-h-[96px]`} />
                  </label>
                  <label className="flex items-center gap-2 sm:col-span-2">
                    <input name="isOpportunity" type="checkbox" className="h-4 w-4 rounded border-zinc-300" />
                    <span className="text-[12px] text-zinc-600">标记为商机</span>
                  </label>
                  <div className={`${actions} sm:col-span-2`}>
                    <button type="submit" className={btnBlue} disabled={pending}>
                      {pending ? "保存中…" : "保存记录"}
                    </button>
                    <span className={meta}>「待跟进」必须填下次跟进日期，W5 会按它生成提醒。</span>
                  </div>
                </form>
              ) : (
                <p className={cardDesc}>记录电话、邮件、微信等沟通，或登记一条待跟进计划。</p>
              )}
            </section>
          ) : null}

          <section className={card}>
            <div className={cardHead}>
              <h2 className={cardTitle}>联系记录</h2>
              <span className={meta}>{interactions.length} 条</span>
            </div>
            {interactions.length === 0 ? (
              <p className={emptyState}>还没有联系记录。</p>
            ) : (
              <ul className="divide-y divide-black/[0.04]">
                {interactions.map((item) => (
                  <li key={item.id} className="py-3.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={badge(item.status === "pending" ? "warn" : "muted")}>
                        {item.status === "pending" ? "待跟进" : "已跟进"}
                      </span>
                      <span className="text-[13px] font-semibold text-zinc-900">{item.subject}</span>
                      {item.isOpportunity ? <span className={badge("blue")}>商机</span> : null}
                      <span className={meta}>
                        {CHANNEL_LABEL[item.channel] ?? item.channel} · {formatDateOnly(item.occurredAt)}
                      </span>
                      {item.contactName ? <span className={meta}>· {item.contactName}</span> : null}
                    </div>
                    {item.content ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-600">
                        {item.content}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-zinc-400">
                      {[item.purpose, item.interestedProducts, item.category].filter(Boolean).join(" · ") ||
                        "—"}
                    </p>
                    {item.nextFollowAt ? (
                      <p className="mt-0.5 text-[11px] text-apple-blue">
                        下次跟进 {formatDateOnly(item.nextFollowAt)}
                      </p>
                    ) : null}
                    {canWrite ? (
                      <button
                        type="button"
                        className="mt-1 text-[12px] text-rose-500 hover:underline disabled:opacity-40"
                        onClick={() => setPendingInteraction(item)}
                        disabled={pending}
                      >
                        删除
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {tab === "documents" ? (
        <section className={`${card} mt-4`}>
          <div className={cardHead}>
            <h2 className={cardTitle}>相关文档</h2>
            <span className={meta}>{documents.length} 个附件 · 单个不超过 20 MB</span>
          </div>
          {canWrite ? (
            <form onSubmit={handleUploadDocument} className={`${actions} mb-4`}>
              <input type="file" name="document" required className="text-[12px] text-zinc-600" />
              <button type="submit" className={btnBlue} disabled={pending}>
                {pending ? "上传中…" : "上传附件"}
              </button>
            </form>
          ) : (
            <p className={cardDesc}>只读：需要客户写权限才能上传或删除附件。</p>
          )}
          {documents.length === 0 ? (
            <p className={emptyState}>还没有上传文档。</p>
          ) : (
            <ul className="divide-y divide-black/[0.04]">
              {documents.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <a
                    className="link-action text-[13px]"
                    href={`/api/crm/documents/${item.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.name}
                  </a>
                  <span className={meta}>
                    {formatFileSize(item.sizeBytes)} · {item.uploaderName} ·{" "}
                    {formatDateTime(item.createdAt)}
                  </span>
                  {canWrite ? (
                    <button
                      type="button"
                      className="ml-auto text-[12px] text-rose-500 hover:underline disabled:opacity-40"
                      onClick={() => setPendingDocument(item)}
                      disabled={pending}
                    >
                      删除
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tab === "history" ? (
        <section className={`${card} mt-4`}>
          <div className={cardHead}>
            <h2 className={cardTitle}>修改历史</h2>
            <span className={meta}>按审计权限显示，最多 50 条</span>
          </div>
          {history.length === 0 ? (
            <p className={emptyState}>暂无可见的修改记录。</p>
          ) : (
            <ul className="divide-y divide-black/[0.04]">
              {history.map((entry, index) => {
                const changes = Array.isArray(entry.payload.changes)
                  ? (entry.payload.changes as { label?: string; from?: string; to?: string }[])
                  : [];
                return (
                  <li key={`${entry.createdAt}-${index}`} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-zinc-900">
                        {ACTION_LABEL[entry.action] ?? entry.action}
                      </span>
                      <span className={meta}>
                        {entry.actorName} · {formatDateTime(entry.createdAt)}
                      </span>
                    </div>
                    {changes.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1">
                        {changes.map((change, changeIndex) => (
                          <li key={changeIndex} className="text-[12px] leading-relaxed text-zinc-600">
                            <span className="text-zinc-900">{change.label ?? "字段"}</span>：
                            <span className="text-zinc-400">{change.from || "空"}</span>
                            <span className="mx-1 text-zinc-400">→</span>
                            <span className="text-zinc-900">{change.to || "空"}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {activeTab.stage ? (
        <section className={`${card} mt-4`}>
          <div className={cardHead}>
            <h2 className={cardTitle}>{activeTab.label}</h2>
            <span className={badge("warn")}>{activeTab.stage} 上线</span>
          </div>
          <p className={cardDesc}>
            该页签的数据源与权限已在总体方案中冻结，随 {activeTab.stage} 一并落地。当前阶段先把档案与联系人跑通。
          </p>
        </section>
      ) : null}

      <ConfirmDialog
        open={pendingDocument !== null}
        title="删除附件"
        description={pendingDocument ? `确认删除「${pendingDocument.name}」？文件会同时从存储中移除。` : ""}
        confirmLabel="删除"
        danger
        pending={pending}
        onConfirm={() => {
          const target = pendingDocument;
          setPendingDocument(null);
          if (target) {
            handleDeleteDocument(target);
          }
        }}
        onCancel={() => {
          if (!pending) {
            setPendingDocument(null);
          }
        }}
      />

      <ConfirmDialog
        open={pendingInteraction !== null}
        title="删除联系记录"
        description={pendingInteraction ? `确认删除「${pendingInteraction.subject}」？该操作不可撤销。` : undefined}
        confirmLabel="删除"
        danger
        pending={pending}
        onConfirm={() => {
          const target = pendingInteraction;
          setPendingInteraction(null);
          if (target) {
            handleDeleteInteraction(target);
          }
        }}
        onCancel={() => {
          if (!pending) {
            setPendingInteraction(null);
          }
        }}
      />

      <ConfirmDialog
        open={mergeOpen}
        title="合并客户（不可撤销）"
        description={`「${account.name}」将被并入目标客户：联系人迁移过去，源客户归档并保留编码与合并记录。此操作不可撤销，请确认目标客户无误。`}
        confirmLabel="确认合并"
        danger
        pending={pending}
        confirmDisabled={!mergeTarget || !mergeReason.trim()}
        onConfirm={handleMerge}
        onCancel={() => {
          if (!pending) {
            setMergeOpen(false);
          }
        }}
      >
        <div className="mb-4 space-y-3">
          <label className="block">
            <span className={fieldLabel}>合并到 *</span>
            <Select
              className="w-full"
              value={mergeTarget}
              onValueChange={setMergeTarget}
              options={[
                { value: "", label: "请选择目标客户" },
                ...mergeCandidates.map((candidate) => ({
                  value: candidate.id,
                  label: `${candidate.name}（${candidate.code}）`,
                })),
              ]}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>合并原因 *</span>
            <input
              className={input}
              value={mergeReason}
              onChange={(event) => setMergeReason(event.target.value)}
              maxLength={200}
              placeholder="如：同一集团重复建档（必填，写入合并记录）"
            />
          </label>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除联系人"
        description={pendingDelete ? `确认删除「${pendingDelete.name}」？该操作不可撤销。` : undefined}
        confirmLabel="删除"
        danger
        pending={pending}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) {
            handleDeleteContact(target);
          }
        }}
        onCancel={() => {
          if (!pending) {
            setPendingDelete(null);
          }
        }}
      />
    </div>
  );
}
