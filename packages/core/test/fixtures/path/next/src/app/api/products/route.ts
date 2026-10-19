import { ProductQuery } from "@/lib/schemas";
import { listProducts } from "@/lib/store";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const parsed = ProductQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  const items = await listProducts(parsed.data.cat, parsed.data.limit);
  return NextResponse.json({ items, count: items.length });
}
