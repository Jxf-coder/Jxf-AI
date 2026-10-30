import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REQUEST_ID_HEADER = "x-request-id";

/**
 * 存活探针：只证明进程可响应，不依赖数据库 / 对象存储。
 * 就绪探针见 /api/health。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();

  return NextResponse.json(
    { status: "ok", service: "web", timestamp: new Date().toISOString(), request_id: requestId },
    {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        "cache-control": "no-store",
      },
    },
  );
}
