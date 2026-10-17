/** No route matched: a plain JSON 404. */
export function notFound(req, res) {
  // With Hoplens running, /__hoplens never reaches the app: getting here means it isn't.
  if (req.path.startsWith("/__hoplens")) {
    res.status(404).json({ error: "Hoplens is not running", hint: "start the app with `pnpm dev`, not `pnpm start`" });
    return;
  }
  res.status(404).json({ error: "not found", path: req.path });
}

/**
 * The app's error middleware (4 args, so Express treats it as one). Sync throws and, on Express 5,
 * rejected promises from async handlers both land here. Zod errors become 400s, the rest 500s.
 */
export function errorHandler(err, req, res, _next) {
  if (err?.name === "ZodError") {
    res.status(400).json({ error: "invalid body", issues: err.issues });
    return;
  }
  const status = Number(err?.status ?? err?.statusCode ?? 500);
  if (status >= 500) console.error(`[${req.id}] ${req.method} ${req.originalUrl}:`, err?.message ?? err);
  res.status(status).json({ error: err?.expose ? err.message : "internal error", requestId: req.id });
}
