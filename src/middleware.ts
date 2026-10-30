import { NextResponse, type NextRequest } from "next/server";

import { log } from "@/lib/logger";

const REQUEST_ID_HEADER = "x-request-id";

export function middleware(request: NextRequest): NextResponse {
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REQUEST_ID_HEADER, requestId);

  log("info", "http_request", {
    request_id: requestId,
    method: request.method,
    path: request.nextUrl.pathname,
  });

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
