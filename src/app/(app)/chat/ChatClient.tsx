"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BrandMark } from "@/components/brand/BrandMark";
import {
  AttachmentIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  KnowledgeIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  ShareIcon,
  TrashIcon,
} from "@/components/ui/icons";
import {
  alert,
  badge,
  bodyText,
  btnBlue,
  btnGhost,
  type Tone,
} from "@/components/knowledge/tokens";
import type { ThreadDetail, ThreadSummary } from "@/lib/runtime/threads";

import {
  addThreadToKnowledgeAction,
  deleteThreadAction,
  pinThreadAction,
  renameThreadAction,
} from "./actions";

interface Usage {
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

interface StepInfo {
  key: string;
  ord: number;
  phase: string;
  status: "started" | "done";
  model?: string;
  provider?: string;
  durationMs?: number;
  chars?: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: string;
  error?: string;
  runId?: string;
  steps: StepInfo[];
  usage?: Usage | null;
  attachmentNames?: string[];
}

interface ChatAttachment {
  id: string;
  name: string;
  text: string;
  chars: number;
  truncated?: boolean;
}

interface ChatClientProps {
  chatEnabled: boolean;
  modelName: string;
  fastModelName: string;
  initialThreads: ThreadSummary[];
  initialThread: ThreadDetail | null;
}

type ChatTier = "deep" | "fast";

/** Web Speech API 的最小类型声明（TS 的 DOM lib 尚未内置） */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  interrupted: "已中断",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  missing: "已删除",
};

const PHASE_LABELS: Record<string, string> = {
  answer: "生成回答",
  think: "思考",
  tool_loop: "调用工具",
  compact: "压缩上下文",
};

function statusTone(status?: string): Tone {
  if (status === "done") return "ok";
  if (status === "failed") return "error";
  if (status === "queued" || status === "running") return "blue";
  if (status === "interrupted") return "warn";
  return "muted";
}

function formatCost(micros: number): string {
  return micros > 0 ? `¥${(micros / 1_000_000).toFixed(4)}` : "未配置计价";
}

/** 固定时区与格式，保证服务端与客户端渲染一致（避免 hydration 不匹配） */
const HISTORY_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatWhen(iso: string | null): string {
  if (!iso) {
    return "";
  }
  return HISTORY_TIME_FORMAT.format(new Date(iso));
}

function initialMessages(thread: ThreadDetail | null): Message[] {
  if (!thread) {
    return [];
  }
  const list: Message[] = [];
  for (const item of thread.messages) {
    list.push({
      id: `${item.runId}-user`,
      role: "user",
      text: item.question,
      steps: [],
    });
    list.push({
      id: `${item.runId}-assistant`,
      role: "assistant",
      text: item.answer,
      status: item.status,
      error: item.error ?? undefined,
      runId: item.runId,
      usage: item.usage,
      steps: item.steps.map((step) => ({
        key: `${item.runId}-${step.ord}`,
        ord: step.ord,
        phase: step.phase,
        status: "done" as const,
        model: step.model ?? undefined,
        provider: step.provider ?? undefined,
        durationMs: step.durationMs ?? undefined,
      })),
    });
  }
  return list;
}

/** 打字机：把服务端累计文本按固定节奏展开，避免 400ms 快照造成的整块跳变 */
function TypewriterText({ text, active }: { text: string; active: boolean }) {
  const [shown, setShown] = useState(text);

  useEffect(() => {
    if (text === shown) {
      return;
    }
    if (!text.startsWith(shown)) {
      // 快照回退 / 重连替换：直接对齐，不逐字回删
      setShown(text);
      return;
    }
    const remaining = text.length - shown.length;
    const step = Math.max(1, Math.ceil(remaining / 12));
    const timer = window.setTimeout(() => {
      setShown(text.slice(0, shown.length + step));
    }, 24);
    return () => window.clearTimeout(timer);
  }, [text, shown]);

  return <span className={active ? "chat-caret" : undefined}>{shown}</span>;
}

function ThinkingDots() {
  return (
    <span className="chat-thinking" aria-label="正在思考">
      <i />
      <i />
      <i />
    </span>
  );
}

export function ChatClient({
  chatEnabled,
  modelName,
  fastModelName,
  initialThreads,
  initialThread,
}: ChatClientProps) {
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadSummary[]>(initialThreads);
  const [messages, setMessages] = useState<Message[]>(() => initialMessages(initialThread));
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(initialThread?.id ?? null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [tier, setTier] = useState<ChatTier>("fast");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [listening, setListening] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const autoStarted = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => {
    setThreads(initialThreads);
  }, [initialThreads]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      if (noticeTimer.current) {
        window.clearTimeout(noticeTimer.current);
      }
      if (copiedTimer.current) {
        window.clearTimeout(copiedTimer.current);
      }
    };
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) {
      window.clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const subscribe = useCallback((runId: string, messageId: string) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/runs/${runId}/events?after=0`);
    sourceRef.current = source;

    const update = (patch: Partial<Message> | ((message: Message) => Partial<Message>)) => {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === messageId
            ? { ...message, ...(typeof patch === "function" ? patch(message) : patch) }
            : message,
        ),
      );
    };

    source.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          run: {
            status: string;
            partialText: string;
            result: Record<string, unknown>;
            error: string | null;
            usage: Usage;
          };
        };
        const resultText = typeof data.run.result?.text === "string" ? data.run.result.text : "";
        update({
          status: data.run.status,
          text: resultText || data.run.partialText || "",
          usage: data.run.usage,
          error: data.run.error ?? undefined,
        });
      } catch {
        // 忽略无法解析的帧
      }
    });

    source.addEventListener("event", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          type: string;
          payload: Record<string, unknown>;
        };

        if (data.type === "step") {
          const ord = Number(data.payload.ord ?? 0);
          const started = data.payload.status === "started";
          update((message) => {
            const steps = [...message.steps];
            const index = steps.findIndex((step) => step.ord === ord);
            const previous = index >= 0 ? steps[index] : null;
            const next: StepInfo = {
              key: previous?.key ?? `${ord}-${Date.now()}`,
              ord,
              phase: typeof data.payload.phase === "string" ? data.payload.phase : "answer",
              status: started ? "started" : "done",
              model: typeof data.payload.model === "string" ? data.payload.model : previous?.model,
              provider:
                typeof data.payload.provider === "string" ? data.payload.provider : previous?.provider,
              durationMs:
                typeof data.payload.duration_ms === "number"
                  ? data.payload.duration_ms
                  : previous?.durationMs,
              chars: typeof data.payload.chars === "number" ? data.payload.chars : previous?.chars,
            };
            if (index >= 0) {
              steps[index] = next;
            } else {
              steps.push(next);
            }
            return { steps };
          });
          return;
        }

        if (data.type === "status") {
          update({ status: typeof data.payload.status === "string" ? data.payload.status : "running" });
          return;
        }
        if (data.type === "done") {
          update({ status: "done", error: undefined });
          return;
        }
        if (data.type === "cancelled") {
          update({ status: "cancelled" });
          return;
        }
        if (data.type === "error") {
          update({
            status: "failed",
            error: typeof data.payload.error === "string" ? data.payload.error : "执行失败",
          });
        }
      } catch {
        // 忽略无法解析的帧
      }
    });

    source.addEventListener("delta", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (typeof data.text === "string") {
          update({ text: data.text });
        }
      } catch {
        // 忽略无法解析的帧
      }
    });

    source.addEventListener("usage", (event) => {
      try {
        update({ usage: JSON.parse((event as MessageEvent).data) as Usage });
      } catch {
        // 忽略无法解析的帧
      }
    });

    source.addEventListener("state", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          status?: string;
          error?: string | null;
        };
        update({
          status: data.status,
          error: data.error ?? undefined,
        });
      } catch {
        // 忽略无法解析的帧
      }
    });

    source.addEventListener("end", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          status?: string;
          error?: string | null;
          result?: Record<string, unknown>;
          usage?: Usage;
        };
        update((message) => ({
          status: data.status ?? message.status,
          text:
            typeof data.result?.text === "string" && data.result.text.length > 0
              ? data.result.text
              : message.text,
          usage: data.usage ?? message.usage,
          error: data.error ?? undefined,
        }));
      } catch {
        // 忽略无法解析的帧
      }
      source.close();
      sourceRef.current = null;
      setActiveRunId(null);
    });

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setActiveRunId(null);
      }
    };
  }, []);

  // 打开历史会话时，如果最后一轮仍在执行，自动续接到事件流
  useEffect(() => {
    if (autoStarted.current) {
      return;
    }
    autoStarted.current = true;
    const last = initialThread?.messages[initialThread.messages.length - 1];
    if (!last || (last.status !== "queued" && last.status !== "running")) {
      return;
    }
    setActiveRunId(last.runId);
    subscribe(last.runId, `${last.runId}-assistant`);
  }, [initialThread, subscribe]);

  useEffect(() => {
    if (!openMenuId) {
      return;
    }
    function onMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-thread-menu]")) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openMenuId]);

  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    function onMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-model-menu]")) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [modelMenuOpen]);

  async function handleAttachFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    const slots = 5 - attachments.length;
    const selected = Array.from(files).slice(0, Math.max(0, slots));
    if (selected.length === 0) {
      showNotice("最多上传 5 个附件");
      return;
    }

    setUploading(true);
    for (const file of selected) {
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/chat/attachments", { method: "POST", body: form });
        const data = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; name?: string; text?: string; chars?: number; truncated?: boolean }
          | null;
        if (!response.ok || !data?.ok || !data.name || !data.text) {
          showNotice(data?.error ?? `${file.name} 解析失败`);
          continue;
        }
        const name = data.name;
        const text = data.text;
        const truncated = Boolean(data.truncated);
        const chars = data.chars ?? text.length;
        setAttachments((previous) => [
          ...previous,
          {
            id: crypto.randomUUID(),
            name,
            text,
            chars,
            truncated,
          },
        ]);
        if (truncated) {
          showNotice(`${name} 内容较长，已截取前 ${chars} 字`);
        }
      } catch {
        showNotice(`${file.name} 上传失败`);
      }
    }
    setUploading(false);
  }

  function toggleVoice() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      showNotice("当前浏览器不支持语音输入，请使用 Chrome 或 Edge");
      return;
    }

    const recognition = new Ctor();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index]?.[0]?.transcript ?? "";
      }
      const text = transcript.trim();
      if (text) {
        setInput((previous) => (previous.length > 0 ? `${previous} ${text}` : text));
      }
    };
    recognition.onerror = () => {
      setListening(false);
      showNotice("语音识别失败，请检查麦克风权限");
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
    } catch {
      showNotice("无法启动语音输入");
    }
  }

  function removeAttachment(id: string) {
    setAttachments((previous) => previous.filter((item) => item.id !== id));
  }

  async function submitQuestion(question: string, files: ChatAttachment[]) {
    if (!question || submitting || !chatEnabled || activeRunId) {
      return;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: question,
      steps: [],
      attachmentNames: files.map((item) => item.name),
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      text: "",
      status: "queued",
      steps: [],
    };

    setMessages((previous) => [...previous, userMessage, assistantMessage]);
    setInput("");
    setSubmitting(true);

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "chat",
          input: {
            question,
            modelTier: tier,
            ...(files.length > 0
              ? { attachments: files.map((item) => ({ name: item.name, text: item.text })) }
              : {}),
          },
          threadId: threadId ?? undefined,
          clientTurnId: crypto.randomUUID(),
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; runId?: string; threadId?: string | null; status?: string }
        | null;

      if (!response.ok || !data?.ok || !data.runId) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  status: "failed",
                  error: data?.error ?? `受理失败（HTTP ${response.status}）`,
                }
              : message,
          ),
        );
        return;
      }

      setThreadId(data.threadId ?? null);
      setAttachments([]);
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId
            ? { ...message, runId: data.runId, status: data.status ?? "queued" }
            : message,
        ),
      );
      setActiveRunId(data.runId);
      subscribe(data.runId, assistantId);

      // 新会话需要在左侧历史里出现；刷新只更新服务端 props，不会重建当前流
      if (data.threadId) {
        router.refresh();
      }
    } catch {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId
            ? { ...message, status: "failed", error: "网络异常，未能提交执行" }
            : message,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function send() {
    const question =
      input.trim() || (attachments.length > 0 ? "请阅读附件内容并给出要点总结。" : "");
    if (!question) {
      return;
    }
    await submitQuestion(question, [...attachments]);
  }

  /** 重做：取该回答对应的问题，在同一会话里追加一轮新的执行 */
  async function regenerate(message: Message) {
    if (submitting || !chatEnabled || activeRunId) {
      return;
    }
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0) {
      return;
    }
    let question = "";
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role === "user") {
        question = messages[cursor].text;
        break;
      }
    }
    if (!question) {
      showNotice("找不到对应的问题，无法重做");
      return;
    }
    await submitQuestion(question, []);
  }

  async function copyAnswer(message: Message) {
    if (!message.text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedId(message.id);
      if (copiedTimer.current) {
        window.clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1600);
      showNotice("回答已复制");
    } catch {
      showNotice("复制失败，请手动选择文本");
    }
  }

  async function cancelActive() {
    if (!activeRunId || canceling) {
      return;
    }
    setCanceling(true);
    try {
      await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
    } catch {
      // 事件流会给出最终状态；这里不额外提示
    } finally {
      setCanceling(false);
    }
  }

  function newConversation() {
    if (activeRunId) {
      return;
    }
    sourceRef.current?.close();
    sourceRef.current = null;
    setMessages([]);
    setThreadId(null);
    setOpenMenuId(null);
    setRenamingId(null);
    router.replace("/chat");
  }

  async function handleRename(thread: ThreadSummary) {
    const title = renameValue.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    const result = await renameThreadAction(thread.id, title);
    showNotice(result.message);
    if (result.ok) {
      setThreads((previous) =>
        previous.map((item) => (item.id === thread.id ? { ...item, title } : item)),
      );
      setRenamingId(null);
    }
  }

  async function handlePin(thread: ThreadSummary) {
    const next = !thread.pinned;
    const result = await pinThreadAction(thread.id, next);
    showNotice(result.message);
    if (!result.ok) {
      return;
    }
    setOpenMenuId(null);
    setThreads((previous) =>
      [...previous.map((item) => (item.id === thread.id ? { ...item, pinned: next } : item))].sort(
        (a, b) => {
          if (a.pinned !== b.pinned) {
            return a.pinned ? -1 : 1;
          }
          const at = new Date(a.lastRunAt ?? a.createdAt).getTime();
          const bt = new Date(b.lastRunAt ?? b.createdAt).getTime();
          return bt - at;
        },
      ),
    );
  }

  async function handleDelete(thread: ThreadSummary) {
    setOpenMenuId(null);
    if (!window.confirm(`删除「${thread.title}」？会话会从列表移除，执行记录仍保留。`)) {
      return;
    }
    const result = await deleteThreadAction(thread.id);
    showNotice(result.message);
    if (!result.ok) {
      return;
    }
    setThreads((previous) => previous.filter((item) => item.id !== thread.id));
    if (threadId === thread.id) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setMessages([]);
      setThreadId(null);
      setActiveRunId(null);
      router.replace("/chat");
    }
  }

  async function handleAddToKnowledge(thread: ThreadSummary) {
    setOpenMenuId(null);
    const result = await addThreadToKnowledgeAction(thread.id);
    showNotice(result.message);
  }

  async function handleShare(thread: ThreadSummary) {
    setOpenMenuId(null);
    const url = `${window.location.origin}/chat?thread=${thread.id}`;
    try {
      await navigator.clipboard.writeText(url);
      showNotice("分享链接已复制，同部门成员可在浏览器打开");
    } catch {
      showNotice(`分享链接：${url}`);
    }
  }

  const tracked = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const running = tracked?.status === "queued" || tracked?.status === "running";
  const activeThread = threads.find((thread) => thread.id === threadId) ?? null;
  const activeTitle = activeThread?.title ?? initialThread?.title ?? "新对话";
  const activePinned = activeThread?.pinned ?? initialThread?.pinned ?? false;

  return (
    <div className="grid w-full gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-stretch">
      <aside className="flex min-h-0 flex-col gap-3 lg:h-[calc(100vh-8.25rem)] lg:sticky lg:top-6">
        <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-hairline bg-white shadow-card">
          <div className="flex items-center justify-between px-4 pb-1 pt-4">
            <p className="text-[13px] font-semibold text-zinc-900">聊天</p>
          </div>

          <div className="px-3 pb-2 pt-2">
            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-apple-blue/25 bg-white px-3 py-2 text-[13px] font-medium text-apple-blue transition-colors hover:bg-apple-blue-soft disabled:cursor-not-allowed disabled:opacity-40"
              onClick={newConversation}
              disabled={Boolean(activeRunId)}
            >
              <PlusIcon size={15} />
              新对话
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {threads.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-zinc-400">
                还没有历史对话
              </p>
            ) : null}

            {threads.map((thread) => {
              const active = thread.id === threadId;
              return (
                <div
                  key={thread.id}
                  data-thread-menu
                  className={`mb-0.5 rounded-xl transition-colors ${
                    active ? "bg-[#e8efff]" : "hover:bg-black/[0.035]"
                  }`}
                >
                  {renamingId === thread.id ? (
                    <div className="px-2 py-2">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleRename(thread);
                          }
                          if (event.key === "Escape") {
                            setRenamingId(null);
                          }
                        }}
                        maxLength={60}
                        className="w-full rounded-lg border-0 bg-white px-2 py-1.5 text-[13px] text-zinc-900 outline-none ring-1 ring-apple-blue/25 focus:ring-2 focus:ring-apple-blue/30"
                        aria-label="会话名称"
                      />
                      <div className="mt-1.5 flex justify-end gap-1">
                        <button
                          type="button"
                          className="rounded-lg px-2 py-1 text-[11px] text-zinc-500 hover:bg-black/[0.04]"
                          onClick={() => setRenamingId(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-apple-blue px-2 py-1 text-[11px] font-medium text-white hover:bg-apple-blue-hover"
                          onClick={() => void handleRename(thread)}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 px-1.5 py-1.5">
                      <Link
                        href={`/chat?thread=${thread.id}`}
                        className="min-w-0 flex-1 rounded-lg px-1 py-0.5"
                        aria-current={active ? "page" : undefined}
                      >
                        <span className="flex items-center gap-1.5">
                          {thread.pinned ? (
                            <PinIcon size={12} className="shrink-0 text-apple-blue" />
                          ) : null}
                          <span
                            className={`min-w-0 flex-1 truncate text-[13px] ${
                              active ? "font-medium text-apple-blue" : "text-zinc-800"
                            }`}
                            title={thread.title}
                          >
                            {thread.title}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-[10px] text-zinc-400">
                            {thread.status === "queued" || thread.status === "running" ? (
                              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-apple-blue" />
                            ) : null}
                            {formatWhen(thread.lastRunAt ?? thread.createdAt)}
                          </span>
                        </span>
                      </Link>
                      <button
                        type="button"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-700"
                        aria-label="会话操作"
                        aria-expanded={openMenuId === thread.id}
                        onClick={() => setOpenMenuId(openMenuId === thread.id ? null : thread.id)}
                      >
                        <MoreIcon size={15} />
                      </button>
                    </div>
                  )}

                  {openMenuId === thread.id && renamingId !== thread.id ? (
                    <div className="mx-2 mb-2 flex flex-col rounded-xl bg-white p-1 ring-1 ring-black/[0.06]">
                      <button
                        type="button"
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-black/[0.04]"
                        onClick={() => {
                          setOpenMenuId(null);
                          setRenamingId(thread.id);
                          setRenameValue(thread.title);
                        }}
                      >
                        <EditIcon size={13} className="text-zinc-400" />
                        重命名
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-black/[0.04]"
                        onClick={() => void handlePin(thread)}
                      >
                        <PinIcon size={13} className="text-zinc-400" />
                        {thread.pinned ? "取消固定" : "固定"}
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-black/[0.04]"
                        onClick={() => void handleShare(thread)}
                      >
                        <ShareIcon size={13} className="text-zinc-400" />
                        分享
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-black/[0.04]"
                        onClick={() => void handleAddToKnowledge(thread)}
                      >
                        <KnowledgeIcon size={13} className="text-zinc-400" />
                        添加到知识库
                      </button>
                      <button
                        type="button"
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-rose-600 hover:bg-rose-50"
                        onClick={() => void handleDelete(thread)}
                      >
                        <TrashIcon size={13} />
                        删除
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex max-h-[42%] shrink-0 flex-col rounded-2xl border border-hairline bg-white p-4 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-zinc-900">运行轨迹</p>
            <span className={badge(statusTone(tracked?.status))}>
              {STATUS_LABELS[tracked?.status ?? "queued"] ?? tracked?.status ?? "暂无执行"}
            </span>
          </div>

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
            {tracked?.runId ? (
              <>
                <ul className="mt-1 flex flex-col gap-2">
                  {tracked.steps.length === 0 ? (
                    <li className="rounded-xl bg-apple-canvas px-3 py-2 text-[12px] text-zinc-500">
                      {running ? "等待 worker 领取…" : "暂无步骤"}
                    </li>
                  ) : (
                    tracked.steps.map((step) => (
                      <li key={step.key} className="rounded-xl bg-apple-canvas px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-medium text-zinc-800">
                            {PHASE_LABELS[step.phase] ?? step.phase}
                          </span>
                          <span className="text-[10px] text-zinc-500">
                            {step.status === "started"
                              ? "进行中"
                              : step.durationMs
                                ? `${step.durationMs} ms`
                                : "完成"}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[10px] text-zinc-500">
                          {step.model ?? modelName}
                          {step.chars ? ` · ${step.chars} 字` : ""}
                        </p>
                      </li>
                    ))
                  )}
                </ul>

                <div className="mt-3 rounded-xl border border-hairline px-3 py-2">
                  <p className="text-[11px] font-semibold text-zinc-700">Token 消耗</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    输入 {tracked.usage?.promptTokens ?? 0} · 输出{" "}
                    {tracked.usage?.completionTokens ?? 0}
                    <br />
                    {formatCost(tracked.usage?.costMicros ?? 0)}
                  </p>
                </div>
              </>
            ) : (
              <p className="mt-1 rounded-xl bg-apple-canvas px-3 py-4 text-[12px] leading-relaxed text-zinc-500">
                提交问题后，这里会显示领取到执行的步骤、模型与用量。
              </p>
            )}
          </div>
        </section>
      </aside>

      <section className="flex min-h-[32rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-hairline bg-white shadow-card lg:h-[calc(100vh-8.25rem)]">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-hairline px-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-1.5">
            {activePinned ? (
              <PinIcon size={13} className="shrink-0 text-apple-blue" />
            ) : null}
            <span className="truncate text-[13px] font-semibold text-zinc-900">{activeTitle}</span>
          </div>
        </div>

        {!chatEnabled ? (
          <div className={`${alert("error")} m-4`}>
            AI 生成未启用（缺少 Key 或 JXF_AI_ENABLED=false），当前只能受理任务但不能生成回答。
          </div>
        ) : null}

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite">
          {messages.length === 0 ? (
            <div className="flex min-h-[24rem] flex-col items-center justify-center gap-6 py-10 text-center">
              <BrandMark size="md" />
              <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">
                解决问题从一个对话开始
              </h2>
            </div>
          ) : null}

          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-apple-blue px-4 py-2.5 text-[13px] leading-relaxed text-white">
                  <p className="whitespace-pre-wrap break-words">{message.text}</p>
                  {message.attachmentNames && message.attachmentNames.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {message.attachmentNames.map((name) => (
                        <span
                          key={name}
                          className="inline-flex max-w-full items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] text-white/90"
                        >
                          <AttachmentIcon size={10} />
                          <span className="max-w-[10rem] truncate">{name}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div key={message.id} className="flex gap-2.5">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-apple-canvas text-[11px] font-semibold text-zinc-600">
                  AI
                </span>
                <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-apple-canvas px-4 py-2.5">
                  {message.text ? (
                    <p className={`${bodyText} whitespace-pre-wrap text-zinc-800`}>
                      <TypewriterText
                        text={message.text}
                        active={message.runId === activeRunId && running}
                      />
                    </p>
                  ) : message.status === "queued" || message.status === "running" ? (
                    <div className="flex items-center gap-2 py-1 text-[12px] text-zinc-500">
                      <ThinkingDots />
                      <span>正在思考并生成…</span>
                    </div>
                  ) : (
                    <p className={`${bodyText} text-zinc-500`}>
                      {message.error ?? "没有返回内容"}
                    </p>
                  )}

                  {message.text && message.error ? (
                    <p className="mt-2 text-[11px] text-rose-600">{message.error}</p>
                  ) : null}

                  {message.status === "done" && message.text ? (
                    <div className="mt-2 flex items-center gap-1">
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => void regenerate(message)}
                        disabled={Boolean(activeRunId) || submitting}
                        aria-label="重做"
                        title="重做"
                      >
                        <RefreshIcon size={13} />
                      </button>
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-700"
                        onClick={() => void copyAnswer(message)}
                        aria-label={copiedId === message.id ? "已复制" : "复制"}
                        title={copiedId === message.id ? "已复制" : "复制"}
                      >
                        {copiedId === message.id ? (
                          <CheckIcon size={13} className="text-emerald-600" />
                        ) : (
                          <CopyIcon size={13} />
                        )}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ),
          )}
          <div ref={bottomRef} />
        </div>

        <div className="px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
          {attachments.length > 0 || uploading ? (
            <div className="mb-2 flex flex-wrap gap-1.5 px-1">
              {attachments.map((item) => (
                <span
                  key={item.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-apple-canvas px-2.5 py-1 text-[11px] text-zinc-600"
                >
                  <AttachmentIcon size={12} className="shrink-0 text-zinc-400" />
                  <span className="max-w-[10rem] truncate" title={item.name}>
                    {item.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-zinc-400">{item.chars} 字</span>
                  <button
                    type="button"
                    className="shrink-0 text-zinc-400 transition-colors hover:text-zinc-700"
                    onClick={() => removeAttachment(item.id)}
                    aria-label={`移除 ${item.name}`}
                  >
                    <CloseIcon size={12} />
                  </button>
                </span>
              ))}
              {uploading ? (
                <span className="inline-flex items-center rounded-full bg-apple-canvas px-2.5 py-1 text-[11px] text-zinc-500">
                  解析中…
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-2xl bg-apple-canvas px-3 pb-2 pt-2.5">
            <textarea
              className="w-full resize-none border-0 bg-transparent px-1 py-1 text-[13px] leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400"
              rows={2}
              value={input}
              placeholder={
                chatEnabled ? "发消息给 AI 工作台，支持上传 PDF / DOCX / 文本" : "AI 未启用"
              }
              disabled={!chatEnabled || Boolean(activeRunId)}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />

            <div className="mt-1.5 flex items-center justify-end gap-0.5">
              <div className="relative mr-1" data-model-menu>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-900"
                  onClick={() => setModelMenuOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={modelMenuOpen}
                >
                  {tier === "fast" ? fastModelName : modelName}
                  <ChevronIcon
                    size={12}
                    className={`transition-transform ${modelMenuOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {modelMenuOpen ? (
                  <div
                    role="listbox"
                    className="absolute bottom-full right-0 z-20 mb-1.5 w-60 rounded-xl bg-white p-1 shadow-[0_16px_40px_-26px_rgba(0,0,0,0.4)] ring-1 ring-black/[0.06]"
                  >
                    {[
                      { value: "deep" as ChatTier, label: modelName, hint: "深度推理，适合复杂问题" },
                      {
                        value: "fast" as ChatTier,
                        label: fastModelName,
                        hint: "响应更快，适合轻量问答",
                      },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={tier === option.value}
                        className={`flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-black/[0.04] ${
                          tier === option.value ? "bg-apple-blue-soft" : ""
                        }`}
                        onClick={() => {
                          setTier(option.value);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="text-[12px] font-medium text-zinc-900">{option.label}</span>
                        <span className="text-[10px] text-zinc-500">{option.hint}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="flex items-center gap-0.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.log"
                  className="hidden"
                  onChange={(event) => {
                    const files = event.target.files;
                    event.target.value = "";
                    void handleAttachFiles(files);
                  }}
                />
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || attachments.length >= 5 || Boolean(activeRunId)}
                  aria-label="上传附件"
                  title="上传附件"
                >
                  <AttachmentIcon size={16} />
                </button>
                <button
                  type="button"
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-black/[0.05] ${
                    listening ? "text-rose-600" : "text-zinc-500 hover:text-zinc-800"
                  }`}
                  onClick={toggleVoice}
                  disabled={Boolean(activeRunId)}
                  aria-label={listening ? "停止语音输入" : "语音输入"}
                  title={listening ? "停止语音输入" : "语音输入"}
                >
                  {listening ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
                </button>
                {running ? (
                  <button
                    type="button"
                    className={`${btnGhost} h-8 px-3`}
                    onClick={() => void cancelActive()}
                    disabled={canceling}
                  >
                    {canceling ? "中止中…" : "中止"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`${btnBlue} ml-3 h-8 px-3.5`}
                  onClick={() => void send()}
                  disabled={
                    !chatEnabled ||
                    submitting ||
                    Boolean(activeRunId) ||
                    (input.trim().length === 0 && attachments.length === 0)
                  }
                >
                  {submitting ? "受理中…" : "发送"}
                </button>
              </div>
            </div>
          </div>

          <p className="mt-1.5 px-1 text-[10px] leading-relaxed text-zinc-400">
            {activeRunId
              ? "执行中，关闭页面不会中止任务"
              : threadId
                ? "同一会话连续追问，Enter 发送 / Shift+Enter 换行"
                : "新会话将从第一条问题创建"}
          </p>
        </div>
      </section>

      {notice ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-zinc-900 px-4 py-2 text-[12px] text-white shadow-lg">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
