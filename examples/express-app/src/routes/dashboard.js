import { Router } from "express";
import { pool } from "../lib/db.js";

export const dashboard = Router();

/**
 * SEEDED PROBLEM (sequential independent queries): three queries that don't depend on each other are
 * awaited one after another. Hoplens shows them back to back in the waterfall with a parallelizable
 * finding; `Promise.all` would issue them together.
 */
dashboard.get("/", async (_req, res) => {
  const users = await pool.query("select count(*)::int as n from users");
  const revenue = await pool.query("select coalesce(sum(qty * price_cents), 0)::int as cents from order_items");
  const recent = await pool.query(
    "select id, user_id, status, created_at from orders order by created_at desc limit 5",
  );
  res.json({ users: users.rows[0].n, revenueCents: revenue.rows[0].cents, recentOrders: recent.rows });
});
