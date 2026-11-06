import { auth } from "@/auth";
import { resolveUserContext } from "@/lib/db/user-context";
import { log, errorMessage } from "@/lib/logger";
import { PermissionDeniedError } from "@/lib/permissions/guard";
import { requestCancel } from "@/lib/runtime/cancel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  const host = request.headers.get("host");
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 显式中止：只写 cancel_requested_at，worker 在 1s 内感知并停止上游流。
 * SSE 断开不会触发这里，语义与「关闭页面」区分开。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSameOrigin(request)) {
    return Response.json({ ok: false, error: "跨站请求被拒绝" }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return Response.json({ ok: false, error: "runId 不是合法 UUID" }, { status: 400 });
  }

  const context = await resolveUserContext(session.user.id);

  try {
    const requested = await requestCancel(context, id);
    return Response.json({ ok: true, requested });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return Response.json({ ok: false, error: error.message }, { status: 403 });
    }
    const message = errorMessage(error);
    if (message.includes("不存在") || message.includes("无权")) {
      return Response.json({ ok: false, error: message }, { status: 404 });
    }
    log("error", "runtime_cancel_failed", {
      run_id: id,
      user_id: context.userId,
      error: message,
    });
    return Response.json({ ok: false, error: "取消失败" }, { status: 500 });
  }
}
