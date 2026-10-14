const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Order = { id: string; productId: string; qty: number; status: "pending" | "paid" };
const orders = new Map<string, Order>([
  [
    "9c1e7a52-4b0d-4e1a-9a55-1f3c2e8d0b77",
    { id: "9c1e7a52-4b0d-4e1a-9a55-1f3c2e8d0b77", productId: "p_1", qty: 1, status: "paid" },
  ],
]);

export async function listProducts(cat: string, limit: number) {
  await wait(12);
  return Array.from({ length: limit }, (_, i) => ({
    id: `${cat}_${i + 1}`,
    name: `${cat} #${i + 1}`,
    price: 25 + i * 5,
  }));
}

export async function createOrder(productId: string, qty: number) {
  await wait(18);
  const order: Order = { id: crypto.randomUUID(), productId, qty, status: "pending" };
  orders.set(order.id, order);
  return order;
}

export async function getOrder(id: string) {
  await wait(6);
  return orders.get(id) ?? null;
}

export async function payOrder(id: string) {
  const order = await getOrder(id);
  if (!order) throw new Error(`Order ${id} not found`);
  if (order.status === "paid") throw new Error("Order already paid");
  order.status = "paid";
  return order;
}
