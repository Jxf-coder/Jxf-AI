import { NextResponse, type NextRequest } from "next/server";

import { runReadinessChecks } from "@/lib/health";
import { errorMessage, log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REQUEST_ID_HEADER = "x-request-id";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const report = await runReadinessChecks();
    const status = report.status === "ok" ? 200 : 503;

    log(status === 200 ? "info" : "warn", "health_check", {
      request_id: requestId,
      status: report.status,
      duration_ms: Date.now() - startedAt,
      failed_checks: report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.name),
    });

    return NextResponse.json(
      { ...report, request_id: requestId },
      {
        status,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    log("error", "health_check_failed", {
      request_id: requestId,
      error: errorMessage(error),
      duration_ms: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        status: "degraded",
        service: "web",
        timestamp: new Date().toISOString(),
        request_id: requestId,
        error: errorMessage(error),
      },
      {
        status: 503,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
          "cache-control": "no-store",
        },
      },
    );
  }
}
