import { type NextRequest, NextResponse } from "next/server";
export function proxy(_req: NextRequest) {
  return NextResponse.next();
}
export const config = {
  matcher: [{ source: "/api/:path*" }, { source: "/dashboard/:path*", has: [{ type: "header", key: "x-admin" }] }],
};
