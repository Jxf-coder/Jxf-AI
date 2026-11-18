"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useTransition, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";

import { ChevronDown, SlidersHorizontal } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  card,
  cardDesc,
  cardHead,
  emptyState,
  fieldLabel,
  fileInput,
  formGrid,
  gradeBadge,
  headerRow,
  input,
  meta,
  pageSubtitle,
  pageTitle,
  pageWrap,
  segmented,
  segmentedActive,
  segmentedIdle,
} from "@/components/knowledge/tokens";
import type { CrmDictionaryFieldOptions } from "@/lib/crm/dictionary";

import {
  assignAccount,
  claimAccount,
  commitAccountImport,
  confirmKeyAccount,
  createAccount,
  decideClaimRequest,
  previewAccountImport,
  releaseAccount,
  requestClaimAccount,
  type ImportPreview,
} from "./actions";

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  companyName: string;
  country: string;
  region: string;
  source: string;
  grade: string;
  email: string;
  contactStatus: string;
  poolStatus: string;
  icpScore: number | null;
  ownerId: string | null;
  ownerName: string;
  releasedReason: string;
  protectionUntil: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface AssignCandidate {
  id: string;
  name: string;
  departmentName: string;
}

export interface ClaimRequestView {
  id: string;
  accountId: string;
  requesterUserId: string;
  requesterName: string;
  requesterLevel: string;
  createdAt: string;
}

type PoolView = "mine" | "pool" | "key";

const VIEWS: { key: PoolView; label: string; href: string }[] = [
  { key: "mine", label: "我的客户", href: "/crm/accounts" },
  { key: "pool", label: "公共池", href: "/crm/accounts?view=pool" },
  { key: "key", label: "重点池", href: "/crm/accounts?view=key" },
];

type ColumnKey = "name" | "code" | "grade" | "email" | "source" | "status" | "owner" | "createdAt";

const COLUMNS: { key: ColumnKey; label: string; width: number; minWidth: number; required?: boolean }[] = [
  { key: "name", label: "客户名称", width: 200, minWidth: 120, required: true },
  { key: "code", label: "客户编号", width: 110, minWidth: 92, required: true },
  { key: "grade", label: "等级", width: 76, minWidth: 56 },
  { key: "email", label: "邮箱", width: 190, minWidth: 120, required: true },
  { key: "source", label: "来源", width: 100, minWidth: 70 },
  { key: "status", label: "跟进状态", width: 110, minWidth: 84, required: true },
  { key: "owner", label: "跟进人", width: 90, minWidth: 64 },
  { key: "createdAt", label: "建档时间", width: 150, minWidth: 150 },
];

const DEFAULT_VISIBLE: Record<ColumnKey, boolean> = {
  name: true,
  code: true,
  grade: true,
  email: true,
  source: true,
  status: true,
  owner: true,
  createdAt: true,
};

const COLUMN_STORAGE_KEY = "crm.accounts.columns.v1";

const CONTACT_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "error" | "blue" | "muted" }> = {
  untouched: { label: "未触达", tone: "muted" },
  mailed: { label: "已发邮件", tone: "blue" },
  wechat: { label: "已加微信", tone: "blue" },
  replied: { label: "有回复", tone: "ok" },
  no_reply: { label: "无二次回复", tone: "warn" },
  unreachable: { label: "无法联系", tone: "error" },
};

const rowBtn =
  "whitespace-nowrap rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-40";
const rowPrimary = `${rowBtn} bg-apple-blue text-white hover:bg-apple-blue-hover`;
const rowGhost = `${rowBtn} bg-apple-canvas text-zinc-700 hover:bg-[#eef0f4]`;
/** 待办类动作（如领用审批）用琥珀色提醒，避免被常规按钮淹没 */
const rowNotice =
  `${rowBtn} bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 hover:bg-amber-100`;
/** 行内「操作」触发器：白底细描边胶囊，与抽屉菜单一起保持轻量质感 */
const rowMenuBtn =
  `${rowBtn} inline-flex items-center gap-1 bg-white text-zinc-700 shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-inset ring-black/[0.06] hover:bg-apple-canvas`;

const ROW_MENU_WIDTH = 168;

interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "danger";
}

const VIEW_COPY: Record<PoolView, { title: string; subtitle: string }> = {
  mine: {
    title: "我的客户",
    subtitle: "已有负责人的私海客户。置公需要填写原因，主管可直接分配。",
  },
  pool: {
    title: "公共池",
    subtitle: "无归属客户。自助领用受私海上限约束，达上限后只能等主管分配。",
  },
  key: {
    title: "重点池",
    subtitle: "AI 初筛达标的高价值客户。候选需主管确认，确认后才可定向分配。",
  },
};

function formatDate(value: string): string {
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
    hour12: false,
  });
}

type DialogState =
  | { kind: "release"; account: AccountRow }
  | { kind: "assign"; account: AccountRow }
  | { kind: "key"; account: AccountRow; confirm: boolean }
  | null;

export function AccountsClient({
  accounts,
  view,
  canWrite,
  canClaim,
  canAssign,
  myUserId,
  myLevel,
  isManager,
  held,
  cap,
  members,
  claimRequests,
  dictOptions,
}: {
  accounts: AccountRow[];
  view: PoolView;
  canWrite: boolean;
  canClaim: boolean;
  canAssign: boolean;
  myUserId: string;
  myLevel: "L1" | "L2" | "L3";
  isManager: boolean;
  held: number;
  cap: number | null;
  members: AssignCandidate[];
  claimRequests: ClaimRequestView[];
  dictOptions: CrmDictionaryFieldOptions;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [reason, setReason] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [createError, setCreateError] = useState("");
  const [assignSearch, setAssignSearch] = useState("");
  const [claimAccountId, setClaimAccountId] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    accountId: string;
    top: number;
    left: number;
    items: RowAction[];
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const [importOpen, setImportOpen] = useState(false);

  /** 列表展示时把字典编码翻回中文，未收录的历史值原样显示 */
  function dictLabel(key: keyof CrmDictionaryFieldOptions, value: string): string {
    if (!value) {
      return "";
    }
    const hit = dictOptions[key].find((item) => item.code === value);
    return hit ? hit.label : value;
  }
  const [csvText, setCsvText] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>(DEFAULT_VISIBLE);
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(
    () =>
      Object.fromEntries(COLUMNS.map((column) => [column.key, column.width])) as Record<ColumnKey, number>,
  );
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnsReady, setColumnsReady] = useState(false);
  const resizeRef = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          visible?: Partial<Record<ColumnKey, boolean>>;
          widths?: Partial<Record<ColumnKey, number>>;
        };
        setVisibleColumns((prev) => {
          const next = { ...prev };
          for (const column of COLUMNS) {
            if (column.required) {
              next[column.key] = true;
              continue;
            }
            const value = parsed.visible?.[column.key];
            if (typeof value === "boolean") {
              next[column.key] = value;
            }
          }
          return next;
        });
        setColumnWidths((prev) => {
          const next = { ...prev };
          for (const column of COLUMNS) {
            const value = parsed.widths?.[column.key];
            if (typeof value === "number" && Number.isFinite(value)) {
              next[column.key] = Math.max(column.minWidth, Math.min(480, value));
            }
          }
          return next;
        });
      }
    } catch {
      // 本机列配置损坏时回落默认
    }
    setColumnsReady(true);
  }, []);

  useEffect(() => {
    if (!columnsReady) {
      return;
    }
    try {
      window.localStorage.setItem(
        COLUMN_STORAGE_KEY,
        JSON.stringify({ visible: visibleColumns, widths: columnWidths }),
      );
    } catch {
      // 隐私模式下写入失败不影响使用
    }
  }, [columnsReady, visibleColumns, columnWidths]);

  // 行内操作菜单是 fixed 定位，滚动、缩放或点到别处即收起，避免菜单漂在错误位置
  useEffect(() => {
    if (!rowMenu) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-row-menu]")) {
        return;
      }
      setRowMenu(null);
    }
    function onViewportChange() {
      setRowMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRowMenu(null);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [rowMenu]);

  function toggleRowMenu(
    accountId: string,
    items: RowAction[],
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    if (rowMenu?.accountId === accountId) {
      setRowMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    // 估算菜单高度用于上下翻转，保证贴边时不越出视口
    const estimated = 12 + items.length * 30;
    const top =
      rect.bottom + 6 + estimated > window.innerHeight
        ? Math.max(8, rect.top - estimated - 6)
        : rect.bottom + 6;
    const left = Math.max(
      8,
      Math.min(rect.right - ROW_MENU_WIDTH, window.innerWidth - ROW_MENU_WIDTH - 8),
    );
    setRowMenu({ accountId, top, left, items });
  }

  function toggleColumn(key: ColumnKey) {
    const column = COLUMNS.find((item) => item.key === key);
    if (!column || column.required) {
      return;
    }
    setVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function startResize(key: ColumnKey, event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    const column = COLUMNS.find((item) => item.key === key);
    resizeRef.current = { key, startX: event.clientX, startWidth: columnWidths[key] };
    function onMove(moveEvent: MouseEvent) {
      const state = resizeRef.current;
      if (!state) {
        return;
      }
      const width = Math.max(
        column?.minWidth ?? 60,
        Math.min(480, state.startWidth + moveEvent.clientX - state.startX),
      );
      setColumnWidths((prev) => ({ ...prev, [state.key]: width }));
    }
    function onUp() {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const shownColumns = COLUMNS.filter((column) => visibleColumns[column.key]);
  const gridTemplate = `${shownColumns.map((column) => `${columnWidths[column.key]}px`).join(" ")} 1fr`;
  const gridMinWidth = shownColumns.reduce((total, column) => total + columnWidths[column.key], 0) + 140;

  function renderCell(account: AccountRow, key: ColumnKey) {
    const status = CONTACT_STATUS[account.contactStatus] ?? {
      label: account.contactStatus || "—",
      tone: "muted" as const,
    };
    switch (key) {
      case "name":
        return (
          <div className="min-w-0">
            <Link
              href={`/crm/accounts/${account.id}`}
              className="block truncate text-[13.5px] font-semibold text-zinc-900 hover:text-apple-blue"
              title={account.companyName || account.name}
            >
              {account.name}
            </Link>
            {view === "pool" && account.releasedReason ? (
              <p className="truncate text-[11px] text-zinc-400" title={account.releasedReason}>
                置公原因：{account.releasedReason}
              </p>
            ) : null}
          </div>
        );
      case "code":
        return <span className="truncate text-[11px] text-zinc-400">{account.code}</span>;
      case "grade":
        return account.grade ? (
          <span className={gradeBadge(account.grade)}>{account.grade} 级</span>
        ) : (
          <span className="text-[11px] text-zinc-300">—</span>
        );
      case "email":
        return (
          <span className="truncate text-[12px] text-zinc-500" title={account.email}>
            {account.email || "—"}
          </span>
        );
      case "source":
        return (
          <span className="truncate text-[12px] text-zinc-500" title={dictLabel("source", account.source)}>
            {dictLabel("source", account.source) || "—"}
          </span>
        );
      case "status":
        return <span className={badge(status.tone)}>{status.label}</span>;
      case "owner":
        return (
          <span className="truncate text-[12px] text-zinc-500" title={account.ownerName}>
            {account.ownerName}
          </span>
        );
      case "createdAt":
        return (
          <span className="whitespace-nowrap text-[11px] text-zinc-400">
            {formatDate(account.createdAt)}
          </span>
        );
      default:
        return null;
    }
  }

  const copy = VIEW_COPY[view];

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      const result = await createAccount({
        name: String(formData.get("name") ?? ""),
        companyName: String(formData.get("companyName") ?? ""),
        region: String(formData.get("region") ?? ""),
        country: String(formData.get("country") ?? ""),
        source: String(formData.get("source") ?? ""),
        grade: String(formData.get("grade") ?? ""),
        customerType: String(formData.get("customerType") ?? ""),
        email: String(formData.get("email") ?? ""),
        website: String(formData.get("website") ?? ""),
        phoneNote: String(formData.get("phoneNote") ?? ""),
      });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setCreateError("");
        setOpen(false);
      } else {
        setCreateError(result.message);
        setNotice(null);
      }
    });
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsvText(String(reader.result ?? ""));
      setImportPreview(null);
    };
    reader.readAsText(file, "utf-8");
  }

  function handlePreviewImport() {
    startTransition(async () => {
      const result = await previewAccountImport({ csv: csvText });
      if (result.ok) {
        setImportPreview(result.preview);
        setNotice({
          kind: result.preview.summary.error > 0 ? "error" : "info",
          text: `校验完成：可导入 ${result.preview.summary.ok} 条，${result.preview.summary.error} 行需修正`,
        });
      } else {
        setImportPreview(null);
        setNotice({ kind: "error", text: result.message });
      }
    });
  }

  function handleCommitImport() {
    startTransition(async () => {
      const result = await commitAccountImport({ csv: csvText });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setImportPreview(result.preview);
        setCsvText("");
      }
    });
  }

  function handleClaim(account: AccountRow) {
    setRowMenu(null);
    startTransition(async () => {
      const direct = myLevel === "L1";
      const result = direct
        ? await claimAccount({ accountId: account.id })
        : await requestClaimAccount({ accountId: account.id });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        if (direct) {
          router.push("/crm/accounts");
        } else {
          router.refresh();
        }
      }
    });
  }

  function handleDecideClaim(requestId: string, approve: boolean) {
    startTransition(async () => {
      const result = await decideClaimRequest({ requestId, approve });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        router.refresh();
      }
    });
  }

  function handleDialogConfirm() {
    if (!dialog) {
      return;
    }
    const current = dialog;
    startTransition(async () => {
      const result =
        current.kind === "release"
          ? await releaseAccount({ accountId: current.account.id, reason })
          : current.kind === "assign"
            ? await assignAccount({
                accountId: current.account.id,
                toUserId: assignTo,
                reason,
              })
            : await confirmKeyAccount({
                accountId: current.account.id,
                confirm: current.confirm,
                reason,
              });
      setNotice({ kind: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setDialog(null);
      }
    });
  }

  function openDialog(next: DialogState) {
    setRowMenu(null);
    setDialog(next);
    setReason("");
    setAssignTo("");
    setAssignSearch("");
    setNotice(null);
  }

  // 只有重点池分配强制说明原因；公共池与私海内调整归属不强制（与 app.crm_pool_assign 的校验一致）
  const reasonRequired =
    dialog?.kind === "key" ||
    (dialog?.kind === "assign" &&
      (dialog.account.poolStatus === "key" || dialog.account.poolStatus === "key_pending"));
  const confirmDisabled =
    dialog?.kind === "release" || dialog?.kind === "key"
      ? !reason.trim()
      : !assignTo || (reasonRequired && !reason.trim());

  const assignQuery = assignSearch.trim();
  const matchedMembers = members.filter(
    (member) =>
      assignQuery.length === 0 ||
      member.name.includes(assignQuery) ||
      member.departmentName.includes(assignQuery),
  );
  const selectedMember = members.find((member) => member.id === assignTo);
  const visibleMembers =
    selectedMember && !matchedMembers.some((member) => member.id === selectedMember.id)
      ? [selectedMember, ...matchedMembers]
      : matchedMembers;
  const claimDialogRequests = claimAccountId
    ? claimRequests.filter(
        (request) =>
          request.accountId === claimAccountId &&
          request.requesterUserId !== myUserId &&
          (myLevel === "L1" || (myLevel === "L2" && request.requesterLevel === "L3")),
      )
    : [];
  const claimDialogAccount = accounts.find((account) => account.id === claimAccountId) ?? null;

  return (
    <div className={pageWrap}>
      <div className={headerRow}>
        <div>
          <h1 className={pageTitle}>{copy.title}</h1>
          <p className={pageSubtitle}>{copy.subtitle}</p>
        </div>
        <div className={actions}>
          {view === "mine" ? (
            <span className={badge(cap && held >= cap ? "warn" : "muted")}>
              持有 {held} / {cap && cap > 0 ? cap : "不限"}
            </span>
          ) : null}
          {/* 列表按可见范围返回，持有只算本人：两者不同时显式标出，避免把可见条数误读成持有量 */}
          {view === "mine" && accounts.length !== held ? (
            <span className={badge("muted")} title="列表还包含下属（L1 为全租户）的私海客户">
              可见 {accounts.length} 条
            </span>
          ) : null}
          {view === "mine" && canWrite ? (
            <button
              type="button"
              className={btnBlue}
              onClick={() => {
                setCreateError("");
                setOpen(true);
              }}
            >
              新增客户
            </button>
          ) : null}
          {view === "mine" && canWrite ? (
            <button type="button" className={btnGhost} onClick={() => setImportOpen(true)}>
              批量导入
            </button>
          ) : null}
          <div className="relative">
            <button
              type="button"
              className={btnGhost}
              onClick={() => setColumnsOpen((value) => !value)}
              aria-expanded={columnsOpen}
              title="选择显示列"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              显示列
            </button>
            {columnsOpen ? (
              <div className="absolute right-0 top-11 z-30 w-64 rounded-2xl border border-black/[0.06] bg-white p-3 shadow-xl">
                <p className="mb-2 text-[12px] font-semibold text-zinc-900">显示列</p>
                <ul className="space-y-1.5">
                  {COLUMNS.map((column) => (
                    <li key={column.key}>
                      <label
                        className={`flex items-center gap-2 text-[12px] ${
                          column.required ? "text-zinc-400" : "text-zinc-700"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={visibleColumns[column.key]}
                          disabled={column.required}
                          onChange={() => toggleColumn(column.key)}
                          className="h-3.5 w-3.5 rounded border-zinc-300"
                        />
                        <span>{column.label}</span>
                        {column.required ? (
                          <span className="ml-auto text-[10px] text-zinc-400">必显</span>
                        ) : null}
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
                  拖动表头分隔线可调整列宽，配置保存在本机浏览器。
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <div className={segmented}>
          {VIEWS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={item.key === view ? segmentedActive : segmentedIdle}
              aria-current={item.key === view ? "page" : undefined}
            >
              {item.label}
            </Link>
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

      <Modal
        open={importOpen && canWrite && view === "mine"}
        title="批量导入客户"
        description="CSV 预览后确认写入 · 单次最多 500 行"
        pending={pending}
        onClose={() => {
          if (!pending) {
            setImportOpen(false);
          }
        }}
        footer={
          <>
            <button type="button" className={btnGhost} onClick={() => setImportOpen(false)} disabled={pending}>
              关闭
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={handlePreviewImport}
              disabled={pending || !csvText.trim()}
            >
              {pending ? "校验中…" : "预览校验"}
            </button>
            {importPreview && importPreview.summary.ok > 0 && csvText.trim() ? (
              <button type="button" className={btnBlue} onClick={handleCommitImport} disabled={pending}>
                {pending ? "导入中…" : `确认导入 ${importPreview.summary.ok} 条`}
              </button>
            ) : null}
          </>
        }
      >
        <p className={`${cardDesc} mb-3`}>
          支持选择 CSV 文件或直接粘贴。必填列：客户名称、邮箱、客户等级、客户类型；可选列：公司名称、国家、区域、客户来源、网址、备注。先预览校验，确认后再写入。
        </p>
        <div className="space-y-3">
          <label className="block">
            <span className={fieldLabel}>选择 CSV 文件</span>
            <input type="file" accept=".csv,text/csv" className={fileInput} onChange={handleFile} />
          </label>
          <label className="block">
            <span className={fieldLabel}>或直接粘贴 CSV</span>
            <textarea
              className={`${input} min-h-[120px] font-mono text-[12px]`}
              value={csvText}
              onChange={(event) => {
                setCsvText(event.target.value);
                setImportPreview(null);
              }}
              placeholder={"客户名称,公司名称,国家,邮箱\nAcme Trading,Acme LLC,美国,buyer@acme.com"}
            />
          </label>
        </div>

        {importPreview ? (
          <div className="mt-4">
            <div className={cardHead}>
              <h3 className="text-[13px] font-semibold text-zinc-900">逐行回执</h3>
              <span className={meta}>
                共 {importPreview.summary.total} 行 · 可导入 {importPreview.summary.ok} · 异常{" "}
                {importPreview.summary.error}
              </span>
            </div>
            <ul className="mt-2 max-h-72 divide-y divide-black/[0.04] overflow-auto">
              {importPreview.rows.map((row) => (
                <li key={`${row.line}-${row.name}`} className="flex items-start gap-3 py-2 text-[12px]">
                  <span className="w-10 shrink-0 text-zinc-400">#{row.line}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-700">
                    {row.name || "（空名称）"}
                  </span>
                  {row.status === "ok" ? (
                    <span className="shrink-0 text-emerald-600">可导入</span>
                  ) : (
                    <span className="shrink-0 text-rose-600">{row.errors.join("；")}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Modal>

      <section className={`${card} mt-4`}>
        <div className="relative">
          <div className="overflow-x-auto">
            <div style={{ minWidth: gridMinWidth }}>
              <div
                className="grid items-center border-b border-black/[0.06] pb-2 text-[11px] font-medium text-zinc-400"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                {shownColumns.map((column, index) => (
                  <div
                    key={column.key}
                    className={`relative flex min-w-0 items-center pr-3 ${index === 0 ? "" : "pl-3"}`}
                  >
                    <span className="truncate">{column.label}</span>
                    <span
                      role="separator"
                      aria-label={`调整${column.label}列宽`}
                      onMouseDown={(event) => startResize(column.key, event)}
                      className="group absolute right-0 top-1/2 z-10 flex h-5 w-2 -translate-y-1/2 translate-x-1/2 cursor-col-resize items-center justify-center"
                    >
                      <span className="h-2.5 w-px bg-[#EBEBEB] transition-colors group-hover:bg-apple-blue" />
                    </span>
                  </div>
                ))}
                <div className="sticky right-0 z-10 flex items-center justify-end gap-2 bg-white pl-2 shadow-[inset_1px_0_0_rgba(0,0,0,0.04)]">
                  <span className="text-[11px] font-normal text-zinc-400">{accounts.length} 条</span>
                  <span>操作</span>
                </div>
              </div>

              {accounts.length === 0 ? (
                <p className={`${emptyState} mt-3`}>
                  {view === "pool"
                    ? "公共池暂时没有客户。"
                    : view === "key"
                      ? "暂无重点池客户或候选。"
                      : "还没有客户。可以新增建档，或去公共池领用。"}
                </p>
              ) : (
                <ul className="divide-y divide-black/[0.04]">
                  {accounts.map((account) => {
                    const isMine = account.ownerId === myUserId;
                    const canRelease = view === "mine" && canWrite && (isMine || isManager);
                    const myPendingClaim = claimRequests.some(
                      (request) =>
                        request.accountId === account.id && request.requesterUserId === myUserId,
                    );
                    const approvableClaims = claimRequests.filter(
                      (request) =>
                        request.accountId === account.id &&
                        request.requesterUserId !== myUserId &&
                        (myLevel === "L1" ||
                          (myLevel === "L2" && request.requesterLevel === "L3")),
                    );
                    const rowActions: RowAction[] = [];
                    if (view === "pool" && canClaim) {
                      rowActions.push(
                        myPendingClaim
                          ? {
                              key: "claim",
                              label: "待审批",
                              onSelect: () => {},
                              disabled: true,
                            }
                          : {
                              key: "claim",
                              label: myLevel === "L1" ? "领用" : "领用申请",
                              onSelect: () => handleClaim(account),
                            },
                      );
                    }
                    if (canAssign && (view === "pool" || account.poolStatus === "key")) {
                      rowActions.push({
                        key: "assign",
                        label: "分配",
                        onSelect: () => openDialog({ kind: "assign", account }),
                      });
                    }
                    if (account.poolStatus === "key_pending" && canAssign) {
                      rowActions.push(
                        {
                          key: "key-confirm",
                          label: "确认进重点池",
                          onSelect: () => openDialog({ kind: "key", account, confirm: true }),
                        },
                        {
                          key: "key-demote",
                          label: "降级回公海",
                          onSelect: () => openDialog({ kind: "key", account, confirm: false }),
                          tone: "danger",
                        },
                      );
                    }
                    if (canRelease) {
                      rowActions.push({
                        key: "release",
                        label: "置公",
                        onSelect: () => openDialog({ kind: "release", account }),
                        tone: "danger",
                      });
                    }
                    return (
                      <li
                        key={account.id}
                        className="grid items-center py-2.5"
                        style={{ gridTemplateColumns: gridTemplate }}
                      >
                        {shownColumns.map((column, index) => (
                          <div
                            key={column.key}
                            className={`min-w-0 overflow-hidden pr-3 ${index === 0 ? "" : "pl-3"}`}
                          >
                            {renderCell(account, column.key)}
                          </div>
                        ))}
                        <div className="sticky right-0 z-10 flex items-center justify-end gap-1.5 bg-white pl-2 shadow-[inset_1px_0_0_rgba(0,0,0,0.04)]">
                          {view === "pool" && account.poolStatus === "public" && canAssign && approvableClaims.length > 0 ? (
                            <button
                              type="button"
                              className={rowNotice}
                              onClick={() => setClaimAccountId(account.id)}
                              disabled={pending}
                            >
                              审批 {approvableClaims.length}
                            </button>
                          ) : null}
                          {rowActions.length > 0 ? (
                            <button
                              type="button"
                              data-row-menu
                              className={rowMenuBtn}
                              onClick={(event) => toggleRowMenu(account.id, rowActions, event)}
                              aria-haspopup="menu"
                              aria-expanded={rowMenu?.accountId === account.id}
                              disabled={pending}
                            >
                              操作
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </section>

      <Modal
        open={open && canWrite && view === "mine"}
        title="新增客户"
        description="编码自动生成 · 名称查重"
        pending={pending}
        onClose={() => {
          if (!pending) {
            setCreateError("");
            setOpen(false);
          }
        }}
        footer={
          <>
            {createError ? (
              <p className="mr-auto max-w-[70%] text-[12px] leading-relaxed text-rose-600">{createError}</p>
            ) : null}
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setCreateError("");
                setOpen(false);
              }}
              disabled={pending}
            >
              取消
            </button>
            <button type="submit" form="create-account-form" className={btnBlue} disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <p className={`${cardDesc} mb-3`}>
          名称、邮箱、等级、类型为必填；编码由系统按「C + 年月 + 序号」自动生成，名称会做一次查重。
        </p>
        <form
          id="create-account-form"
          className={formGrid}
          onSubmit={(event) => {
            event.preventDefault();
            handleCreate(new FormData(event.currentTarget));
          }}
        >
          <label>
            <span className={fieldLabel}>客户名称 *</span>
            <input name="name" required maxLength={120} className={input} />
          </label>
          <label>
            <span className={fieldLabel}>电子邮箱 *</span>
            <input name="email" type="email" required maxLength={120} className={input} />
          </label>
          <label>
            <span className={fieldLabel}>客户等级 *</span>
            <Select
              name="grade"
              required
              defaultValue=""
              className="w-full"
              options={[
                { value: "", label: "请选择" },
                { value: "A", label: "A 级" },
                { value: "B", label: "B 级" },
                { value: "C", label: "C 级" },
                { value: "D", label: "D 级" },
              ]}
            />
          </label>
          <label>
            <span className={fieldLabel}>客户类型 *</span>
            {dictOptions.customerType.length > 0 ? (
              <Select
                name="customerType"
                required
                defaultValue=""
                className="w-full"
                options={[
                  { value: "", label: "请选择" },
                  ...dictOptions.customerType.map((item) => ({
                    value: item.code,
                    label: item.label,
                  })),
                ]}
              />
            ) : (
              <input name="customerType" required maxLength={40} className={input} />
            )}
          </label>
          <label>
            <span className={fieldLabel}>公司名称</span>
            <input name="companyName" maxLength={120} className={input} />
          </label>
          <label>
            <span className={fieldLabel}>客户来源</span>
            {dictOptions.source.length > 0 ? (
              <Select
                name="source"
                defaultValue=""
                className="w-full"
                options={[
                  { value: "", label: "未指定" },
                  ...dictOptions.source.map((item) => ({ value: item.code, label: item.label })),
                ]}
              />
            ) : (
              <input name="source" maxLength={40} className={input} placeholder="如：展会" />
            )}
          </label>
          <label>
            <span className={fieldLabel}>区域</span>
            {dictOptions.region.length > 0 ? (
              <Select
                name="region"
                defaultValue=""
                className="w-full"
                options={[
                  { value: "", label: "未指定" },
                  ...dictOptions.region.map((item) => ({ value: item.code, label: item.label })),
                ]}
              />
            ) : (
              <input name="region" maxLength={40} className={input} placeholder="如：北美" />
            )}
          </label>
          <label>
            <span className={fieldLabel}>国家 / 地区</span>
            {dictOptions.country.length > 0 ? (
              <Select
                name="country"
                defaultValue=""
                className="w-full"
                options={[
                  { value: "", label: "未指定" },
                  ...dictOptions.country.map((item) => ({ value: item.code, label: item.label })),
                ]}
              />
            ) : (
              <input name="country" maxLength={40} className={input} />
            )}
          </label>
          <label>
            <span className={fieldLabel}>公司网址</span>
            <input name="website" maxLength={200} className={input} />
          </label>
          <label>
            <span className={fieldLabel}>备注</span>
            <input name="phoneNote" maxLength={200} className={input} placeholder="可先记录联系方式等" />
          </label>
        </form>
      </Modal>

      <ConfirmDialog
        open={dialog !== null}
        title={
          dialog?.kind === "release"
            ? "置入公共池"
            : dialog?.kind === "assign"
              ? "分配给成员"
              : dialog?.kind === "key"
                ? dialog.confirm
                  ? "确认进重点池"
                  : "降级回公海"
                : ""
        }
        description={
          dialog?.kind === "release"
            ? `「${dialog.account.name}」将失去负责人并进入公共池，其他人可以领用。`
            : dialog?.kind === "assign"
              ? `「${dialog.account.name}」将转给所选成员，并重新开始 90 天保护期。`
              : dialog?.kind === "key"
                ? `「${dialog.account.name}」将${dialog.confirm ? "进入重点池，可由主管定向分配" : "降级回普通公海"}。`
                : undefined
        }
        confirmLabel={
          dialog?.kind === "release"
            ? "确认置公"
            : dialog?.kind === "assign"
              ? "确认分配"
              : dialog?.kind === "key"
                ? dialog.confirm
                  ? "确认进重点池"
                  : "确认降级"
                : ""
        }
        danger={dialog?.kind === "release" || (dialog?.kind === "key" && !dialog.confirm)}
        pending={pending}
        confirmDisabled={confirmDisabled}
        onConfirm={handleDialogConfirm}
        onCancel={() => {
          if (!pending) {
            setDialog(null);
          }
        }}
      >
        {dialog?.kind === "release" ? (
          <label className="mb-4 block">
            <span className={fieldLabel}>置公原因 *</span>
            <input
              className={input}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
              placeholder="如：长期无跟进"
            />
          </label>
        ) : dialog?.kind === "assign" ? (
          <div className="mb-4 space-y-3">
            <label className="block">
              <span className={fieldLabel}>搜索成员</span>
              <input
                className={input}
                value={assignSearch}
                onChange={(event) => setAssignSearch(event.target.value)}
                maxLength={40}
                placeholder="输入姓名或部门筛选"
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>分配给 *</span>
              <Select
                className="w-full"
                value={assignTo}
                onValueChange={setAssignTo}
                options={[
                  {
                    value: "",
                    label: visibleMembers.length > 0 ? "请选择成员" : "没有匹配的成员",
                  },
                  ...visibleMembers.map((member) => ({
                    value: member.id,
                    label: `${member.name}（${member.departmentName}）`,
                  })),
                ]}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>分配原因{reasonRequired ? " *" : "（选填）"}</span>
              <input
                className={input}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                placeholder={reasonRequired ? "重点池分配必须说明原因" : "如：区域对口"}
              />
            </label>
          </div>
        ) : dialog?.kind === "key" ? (
          <label className="mb-4 block">
            <span className={fieldLabel}>裁决原因 *</span>
            <input
              className={input}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
              placeholder={dialog.confirm ? "如：年采购额达标" : "如：跟进后确认价值不足"}
            />
          </label>
        ) : null}
      </ConfirmDialog>

      <Modal
        open={claimAccountId !== null}
        title="领用申请审批"
        description={
          claimDialogAccount ? `${claimDialogAccount.name} · ${claimDialogAccount.code}` : undefined
        }
        pending={pending}
        onClose={() => {
          if (!pending) {
            setClaimAccountId(null);
          }
        }}
        footer={
          <button type="button" className={btnGhost} onClick={() => setClaimAccountId(null)}>
            关闭
          </button>
        }
      >
        {claimDialogRequests.length === 0 ? (
          <p className={emptyState}>暂无可审批的领用申请。</p>
        ) : (
          <ul className="divide-y divide-black/[0.04]">
            {claimDialogRequests.map((request) => (
              <li
                key={request.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div>
                  <p className="text-[13px] font-semibold text-zinc-900">
                    {request.requesterName}
                    <span className="ml-1.5 text-[11px] font-normal text-zinc-500">
                      {request.requesterLevel}
                    </span>
                  </p>
                  <p className={meta}>申请于 {formatDate(request.createdAt)}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className={rowPrimary}
                    onClick={() => handleDecideClaim(request.id, true)}
                    disabled={pending}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className={rowGhost}
                    onClick={() => handleDecideClaim(request.id, false)}
                    disabled={pending}
                  >
                    驳回
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {rowMenu ? (
        <div
          data-row-menu
          role="menu"
          className="fixed z-50 w-[168px] overflow-hidden rounded-2xl border border-black/[0.06] bg-white p-1 shadow-[0_10px_30px_rgba(0,0,0,0.12)]"
          style={{ top: rowMenu.top, left: rowMenu.left }}
        >
          {rowMenu.items.map((item, index) => (
            <Fragment key={item.key}>
              {item.tone === "danger" && rowMenu.items[index - 1]?.tone !== "danger" ? (
                <div className="my-1 h-px bg-black/[0.05]" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled || pending}
                onClick={() => {
                  setRowMenu(null);
                  item.onSelect();
                }}
                className={`block w-full whitespace-nowrap rounded-xl px-3 py-1.5 text-left text-[12px] font-medium transition-colors disabled:opacity-40 ${
                  item.tone === "danger"
                    ? "text-rose-600 hover:bg-rose-50"
                    : "text-zinc-700 hover:bg-apple-canvas"
                }`}
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
