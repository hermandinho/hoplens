import type { HealthMonitor, HealthTick } from "../health";
import { type ApiEndpoint, type ApiHandle, sendJson } from "./module";

/*
 * GET /api/health          -> HealthSnapshot (ring of samples, GC totals, recorded process errors)
 * GET /api/health/stream   -> SSE, `event: health` with a HealthTick on every sampler tick (2s) and
 *                             soon after a process error, at most once per second per client.
 *
 * `attachHealthEvents` is the same feed for any SSE writer, so /api/events can carry `event: health`
 * with one call if the UI prefers a single EventSource.
 */

/** Minimum gap between two `health` events to one client. */
export const HEALTH_EVENT_MIN_GAP_MS = 1000;

/**
 * Subscribe an SSE writer to health ticks. Returns the unsubscribe; it clears the only timer this
 * creates (a pending throttled send), so no timer outlives the client.
 */
export function attachHealthEvents(
  health: HealthMonitor,
  write: (chunk: string) => void,
  minGapMs = HEALTH_EVENT_MIN_GAP_MS,
  opts: { immediate?: boolean } = {},
): () => void {
  let lastSent = 0;
  let lastErrorId = health.lastErrorId;
  let pending: NodeJS.Timeout | undefined;
  let closed = false;

  const flush = () => {
    pending = undefined;
    if (closed) return;
    lastSent = Date.now();
    const snap = health.snapshot();
    const newErrors = health.errorsSince(lastErrorId);
    lastErrorId = health.lastErrorId;
    const tick: HealthTick = { current: snap.current, errorCounts: snap.errorCounts, newErrors };
    write(`event: health\ndata: ${JSON.stringify(tick)}\n\n`);
  };
  const schedule = () => {
    if (closed || pending) return;
    const wait = lastSent + minGapMs - Date.now();
    if (wait <= 0) flush();
    else pending = setTimeout(flush, wait);
  };

  health.on("sample", schedule);
  health.on("processError", schedule);
  // Through flush, so the first event also starts the min-gap clock.
  if (opts.immediate) flush();
  return () => {
    closed = true;
    if (pending) clearTimeout(pending);
    pending = undefined;
    health.off("sample", schedule);
    health.off("processError", schedule);
  };
}

export const handle: ApiHandle = (_req, res, rt) => sendJson(res, 200, rt.health.snapshot());

export const stream: ApiHandle = (req, res, rt) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (chunk: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(chunk);
  };
  // First event right away so the status slot doesn't wait a sampler period.
  const detach = attachHealthEvents(rt.health, write, HEALTH_EVENT_MIN_GAP_MS, { immediate: true });
  const beat = setInterval(() => write(": ping\n\n"), 15000);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(beat);
    detach();
  };
  req.on("close", stop);
  res.on("close", stop);
  res.on("error", stop);
};

export const endpoints: ApiEndpoint[] = [
  { method: "GET", path: "/api/health", handle },
  { method: "GET", path: "/api/health/stream", handle: stream },
];
