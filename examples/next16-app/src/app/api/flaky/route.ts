import { fetchInventory } from "@/lib/external";
import { FlakyQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

const FALLBACK = { source: "fallback" as const, items: [{ sku: "hat-01", onHand: 0 }] };

// Swallowed error: fetchInventory() throws (503 or timeout) and its span records the error, but the
// handler catches it and still answers 200 with stale fallback data.
// ?mode=ok | fail | timeout | random (default: random, ~50% failures).
export async function GET(req: NextRequest) {
  const parsed = FlakyQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  let inventory: Awaited<ReturnType<typeof fetchInventory>> | typeof FALLBACK;
  try {
    inventory = await fetchInventory(parsed.data.mode);
  } catch {
    inventory = FALLBACK;
  }
  return NextResponse.json({ mode: parsed.data.mode, ...inventory });
}
