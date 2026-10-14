import { traced } from "hoplens/trace";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Not exported, so the auto-tracer skips it; `traced` gives it a hop anyway.
const writeAudit = traced("audit.write", async (event: string, data: Record<string, unknown>) => {
  await wait(3);
  return { event, at: new Date().toISOString(), keys: Object.keys(data) };
});

export async function recordOrder(orderId: string) {
  return writeAudit("order.created", { orderId });
}
