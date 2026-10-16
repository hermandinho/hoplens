import { searchReviews } from "@/lib/db";
import { DbSearchQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

// Slow query: substring search (ILIKE '%q%') over 200k seeded reviews. No index can serve a leading
// wildcard, so the match count is a full table scan on every request.
export async function GET(req: NextRequest) {
  const parsed = DbSearchQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  const { q, limit } = parsed.data;
  const { total, hits } = await searchReviews(q, limit);
  return NextResponse.json({ q, total, count: hits.length, hits });
}
