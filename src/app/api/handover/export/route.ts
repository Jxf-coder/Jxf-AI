import { auth } from "@/auth";
import { resolveUserContext } from "@/lib/db/user-context";
import { buildHandoverBundle } from "@/lib/handover/export";
import { errorMessage, log } from "@/lib/logger";
import { PermissionDeniedError } from "@/lib/permissions/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 交接包导出：返回可离线归档的 JSON 附件。
 * 权限与数据范围都在 buildHandoverBundle 内按当前身份校验。
 */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("未登录", { status: 401 });
  }

  const membershipId = new URL(request.url).searchParams.get("membershipId") ?? "";
  if (!UUID_PATTERN.test(membershipId)) {
    return new Response("membershipId 不合法", { status: 400 });
  }

  const context = await resolveUserContext(session.user.id);

  try {
    const result = await buildHandoverBundle(context, membershipId);
    if (!result) {
      return new Response("成员不存在或不可见", { status: 404 });
    }

    return new Response(JSON.stringify(result.bundle, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return new Response(error.message, { status: 403 });
    }
    log("warn", "handover_export_failed", {
      membership_id: membershipId,
      error: errorMessage(error),
    });
    return new Response("导出失败", { status: 500 });
  }
}
