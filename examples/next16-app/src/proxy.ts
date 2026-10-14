import { type NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/orders") && request.method !== "GET") {
    const key = request.headers.get("x-api-key");
    if (key !== "dev-key") {
      return NextResponse.json({ error: "Missing or invalid x-api-key" }, { status: 401 });
    }
  }
  const res = NextResponse.next();
  res.headers.set("x-request-id", crypto.randomUUID());
  return res;
}

export const config = { matcher: "/api/:path*" };
