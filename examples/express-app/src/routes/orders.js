import express, { Router } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";

export const orders = Router();

const OrderBody = z.object({
  customer: z.object({ name: z.string().min(1), email: z.email() }),
  // Nobody should send a password with an order; this one does, so Hoplens shows it redacted.
  password: z.string().optional(),
  items: z.array(z.object({ productId: z.number().int().min(1).max(30), qty: z.number().int().min(1).max(10) })).min(1),
});

/**
 * SEEDED CASE (body + redaction): the JSON body is parsed by express.json and validated with zod. In
 * Hoplens the request body shows the customer email as sent and `password` as redacted. An invalid
 * body throws a ZodError, which the error middleware turns into a 400.
 */
orders.post("/", express.json(), async (req, res) => {
  const body = OrderBody.parse(req.body);
  const user = await pool.query("select id from users where email = $1", [body.customer.email]);
  const userId = user.rows[0]?.id ?? 1;
  // One statement (no transaction): the order row and its items.
  const { rows } = await pool.query(
    `with o as (insert into orders (user_id, status) values ($1, 'pending') returning id)
     insert into order_items (order_id, product_id, qty, price_cents)
       select o.id, p.id, x.qty, p.price_cents
         from o, jsonb_to_recordset($2::jsonb) as x(product_id int, qty int) join products p on p.id = x.product_id
     returning order_id`,
    [userId, JSON.stringify(body.items.map((i) => ({ product_id: i.productId, qty: i.qty })))],
  );
  res.status(201).json({ id: rows[0]?.order_id ?? null, userId, items: body.items.length });
});
