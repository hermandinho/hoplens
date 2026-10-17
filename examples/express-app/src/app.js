import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { slowAuth } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requestId } from "./middleware/request-id.js";
import { dashboard } from "./routes/dashboard.js";
import { failures } from "./routes/failures.js";
import { files } from "./routes/files.js";
import { orders } from "./routes/orders.js";
import { products } from "./routes/products.js";
import { report } from "./routes/report.js";
import { userOrders } from "./routes/users.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export const app = express();

app.use(requestId);

// Static assets: public/index.html, style.css, logo.svg.
app.use(express.static(path.resolve(publicDir)));

// Baseline: a healthy, fast route. Registered before the slow auth middleware, so it skips it.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// SEEDED PROBLEM (slow middleware): every other /api request waits ~30 ms in auth before its handler.
app.use("/api", slowAuth);

// SEEDED PROBLEM (N+1): mounted with a param prefix; the router uses mergeParams to read :uid.
app.use("/api/users/:uid", userOrders);
app.use("/api/dashboard", dashboard);
app.use("/api/products", products);
app.use("/api/report", report);
app.use("/api/orders", orders);
app.use("/api", failures);
app.use("/files", files);

app.use(notFound);
// 4-arg error middleware: sync throws and rejected promises (Express 5) end up here.
app.use(errorHandler);
