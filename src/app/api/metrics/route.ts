/**
 * 可观测性：聚合指标端点。
 *
 * GET /api/metrics              → JSON（版本 + 各状态计数）
 * GET /api/metrics?format=prometheus → Prometheus 文本格式
 *
 * 只返回聚合计数，不含用户 / 文档明细；数据来自 SECURITY DEFINER 的
 * app.metrics_snapshot()，不受应用角色 RLS 的部门范围影响。
 * 配置 METRICS_TOKEN 后要求 `Authorization: Bearer <token>`。
 */

import { getPool } from "@/lib/db/pool";
import { errorMessage, log } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface MetricsSnapshot {
  generated_at: string;
  runs: Record<string, number>;
  work_items: Record<string, number>;
  ops_tasks: Record<string, number>;
  connectors: { total: number; healthy: number; degraded: number; down: number; unknown: number };
  pipelines: { total: number; enabled: number };
  pipeline_runs_open: number;
  audit_events: number;
  users: number;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  lines.push("# HELP jxf_up 应用是否可提供聚合指标");
  lines.push("# TYPE jxf_up gauge");
  lines.push("jxf_up 1");

  for (const [status, count] of Object.entries(snapshot.runs ?? {})) {
    lines.push(`jxf_runs{status="${status}"} ${number(count)}`);
  }
  for (const [status, count] of Object.entries(snapshot.work_items ?? {})) {
    lines.push(`jxf_work_items{status="${status}"} ${number(count)}`);
  }
  for (const [status, count] of Object.entries(snapshot.ops_tasks ?? {})) {
    lines.push(`jxf_ops_tasks{status="${status}"} ${number(count)}`);
  }

  lines.push(`jxf_connectors{health="healthy"} ${number(snapshot.connectors?.healthy)}`);
  lines.push(`jxf_connectors{health="degraded"} ${number(snapshot.connectors?.degraded)}`);
  lines.push(`jxf_connectors{health="down"} ${number(snapshot.connectors?.down)}`);
  lines.push(`jxf_connectors{health="unknown"} ${number(snapshot.connectors?.unknown)}`);
  lines.push(`jxf_connectors_total ${number(snapshot.connectors?.total)}`);
  lines.push(`jxf_pipelines_total ${number(snapshot.pipelines?.total)}`);
  lines.push(`jxf_pipelines_enabled ${number(snapshot.pipelines?.enabled)}`);
  lines.push(`jxf_pipeline_runs_open ${number(snapshot.pipeline_runs_open)}`);
  lines.push(`jxf_audit_events_total ${number(snapshot.audit_events)}`);
  lines.push(`jxf_users_total ${number(snapshot.users)}`);

  const generatedAt = Date.parse(snapshot.generated_at ?? "");
  if (Number.isFinite(generatedAt)) {
    lines.push(`jxf_metrics_generated_timestamp ${Math.floor(generatedAt / 1000)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function GET(request: Request) {
  const token = process.env.METRICS_TOKEN?.trim();
  if (token) {
    const header = request.headers.get("authorization") ?? "";
    if (header !== `Bearer ${token}`) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  try {
    const { rows } = await getPool().query<{ value: MetricsSnapshot | null }>(
      "select app.metrics_snapshot() as value",
    );
    const snapshot = rows[0]?.value;
    if (!snapshot) {
      return Response.json({ error: "metrics unavailable" }, { status: 503 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get("format") === "prometheus") {
      return new Response(toPrometheus(snapshot), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }

    return Response.json({
      version: process.env.JXF_VERSION ?? "0.1.0",
      ...snapshot,
    });
  } catch (caught) {
    log("error", "metrics_snapshot_failed", { error: errorMessage(caught) });
    return Response.json({ error: "metrics unavailable" }, { status: 503 });
  }
}
