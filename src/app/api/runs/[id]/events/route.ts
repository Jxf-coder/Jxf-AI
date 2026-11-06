import { auth } from "@/auth";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { log, errorMessage } from "@/lib/logger";
import { PermissionDeniedError } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";
import {
  closeRunStreamClient,
  isTerminalRunStatus,
  loadRunEventsAfter,
  loadRunSnapshot,
  openRunStreamClient,
  type RunSnapshot,
} from "@/lib/runtime/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 300;
const PING_MS = 15_000;

function formatFrame(event: string, data: unknown, id?: number): Uint8Array {
  const lines: string[] = [];
  if (id !== undefined) {
    lines.push(`id: ${id}`);
  }
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return new TextEncoder().encode(`${lines.join("\n")}\n\n`);
}

function parseAfter(request: Request, url: URL): number {
  const raw = url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 运行事件流（SSE）。
 *
 * 顺序契约：先推 runs 快照（partial_text / 用量 / 终态结果），再按 after=seq 补发
 * durable 事件，之后持续推送 delta / usage / state。断线重连带 Last-Event-ID 即可续上。
 * delta 不落事件表，只来自 worker 对 runs.partial_text 的节流快照。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return Response.json({ ok: false, error: "runId 不是合法 UUID" }, { status: 400 });
  }

  const context = await resolveUserContext(session.user.id);
  if (!context.activeDepartmentId) {
    return Response.json({ ok: false, error: "当前账号没有有效部门上下文" }, { status: 403 });
  }
  const departmentId = context.activeDepartmentId;

  // 读权限先过能力门禁；具体某条 run 是否可见仍由 RLS 逐行判定
  try {
    await withUserContext(context, (client) =>
      requireContextPermission(client, context, "skill:use", {
        kind: "department",
        id: departmentId,
        departmentId,
      }),
    );
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return Response.json({ ok: false, error: error.message }, { status: 403 });
    }
    throw error;
  }

  const after = parseAfter(request, new URL(request.url));

  let client: Awaited<ReturnType<typeof openRunStreamClient>> | null = null;
  try {
    client = await openRunStreamClient(context);
    const snapshot = await loadRunSnapshot(client, id);
    if (!snapshot) {
      await closeRunStreamClient(client);
      return Response.json({ ok: false, error: "执行不存在或无权访问" }, { status: 404 });
    }

    const stream = buildStream(request, client, id, after, snapshot);
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    if (client) {
      await closeRunStreamClient(client);
    }
    log("error", "runtime_stream_failed", {
      run_id: id,
      user_id: context.userId,
      error: errorMessage(error),
    });
    return Response.json({ ok: false, error: "事件流建立失败" }, { status: 500 });
  }
}

function buildStream(
  request: Request,
  client: Awaited<ReturnType<typeof openRunStreamClient>>,
  runId: string,
  after: number,
  initial: RunSnapshot,
): ReadableStream<Uint8Array> {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    wake?.();
    wake = null;
    request.signal.removeEventListener("abort", onAbort);
    await closeRunStreamClient(client);
    try {
      streamController?.close();
    } catch {
      // 已经关闭
    }
  };

  const onAbort = () => {
    void close();
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        timer = null;
        wake = null;
        resolve();
      }, ms);
    });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      request.signal.addEventListener("abort", onAbort, { once: true });

      const send = (event: string, data: unknown, id?: number) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(formatFrame(event, data, id));
        } catch {
          void close();
        }
      };

      void (async () => {
        let cursor = after;
        let lastPartial = initial.partialText;
        let lastStatus = initial.status;
        let lastUsage = JSON.stringify(initial.usage);
        let lastPing = Date.now();

        try {
          controller.enqueue(new TextEncoder().encode("retry: 2000\n\n"));
          // 1. 先推快照：断线重连不必靠事件重放也能立即渲染已有文本
          send("snapshot", { run: initial }, initial.lastSeq);

          // 2. 再补发 after 之后的事件；3. 之后持续跟踪
          while (!closed) {
            const events = await loadRunEventsAfter(client, runId, cursor);
            for (const event of events) {
              cursor = event.seq;
              send("event", event, event.seq);
            }

            const current = await loadRunSnapshot(client, runId);
            if (!current) {
              send("end", { status: "missing", error: "执行已删除", result: {}, usage: initial.usage });
              break;
            }

            if (current.partialText !== lastPartial) {
              lastPartial = current.partialText;
              send("delta", { text: current.partialText, lastSeq: current.lastSeq });
            }

            const usage = JSON.stringify(current.usage);
            if (usage !== lastUsage) {
              lastUsage = usage;
              send("usage", current.usage);
            }

            if (current.status !== lastStatus) {
              lastStatus = current.status;
              send("state", {
                status: current.status,
                error: current.error,
                cancelRequested: current.cancelRequested,
              });
            }

            if (isTerminalRunStatus(current.status)) {
              send(
                "end",
                {
                  status: current.status,
                  error: current.error,
                  result: current.result,
                  usage: current.usage,
                  lastSeq: current.lastSeq,
                },
                current.lastSeq,
              );
              break;
            }

            if (events.length === 0) {
              await sleep(POLL_MS);
            }

            if (Date.now() - lastPing >= PING_MS) {
              lastPing = Date.now();
              if (!closed) {
                try {
                  controller.enqueue(new TextEncoder().encode(": ping\n\n"));
                } catch {
                  void close();
                }
              }
            }
          }
        } catch (error) {
          if (!closed) {
            log("warn", "runtime_stream_interrupted", {
              run_id: runId,
              error: errorMessage(error),
            });
          }
        } finally {
          await close();
        }
      })();
    },
    cancel() {
      void close();
    },
  });
}
