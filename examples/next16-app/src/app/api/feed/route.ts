import { buildFeedFast, buildFeedSlow } from "@/lib/external";
import { FeedQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

// N+1 over fetch: /api/feed loads each post's author one by one; /api/feed?fast=1 batches them.
export async function GET(req: NextRequest) {
  const parsed = FeedQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  const { limit, fast } = parsed.data;
  const items = fast === "1" ? await buildFeedFast(limit) : await buildFeedSlow(limit);
  return NextResponse.json({ strategy: fast === "1" ? "batched" : "n+1", count: items.length, items });
}
