import { auth } from "@/auth";
import { exportAuditEvents, type AuditExportType } from "@/lib/audit-export";
import { resolveUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { PermissionDeniedError } from "@/lib/permissions/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: readonly AuditExportType[] = ["all", "permission", "system"];

function parseDate(raw: string | null): Date | null {
  if (!raw) {
    return null;
  }
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

/** CSV 公式注入防护：以 = + - @ 开头的单元格前置单引号 */
function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 审计导出：format=jsonl（默认）或 csv；范围参数 type / from / to / limit。
 * 权限与可见范围由 exportAuditEvents 内校验。
 */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("未登录", { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const rawType = params.get("type") ?? "all";
  const type = (TYPES as readonly string[]).includes(rawType) ? (rawType as AuditExportType) : "all";
  const format = params.get("format") === "csv" ? "csv" : "jsonl";
  const rawLimit = Number.parseInt(params.get("limit") ?? "10000", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50_000) : 10_000;

  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const from = parseDate(rawFrom);
  const to = parseDate(rawTo);
  if ((rawFrom && !from) || (rawTo && !to)) {
    return new Response("时间参数不合法（需 ISO 8601）", { status: 400 });
  }

  const context = await resolveUserContext(session.user.id);

  try {
    const result = await exportAuditEvents(context, { type, from, to, limit });
    const filename = `audit-${stamp()}-${type}.${format}`;
    const headers = {
      "content-type":
        format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "private, no-store",
    };

    if (format === "csv") {
      const header = [
        "时间",
        "动作",
        "操作人",
        "邮箱",
        "部门",
        "目标类型",
        "目标ID",
        "请求ID",
        "详情",
      ];
      const lines = [header.map(csvCell).join(",")];
      for (const row of result.rows) {
        lines.push(
          [
            row.createdAt,
            row.action,
            row.actorName ?? "",
            row.actorEmail ?? "",
            row.departmentName ?? "",
            row.targetType ?? "",
            row.targetId ?? "",
            row.requestId ?? "",
            row.payload,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      // BOM：让 Excel 正确识别 UTF-8 中文
      return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, { headers });
    }

    const body = result.rows.map((row) => JSON.stringify(row)).join("\n");
    return new Response(body.length > 0 ? `${body}\n` : "", { headers });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return new Response(error.message, { status: 403 });
    }
    log("warn", "audit_export_failed", { error: errorMessage(error) });
    return new Response("导出失败", { status: 500 });
  }
}
