import { Router } from "express";
import { pool } from "../lib/db.js";

export const failures = Router();

/**
 * SEEDED PROBLEM (async error): about 1 request in 3 rejects after a query. Express 5 forwards the
 * rejected promise to the 4-arg error middleware, which answers 500. Hoplens shows the error on the
 * handler hop and the route's error rate.
 */
failures.get("/flaky", async (_req, res) => {
  const { rows } = await pool.query("select count(*)::int as n from orders where status = $1", ["pending"]);
  if (Math.random() < 1 / 3) throw new Error("inventory service timed out");
  res.json({ pending: rows[0].n });
});

/** SEEDED PROBLEM (sync throw): throws before doing anything; the error middleware answers 500. */
failures.get("/boom", () => {
  throw new Error("boom: unhandled synchronous error");
});
