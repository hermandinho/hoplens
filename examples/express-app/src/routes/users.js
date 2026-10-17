import { Router } from "express";
import { pool } from "../lib/db.js";

// Mounted at /api/users/:uid; mergeParams makes :uid visible here.
export const userOrders = Router({ mergeParams: true });

/** The user's orders (ids only). Fine: one query. */
userOrders.get("/orders", async (req, res) => {
  const { rows } = await pool.query("select id, status from orders where user_id = $1 order by id", [
    Number(req.params.uid),
  ]);
  res.json(rows);
});

/**
 * SEEDED PROBLEM (N+1): loads the order and its line items, then each item's product with one query per
 * item. Hoplens shows the repeated `select ... from products where id = $1` under the handler hop and an
 * n-plus-1 finding pointing at the loop. The fix is a join (or `where id = any($1)`).
 */
userOrders.get("/orders/:id", async (req, res) => {
  const uid = Number(req.params.uid);
  const id = Number(req.params.id);
  const order = await pool.query("select id, user_id, status, created_at from orders where id = $1 and user_id = $2", [
    id,
    uid,
  ]);
  if (order.rows.length === 0) {
    res.status(404).json({ error: "order not found", uid, id });
    return;
  }
  const items = await pool.query("select product_id, qty, price_cents from order_items where order_id = $1", [id]);
  const lines = [];
  for (const item of items.rows) {
    const product = await pool.query("select id, name, category from products where id = $1", [item.product_id]);
    lines.push({ ...item, product: product.rows[0] ?? null });
  }
  res.json({ ...order.rows[0], items: lines });
});
