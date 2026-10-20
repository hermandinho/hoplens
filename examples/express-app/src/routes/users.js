import { Router } from "express";
import { findOrder, listUserOrders, orderLines } from "../services/orders.js";

// Mounted at /api/users/:uid; mergeParams makes :uid visible here.
export const userOrders = Router({ mergeParams: true });

/** The user's orders (ids only). Fine: one query. */
userOrders.get("/orders", async (req, res) => {
  res.json(await listUserOrders(Number(req.params.uid)));
});

/**
 * SEEDED PROBLEM (N+1): loads the order, then its lines through orderLines(), which runs one
 * productSummary() query per line item (see src/services/orders.js).
 */
userOrders.get("/orders/:id", async (req, res) => {
  const uid = Number(req.params.uid);
  const id = Number(req.params.id);
  const order = await findOrder(uid, id);
  if (!order) {
    res.status(404).json({ error: "order not found", uid, id });
    return;
  }
  res.json({ ...order, items: await orderLines(id) });
});
