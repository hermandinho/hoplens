import { pool } from "../lib/db.js";
import { productSummary } from "./products.js";

/** The user's orders (ids only). Fine: one query. */
export async function listUserOrders(uid) {
  const { rows } = await pool.query("select id, status from orders where user_id = $1 order by id", [uid]);
  return rows;
}

/** One order of one user, or null. */
export async function findOrder(uid, id) {
  const { rows } = await pool.query(
    "select id, user_id, status, created_at from orders where id = $1 and user_id = $2",
    [id, uid],
  );
  return rows[0] ?? null;
}

/**
 * SEEDED PROBLEM (N+1): an order's line items, then each item's product with one productSummary() call
 * (one query) per item. Hoplens shows six productSummary hops under orderLines, each with its query, and
 * an n-plus-1 finding pointing at the loop below. The fix is a join (or `where id = any($1)`).
 */
export async function orderLines(orderId) {
  const items = await pool.query("select product_id, qty, price_cents from order_items where order_id = $1", [orderId]);
  const lines = [];
  for (const item of items.rows) {
    lines.push({ ...item, product: await productSummary(item.product_id) });
  }
  return lines;
}
