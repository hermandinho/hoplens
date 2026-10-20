import { pool } from "../lib/db.js";

// The data access the product and order routes share. Every exported function here shows up in
// Hoplens as a function hop under the route's handler hop, with its queries nested inside it.

const BY_ID = "select id, name, category, price_cents, stock from products where id = $1";

/** One product by id, or null. */
export async function findProduct(id) {
  const { rows } = await pool.query(BY_ID, [id]);
  return rows[0] ?? null;
}

/** The short form of a product shown on an order line, or null. */
export async function productSummary(id) {
  const { rows } = await pool.query("select id, name, category from products where id = $1", [id]);
  return rows[0] ?? null;
}

/** One page of products. Fine: one query. */
export async function listProducts(limit) {
  const { rows } = await pool.query("select id, name, category, price_cents from products order by id limit $1", [
    limit,
  ]);
  return rows;
}
