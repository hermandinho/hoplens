import { Router } from "express";
import { pool } from "../lib/db.js";

export const report = Router();

/**
 * SEEDED PROBLEM (big payload): one cheap query, then every line item is expanded into a verbose export
 * row, ~2 MB of JSON in one response. Hoplens shows the response size and a large-payload finding; the
 * fix is pagination or a summary.
 */
report.get("/", async (_req, res) => {
  const { rows } = await pool.query(
    `select i.order_id, o.user_id, o.status, i.product_id, p.name as product, i.qty, i.price_cents
       from order_items i join orders o on o.id = i.order_id join products p on p.id = i.product_id
      order by i.order_id, i.product_id`,
  );
  const lines = [];
  for (let copy = 0; copy < 16; copy++) {
    for (const r of rows) {
      lines.push({
        ...r,
        batch: copy,
        totalCents: r.qty * r.price_cents,
        note: `export row ${copy}-${r.order_id}-${r.product_id}: ${"lorem ipsum ".repeat(4)}`,
      });
    }
  }
  res.json({ generatedAt: new Date().toISOString(), count: lines.length, lines });
});
