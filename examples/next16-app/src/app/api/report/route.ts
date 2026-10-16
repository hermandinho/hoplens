import { listAllProducts } from "@/lib/external";
import { crunchStats, expandRows } from "@/lib/reports";
import { ReportQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

// Slow function + large payload + logs on success:
// - crunchStats() is CPU-bound (slow-fn), tune with ?rounds=
// - ?big=1 returns well over 1MB of JSON (large-payload)
// - a console.warn fires on every successful run (logs-on-success)
export async function GET(req: NextRequest) {
  const parsed = ReportQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  const { big, rounds } = parsed.data;

  const { products } = await listAllProducts(100);
  const stats = crunchStats(products, rounds);
  if (stats.lowStock.length > 0) {
    console.warn(`report: ${stats.lowStock.length} products are low on stock`, stats.lowStock);
  }
  const rows = big === "1" ? expandRows(products, 60) : expandRows(products, 1);
  return NextResponse.json({ stats, rowCount: rows.length, rows });
}
