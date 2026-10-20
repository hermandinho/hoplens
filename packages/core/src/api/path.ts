// POST /api/traces/:id/path -> 200 { traceId, path: PathPayload }: replays a GET/HEAD trace once,
//                              alone, and captures its block coverage (path/capture.ts). The replay
//                              is a NEW trace (`traceId`, stamped `pathTrace`; announced with an
//                              `update` event so lists show the stamp).
// GET  /api/traces/:id/path -> the stored PathPayload of a path trace (the last 20).
//
// Both answer the payload with its per-function analysis (decisions, loops, exits, flowchart graph)
// and the request's verdict line: built once, lazily, on the POST that captured it or else on the
// first GET, and cached on the stored payload (path/analyze.ts).
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
//
// POST /api/path/enable  -> 200 { path: PathMeta }: the adapter's sticky switch (RuntimeConfig.path.control)
// POST /api/path/disable    writes / removes its flag; it applies at the next start, so the answer
//                           carries `pending` until then. Loopback only, even with allowRemote, and a
//                           browser POST from a non-local Origin is refused.
//   409 env             HOPLENS_PATH decided this boot: the env var always wins
//   409 unsupported     the adapter has no switch (a custom adapter that passes no PathControl)
//   403 forbidden       not from this machine, or from a non-local origin
//   500 write-failed    the flag file could not be written / removed

import { analyzePayload } from "../path/analyze";
import { type CaptureDeps, PathError, type PathPayload, capturePath, pathMeta, pathResults } from "../path/capture";
import { coverageHandle } from "../path/coverage";
import { batchesRunning, prepareRun, resendHeaders, runOnce } from "../replay";
import type { Runtime } from "../runtime";
import type { TraceRecord } from "../types";
import { trustedCaller } from "./guard";
import { type ApiEndpoint, type ApiHandle, sendJson } from "./module";

/** How long the replay may take, response and trace together. */
const PATH_TRACE_WAIT_MS = 30_000;

export function captureDeps(rt: Runtime, source: TraceRecord, waitMs = PATH_TRACE_WAIT_MS): CaptureDeps {
  return {
    coverage: coverageHandle(),
    store: rt.store,
    root: rt.root,
    scripts: rt.pathScripts,
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

/** Build the payload's analysis (once; a no-op when it is cached on the payload). */
export function analyzed(rt: Runtime, p: PathPayload): PathPayload {
  analyzePayload(p, { analyzer: rt.pathAnalyzer, root: rt.root });
  return p;
}

const capture: ApiHandle = async (_req, res, rt, ctx) => {
  const source = rt.store.get(ctx.params.id ?? "");
  if (!source) return sendJson(res, 404, { code: "not-found", error: "Trace not found. It may have rotated out." });
  try {
    const payload = await capturePath(captureDeps(rt, source), source);
    pathResults(rt.store).set(payload.traceId, payload);
    sendJson(res, 200, { traceId: payload.traceId, path: analyzed(rt, payload) });
  } catch (err) {
    if (err instanceof PathError) return sendJson(res, err.status, err.body);
    throw err;
  }
};

const read: ApiHandle = (_req, res, rt, ctx) => {
  const id = ctx.params.id ?? "";
  const p = pathResults(rt.store).get(id);
  if (p) return sendJson(res, 200, analyzed(rt, p));
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

/** POST /api/path/enable|disable: the adapter's sticky switch, applied at the next start. */
export function toggle(on: boolean): ApiHandle {
  return (req, res, rt) => {
    // handleUi's guard already ran, but relaxed under allowRemote: the switch writes a file, so it
    // takes the strict check (loopback address, local Host, local Origin) whatever allowRemote says.
    if (!trustedCaller(req))
      return sendJson(res, 403, {
        code: "forbidden",
        error: "The request path switch only answers the Hoplens UI on this machine.",
      });
    const control = rt.pathControl;
    if (!control)
      return sendJson(res, 409, {
        code: "unsupported",
        error:
          "This adapter has no request path switch: set HOPLENS_PATH=1 in the dev server's environment and restart it.",
      });
    if (control.source === "env")
      return sendJson(res, 409, {
        code: "env",
        error: `HOPLENS_PATH=${process.env.HOPLENS_PATH ?? ""} is set in the environment, and it always wins over the switch. Change or unset it, then restart the app.`,
      });
    try {
      if (on) control.enable();
      else control.disable();
    } catch (err) {
      return sendJson(res, 500, {
        code: "write-failed",
        error: `Could not ${on ? "write" : "remove"} the request path flag: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    sendJson(res, 200, { path: pathMeta(undefined, process.env, control) });
  };
}

export const endpoints: ApiEndpoint[] = [
  { method: "POST", path: "/api/traces/:id/path", handle: capture },
  { method: "GET", path: "/api/traces/:id/path", handle: read },
  { method: "POST", path: "/api/path/enable", handle: toggle(true) },
  { method: "POST", path: "/api/path/disable", handle: toggle(false) },
];
