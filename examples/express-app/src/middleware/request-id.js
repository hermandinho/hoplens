import { randomUUID } from "node:crypto";

/** Tags every response with an x-request-id (reuses the caller's when it sends one). */
export function requestId(req, res, next) {
  const id = req.get("x-request-id") ?? randomUUID();
  req.id = id;
  res.set("x-request-id", id);
  next();
}
