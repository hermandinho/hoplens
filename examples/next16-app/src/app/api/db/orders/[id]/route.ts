import { getOrder, getOrderItems } from "@/lib/db";
import { NextResponse } from "next/server";

// Duplicate query: the order row is loaded once to check it exists and again to build the response,
// same SQL and same params. Seeded order ids are 1..300.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Order id must be a positive integer" }, { status: 422 });
  }
  if (!(await getOrder(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [order, items] = await Promise.all([getOrder(id), getOrderItems(id)]);
  const totalCents = items.reduce((sum, i) => sum + i.qty * i.price_cents, 0);
  return NextResponse.json({ ...order, items, totalCents });
}
