import { Router } from "express";
import { dashboardStats } from "../services/dashboard.js";

export const dashboard = Router();

/** SEEDED PROBLEM (sequential independent queries): see dashboardStats() in src/services/dashboard.js. */
dashboard.get("/", async (_req, res) => {
  res.json(await dashboardStats());
});
