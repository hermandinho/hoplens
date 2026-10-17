import { Router } from "express";
import { pool } from "../lib/db.js";

export const products = Router();

const BY_ID = "select id, name, category, price_cents, stock from products where id = $1";

/** One page of products. Fine: one query. */
products.get("/", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 30);
  const { rows } = await pool.query("select id, name, category, price_cents from products order by id limit $1", [
    limit,
  ]);
  res.json(rows);
});

async function findProduct(id) {
  const { rows } = await pool.query(BY_ID, [id]);
  return rows[0] ?? null;
}

/**
 * SEEDED PROBLEM (duplicate query): the handler checks the product exists, then loads it again to build
 * the response. Same SQL, same params, twice: Hoplens flags it as a duplicate.
 */
products.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!(await findProduct(id))) {
    res.status(404).json({ error: "product not found", id });
    return;
  }
  const product = await findProduct(id);
  res.json({ ...product, inStock: product.stock > 0 });
});
