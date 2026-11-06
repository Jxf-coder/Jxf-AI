import { auth } from "@/auth";
import { resolveUserContext } from "@/lib/db/user-context";
import { log, errorMessage } from "@/lib/logger";
import { PermissionDeniedError } from "@/lib/permissions/guard";
import { acceptRun } from "@/lib/runtime/accept";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUESTION_LENGTH = 4_000;

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // 同源 fetch 在部分浏览器 / 代理下可能不带 Origin，交给会话 Cookie 兜底
    return true;
  }
  const host = request.headers.get("host");
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readOptionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function readOptionalUuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * 受理一次 AI 执行：只建 queued run 并立即返回 run_id，不在请求生命周期里跑模型。
 *
 * 前端拿到 runId 后订阅 /api/runs/:id/events。
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ ok: false, error: "跨站请求被拒绝" }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ ok: false, error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;

  if (payload.kind !== undefined && payload.kind !== "chat") {
    return Response.json({ ok: false, error: "当前仅支持 chat 类型执行" }, { status: 400 });
  }

  const rawInput =
    payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
      ? (payload.input as Record<string, unknown>)
      : {};
  const question = typeof rawInput.question === "string" ? rawInput.question.trim() : "";
  if (!question) {
    return Response.json({ ok: false, error: "问题不能为空" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return Response.json(
      { ok: false, error: `问题长度不能超过 ${MAX_QUESTION_LENGTH} 字` },
      { status: 400 },
    );
  }

  const threadId = readOptionalUuid(payload.threadId);
  if (payload.threadId && !threadId) {
    return Response.json({ ok: false, error: "threadId 不是合法 UUID" }, { status: 400 });
  }
  const aiEmployeeId = readOptionalUuid(payload.aiEmployeeId);
  if (payload.aiEmployeeId && !aiEmployeeId) {
    return Response.json({ ok: false, error: "aiEmployeeId 不是合法 UUID" }, { status: 400 });
  }

  const context = await resolveUserContext(session.user.id);

  try {
    const accepted = await acceptRun(context, {
      kind: "chat",
      input: { question },
      threadId,
      aiEmployeeId,
      clientTurnId: readOptionalString(payload.clientTurnId, 100),
      title: readOptionalString(payload.title, 80),
    });

    return Response.json(
      {
        ok: true,
        runId: accepted.runId,
        threadId: accepted.threadId,
        status: accepted.status,
        resumed: accepted.resumed,
      },
      { status: accepted.resumed ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return Response.json({ ok: false, error: error.message }, { status: 403 });
    }
    log("error", "runtime_accept_failed", {
      user_id: context.userId,
      department_id: context.activeDepartmentId,
      error: errorMessage(error),
    });
    const message = errorMessage(error);
    const status = message.includes("部门上下文") ? 400 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}
