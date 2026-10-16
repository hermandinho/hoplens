import { getProductRating, listProducts, listProductsWithRatings } from "@/lib/db";
import { DbProductsQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

// N+1 over SQL: /api/db/products lists a page of products, then runs one review-stats query per row.
// /api/db/products?fast=1 gets the same data in a single query (CTE + LATERAL join).
export async function GET(req: NextRequest) {
  const parsed = DbProductsQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  const { limit, fast } = parsed.data;
  if (fast === "1") {
    const items = await listProductsWithRatings(limit);
    return NextResponse.json({ strategy: "join", queries: 1, count: items.length, items });
  }
  const products = await listProducts(limit);
  const items = [];
  for (const p of products) items.push({ ...p, ...(await getProductRating(p.id)) });
  return NextResponse.json({ strategy: "n+1", queries: 1 + products.length, count: items.length, items });
}
