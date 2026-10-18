import { Router } from "express";
import { findProduct, listProducts } from "../services/products.js";

export const products = Router();

/** One page of products. Fine: one query. */
products.get("/", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 30);
  res.json(await listProducts(limit));
});

/**
 * SEEDED PROBLEM (duplicate query): the handler checks the product exists, then loads it again to build
 * the response. Two findProduct() calls run the same SQL with the same params: Hoplens flags it as a
 * duplicate.
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
