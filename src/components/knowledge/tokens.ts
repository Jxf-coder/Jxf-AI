/**
 * 知识库 UI 设计令牌（FastGPT 风格 · Apple 极简）
 * 仅为 Tailwind 工具类字符串常量，不含任何业务逻辑。
 */

export const pageWrap = "mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8";
export const headerRow = "flex flex-wrap items-start justify-between gap-5";
export const pageTitle = "text-2xl font-semibold tracking-tight text-zinc-900";
export const pageSubtitle = "mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500";

/** 390px：两行胶囊；≥640px：单行胶囊并允许横向滚动 */
export const tabBar =
  "mt-5 flex max-w-full flex-wrap items-center gap-1 rounded-2xl bg-apple-canvas p-1 sm:inline-flex sm:flex-nowrap sm:overflow-x-auto sm:rounded-full [scrollbar-width:none]";
export const tabActive =
  "whitespace-nowrap rounded-full bg-apple-blue-soft px-3 py-1.5 text-[13px] font-semibold text-apple-blue sm:px-4";
export const tabIdle =
  "whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium text-zinc-600 transition-colors hover:text-zinc-900 sm:px-4";

export const card = "mb-4 rounded-2xl border border-hairline bg-white p-4 shadow-card sm:p-6";
export const cardHead = "mb-3 flex items-baseline justify-between gap-4";
export const cardTitle = "text-base font-semibold tracking-tight text-zinc-900";
export const cardDesc = "mb-4 text-[13px] leading-relaxed text-zinc-500";
export const divider = "my-4 h-px bg-black/[0.04]";

export const formGrid = "grid gap-3.5 sm:grid-cols-2";
export const fieldLabel = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
/**
 * input 统一带 w-full；需要按内容或固定宽度的场景改用 inputInline，
 * 否则 Tailwind 生成的 `.w-full` 排在 `w-auto` / `w-[120px]` 之后会把宽度覆盖回去。
 */
const inputBase =
  "rounded-2xl border-0 bg-apple-canvas px-3.5 py-2.5 text-[13px] text-zinc-900 outline-none transition-all duration-200 placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-apple-blue/20 disabled:cursor-not-allowed disabled:opacity-60";
export const input = `w-full ${inputBase}`;
export const inputInline = inputBase;
export const fileInput =
  "w-full rounded-2xl bg-apple-canvas px-3 py-2 text-[13px] text-zinc-600 file:mr-3 file:rounded-xl file:border-0 file:bg-[#eef0f4] file:px-3.5 file:py-1.5 file:text-[12px] file:font-medium file:text-zinc-900 hover:file:bg-[#e6e9ee]";

export const actions = "mt-4 flex flex-wrap items-center gap-2.5";
const btn =
  "inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-medium transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100";
export const btnDark = `${btn} bg-zinc-900 text-white hover:bg-black`;
export const btnBlue = `${btn} bg-apple-blue text-white hover:bg-apple-blue-hover`;
export const btnGhost = `${btn} bg-apple-canvas text-zinc-800 hover:bg-[#eef0f4]`;
export const linkBtn =
  "rounded-lg px-1 py-1 text-[13px] text-apple-blue transition-opacity hover:underline hover:opacity-75 disabled:cursor-default disabled:text-zinc-500 disabled:no-underline";

export type Tone = "ok" | "warn" | "error" | "blue" | "muted";
const badgeBase =
  "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium";
const badgeTones: Record<Tone, string> = {
  ok: "border-emerald-100 bg-emerald-50 text-emerald-600",
  warn: "border-amber-100 bg-amber-50 text-amber-600",
  error: "border-rose-100 bg-rose-50 text-rose-600",
  blue: "border-apple-blue/15 bg-apple-blue-soft text-apple-blue",
  muted: "border-black/[0.04] bg-apple-canvas text-zinc-500",
};
export function badge(tone: Tone = "muted"): string {
  return `${badgeBase} ${badgeTones[tone]}`;
}
export const badgeActive =
  "inline-flex items-center whitespace-nowrap rounded-full border border-apple-blue/15 bg-apple-blue-soft px-2.5 py-0.5 text-[11px] font-semibold text-apple-blue";
export const badgeRow = "mb-3 flex flex-wrap items-center gap-1.5";

export const emptyState =
  "rounded-2xl bg-apple-canvas px-4 py-8 text-center text-[13px] leading-relaxed text-zinc-500";
const alertBase = "mb-4 rounded-2xl border px-4 py-3 text-[13px] leading-relaxed";
export function alert(tone: "info" | "error" = "info"): string {
  return `${alertBase} ${
    tone === "error"
      ? "border-rose-100 bg-rose-50 text-rose-600"
      : "border-apple-blue/10 bg-apple-blue-soft text-[#0a63c4]"
  }`;
}

export const bodyText = "whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-600";
export const evidenceList = "mt-2 flex list-none flex-col gap-2 p-0";
export const evidenceItem = "flex flex-col gap-1 rounded-xl bg-apple-canvas px-3.5 py-3";
export const quote = "break-words text-[13px] leading-relaxed text-zinc-900";
export const meta = "text-[11px] text-zinc-500";
export const inline = "inline-flex flex-wrap items-center gap-2";
