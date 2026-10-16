// GET /api/compare?a=<baseline id>&b=<subject id>  -> CompareResult (compare.ts), pins both traces.
// GET /api/compare/baselines?b=<subject id>        -> { baselines: Baseline[] }, default first.
// DELETE /api/compare/pins/:id                       -> releases one pin (the trace then rotates normally).

import { compareTraces, findBaselines } from "../compare";
import { type ApiEndpoint, type ApiHandle, sendJson } from "./module";

export const handle: ApiHandle = (_req, res, rt, ctx) => {
  const a = ctx.url.searchParams.get("a");
  const b = ctx.url.searchParams.get("b");
  if (!a || !b) return sendJson(res, 400, { error: "Pass both trace ids: /api/compare?a=<baseline>&b=<subject>" });
  const ta = rt.store.get(a);
  const tb = rt.store.get(b);
  if (!ta || !tb) {
    const missing = [!ta && "a", !tb && "b"].filter(Boolean);
    return sendJson(res, 404, { error: "Trace not found. It may have rotated out.", missing });
  }
  // Pin both so ring rotation can't break the open view or a deep link to it.
  rt.store.pin(a);
  rt.store.pin(b);
  sendJson(res, 200, compareTraces(ta, tb, { redactor: rt.redactor }));
};

const baselines: ApiHandle = (_req, res, rt, ctx) => {
  const b = ctx.url.searchParams.get("b");
  if (!b) return sendJson(res, 400, { error: "Pass the subject trace id: /api/compare/baselines?b=<id>" });
  const tb = rt.store.get(b);
  if (!tb) return sendJson(res, 404, { error: "Trace not found. It may have rotated out." });
  sendJson(res, 200, { baselines: findBaselines(rt.store.records(), tb) });
};

const unpin: ApiHandle = (_req, res, rt, ctx) => {
  sendJson(res, 200, { unpinned: rt.store.unpin(ctx.params.id ?? "") });
};

export const endpoints: ApiEndpoint[] = [
  { method: "GET", path: "/api/compare", handle },
  { method: "GET", path: "/api/compare/baselines", handle: baselines },
  { method: "DELETE", path: "/api/compare/pins/:id", handle: unpin },
];
