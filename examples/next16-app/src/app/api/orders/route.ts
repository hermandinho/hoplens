import { NextResponse } from "next/server";
import { CreateOrder } from "@/lib/schemas";
import { createOrder } from "@/lib/store";
import { recordOrder } from "@/lib/audit";

export async function POST(request: Request) {
  const body = await request.json();
  const result = CreateOrder.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ issues: result.error.issues }, { status: 400 });
  }
  console.log("creating order for", result.data.productId);
  const order = await createOrder(result.data.productId, result.data.qty);
  await recordOrder(order.id);
  return NextResponse.json(order, { status: 201 });
}
