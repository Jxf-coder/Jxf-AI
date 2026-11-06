"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  alert,
  badge,
  bodyText,
  btnBlue,
  btnGhost,
  meta,
  type Tone,
} from "@/components/knowledge/tokens";

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
}

interface ChatClientProps {
  departmentName: string | null;
  chatEnabled: boolean;
  modelName: string;
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
  answer: "生成",
  think: "思考",
  tool_loop: "工具",
  compact: "压缩",
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

export function ChatClient({ departmentName, chatEnabled, modelName }: ChatClientProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);

  const sourceRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
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

  async function send() {
    const question = input.trim();
    if (!question || submitting || !chatEnabled || activeRunId) {
      return;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: question,
      steps: [],
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
          input: { question },
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
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId
            ? { ...message, runId: data.runId, status: data.status ?? "queued" }
            : message,
        ),
      );
      setActiveRunId(data.runId);
      subscribe(data.runId, assistantId);
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
  }

  const tracked = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const running = tracked?.status === "queued" || tracked?.status === "running";

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="flex min-h-[32rem] flex-col overflow-hidden rounded-2xl border border-hairline bg-white shadow-card">
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-zinc-900">运行时会话</p>
            <p className="truncate text-[11px] text-zinc-500">
              {departmentName ?? "未选择部门"} · {modelName}
            </p>
          </div>
          <button
            type="button"
            className={`${btnGhost} shrink-0`}
            onClick={newConversation}
            disabled={Boolean(activeRunId)}
          >
            新会话
          </button>
        </div>

        {!chatEnabled ? (
          <div className={`${alert("error")} m-4`}>
            AI 生成未启用（缺少 Key 或 JXF_AI_ENABLED=false），当前只能受理任务但不能生成回答。
          </div>
        ) : null}

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5" aria-live="polite">
          {messages.length === 0 ? (
            <div className="rounded-2xl bg-apple-canvas px-4 py-8 text-center">
              <p className="text-[13px] font-medium text-zinc-900">把任务交给后台 worker</p>
              <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                提交后立即返回 run_id，回答会随模型输出逐字出现；关掉页面任务仍会继续。
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {["用三点说明这个岗位的职责", "把这段需求拆成可交付步骤"].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="rounded-full border border-hairline bg-white px-3 py-1.5 text-[12px] text-zinc-600 transition-colors hover:text-zinc-900"
                    onClick={() => setInput(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-apple-blue px-4 py-2.5 text-[13px] leading-relaxed text-white">
                  <p className="whitespace-pre-wrap break-words">{message.text}</p>
                </div>
              </div>
            ) : (
              <div key={message.id} className="flex gap-2.5">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-apple-canvas text-[11px] font-semibold text-zinc-600">
                  AI
                </span>
                <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-apple-canvas px-4 py-2.5">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className={badge(statusTone(message.status))}>
                      {STATUS_LABELS[message.status ?? "queued"] ?? message.status ?? "排队中"}
                    </span>
                    {message.steps.length > 0 ? (
                      <span className={meta}>第 {message.steps.length} 步</span>
                    ) : null}
                  </div>

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
                </div>
              </div>
            ),
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-hairline p-3 sm:p-4">
          <textarea
            className="w-full resize-none rounded-2xl border-0 bg-apple-canvas px-3.5 py-2.5 text-[13px] leading-relaxed text-zinc-900 outline-none transition-all duration-200 placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-apple-blue/20"
            rows={2}
            value={input}
            placeholder={chatEnabled ? "输入问题，Enter 发送，Shift+Enter 换行" : "AI 未启用"}
            disabled={!chatEnabled || Boolean(activeRunId)}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className={meta}>
              {activeRunId ? "执行中，关闭页面不会中止任务" : threadId ? "同一会话连续追问" : "新会话将从第一条问题创建"}
            </span>
            <div className="flex items-center gap-2">
              {running ? (
                <button type="button" className={btnGhost} onClick={() => void cancelActive()} disabled={canceling}>
                  {canceling ? "中止中…" : "中止"}
                </button>
              ) : null}
              <button
                type="button"
                className={btnBlue}
                onClick={() => void send()}
                disabled={!chatEnabled || submitting || Boolean(activeRunId) || input.trim().length === 0}
              >
                {submitting ? "受理中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <aside className="flex flex-col gap-3">
        <section className="rounded-2xl border border-hairline bg-white p-4 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-zinc-900">运行轨迹</p>
            <span className={badge(statusTone(tracked?.status))}>
              {STATUS_LABELS[tracked?.status ?? "queued"] ?? tracked?.status ?? "暂无执行"}
            </span>
          </div>

          {tracked?.runId ? (
            <>
              <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-zinc-400">
                {tracked.runId}
              </p>

              <ul className="mt-3 flex flex-col gap-2">
                {tracked.steps.length === 0 ? (
                  <li className="rounded-xl bg-apple-canvas px-3 py-2 text-[12px] text-zinc-500">
                    {running ? "等待 worker 领取…" : "暂无步骤"}
                  </li>
                ) : (
                  tracked.steps.map((step) => (
                    <li key={step.key} className="rounded-xl bg-apple-canvas px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] font-medium text-zinc-800">
                          第 {step.ord} 步 · {PHASE_LABELS[step.phase] ?? step.phase}
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
                  输入 {tracked.usage?.promptTokens ?? 0} · 输出 {tracked.usage?.completionTokens ?? 0}
                  <br />
                  {formatCost(tracked.usage?.costMicros ?? 0)}
                </p>
              </div>
            </>
          ) : (
            <p className="mt-3 rounded-xl bg-apple-canvas px-3 py-4 text-[12px] leading-relaxed text-zinc-500">
              提交问题后，这里会显示领取到执行的步骤、模型与用量。
            </p>
          )}
        </section>

        <section className="rounded-2xl bg-apple-canvas px-4 py-3 text-[11px] leading-relaxed text-zinc-500">
          事件流先推快照再补发 seq；断线重连不会重复或漏事件。中止是显式操作，关闭页面不算取消。
        </section>
      </aside>
    </div>
  );
}
