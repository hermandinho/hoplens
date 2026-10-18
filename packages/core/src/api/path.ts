// POST /api/traces/:id/path -> 200 { traceId, path: PathPayload }: replays a GET/HEAD trace once,
//                              alone, and captures its block coverage (path/capture.ts). The replay
//                              is a NEW trace (`traceId`, stamped `pathTrace`; announced with an
//                              `update` event so lists show the stamp).
// GET  /api/traces/:id/path -> the stored PathPayload of a path trace (the last 20).
//
// Every error body is `{ code, error, ...details }`: `code` is stable (PathErrorCode), `error` is a
// sentence for the user.
//   400 method          any method but GET / HEAD (replaying it would run its side effects again)
//   404 not-found       the trace is gone
//   404 no-path         the trace is not a path trace (Trace path makes one)
//   404 superseded      a replay discarded for the automatic retry: `{ traceId }` has the path
//   410 evicted         a path trace whose payload rotated out (only the last 20 are kept): `{ replayOf }`
//   409 path-off        `{ state, reason }`: no HOPLENS_PATH=1 at boot, NODE_V8_COVERAGE, or coverage
//                       stopped working (state 'error')
//   409 busy            another capture is running
//   409 not-quiet       `{ reason, inflight, requests? }`: the app never went idle; nothing was sent
//   500 take-failed     reading the counts failed
//   502 replay-failed   `{ status }`: the replay failed or hit its time limit (30s)

import { type CaptureDeps, PathError, capturePath, pathResults } from "../path/capture";
import { coverageHandle } from "../path/coverage";
import { batchesRunning, prepareRun, resendHeaders, runOnce } from "../replay";
import type { Runtime } from "../runtime";
import type { TraceRecord } from "../types";
import { type ApiEndpoint, type ApiHandle, sendJson } from "./module";

/** How long the replay may take, response and trace together. */
const PATH_TRACE_WAIT_MS = 30_000;

export function captureDeps(rt: Runtime, source: TraceRecord, waitMs = PATH_TRACE_WAIT_MS): CaptureDeps {
  return {
    coverage: coverageHandle(),
    store: rt.store,
    root: rt.root,
    busy: () => (batchesRunning() > 0 ? "a Replay xN batch is running" : undefined),
    // The signal bounds the fetch too: without it a GET that never answers holds the capture lock
    // until undici's own 300s header timeout.
    fire: () =>
      runOnce(rt, prepareRun(rt, { method: source.method, path: source.url, headers: resendHeaders(rt, source) }), {
        traceWaitMs: waitMs,
        signal: AbortSignal.timeout(waitMs),
      }),
  };
}

const capture: ApiHandle = async (_req, res, rt, ctx) => {
  const source = rt.store.get(ctx.params.id ?? "");
  if (!source) return sendJson(res, 404, { code: "not-found", error: "Trace not found. It may have rotated out." });
  try {
    const payload = await capturePath(captureDeps(rt, source), source);
    pathResults(rt.store).set(payload.traceId, payload);
    sendJson(res, 200, { traceId: payload.traceId, path: payload });
  } catch (err) {
    if (err instanceof PathError) return sendJson(res, err.status, err.body);
    throw err;
  }
};

const read: ApiHandle = (_req, res, rt, ctx) => {
  const id = ctx.params.id ?? "";
  const p = pathResults(rt.store).get(id);
  if (p) return sendJson(res, 200, p);
  const stamp = rt.store.get(id)?.pathTrace;
  if (stamp?.supersededBy)
    return sendJson(res, 404, {
      code: "superseded",
      error: `This replay was discarded for the automatic retry; its path is on ${stamp.supersededBy}`,
      traceId: stamp.supersededBy,
    });
  if (stamp && !stamp.failed)
    return sendJson(res, 410, {
      code: "evicted",
      error: `This path was dropped (only the last 20 are kept); Trace path the source trace ${stamp.replayOf} again`,
      replayOf: stamp.replayOf,
    });
  sendJson(res, 404, { code: "no-path", error: "No request path for this trace. Trace path makes one." });
};

export const endpoints: ApiEndpoint[] = [
  { method: "POST", path: "/api/traces/:id/path", handle: capture },
  { method: "GET", path: "/api/traces/:id/path", handle: read },
];
