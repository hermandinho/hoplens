// Request path, layer 2: the capture window (plan P1, mockup A).
//
// Coverage counts are process-global, so a capture has to make sure the counts it reads belong to
// one replayed request and nothing else:
//
//   lock busy? -> 409 busy | quiet (inflight == 0 for 150ms, max 3s)? no -> 409 not-quiet (nothing fired)
//   take() reset -> watch store 'start' and 'update' (any trace but ours => taint: a late span on
//   another trace means its code still runs)
//   fire one replay (runOnce, unchanged) -> its trace done -> settle 250ms (extended on our trace's
//   'update', max 2s) -> take()
//   keep project file:// scripts -> join hops to coverage functions -> cross-check hop counts H vs
//   coverage call counts K (K > H => contaminated) and each block against K (a block counted more
//   often than its function was entered, outside any loop, is an earlier call resuming after an
//   await => contaminated); one automatic retry
//   the same K > H on both clean tries -> a control window of the same length with no replay: the
//   joined functions ran there too => background work, CONTAMINATED; clean => calls the hops cannot
//   see (a local binding), PARTIAL with the call count unchecked
//   quality EXACT | PARTIAL | CONTAMINATED
//
// Refusals are PathError with a JSON body `{ code, error, ...details }`: `code` is stable
// (PathErrorCode), `error` is a sentence for the user.
//
// A CONTAMINATED capture is kept (owner decision): its trace stays, and every truth is UNKNOWN with
// the reasons and a warning. The CFG / per-decision truth model is P2: P1 returns function-level
// truth plus the raw V8 block ranges of each joined function, in a payload whose `v` field lets P2
// extend it.
//
// Nothing here loads node:inspector: the coverage handle comes from the boot hook (coverage.ts) via
// a process global. With HOPLENS_PATH unset there is no handle and every capture answers "path off".

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FN_SPANS_PER_TRACE, droppedFunctionSpans } from "../capture";
import type { SpanRecord, TraceRecord } from "../types";
import type { PayloadAnalysis } from "./analyze";
import { type CoverageSource, type FunctionCoverage, type ScriptCoverage, coverageHandle, pathFlag } from "./coverage";
import type { FnAnalysis, TruthWhy } from "./truth";

/* ------------------------------------------------------------------- model */

/** 2: per-function `analysis` (decisions, loops, exits, graph) and the payload's `analysis` verdict (P2). */
export const PATH_PAYLOAD_VERSION = 2;

export type PathQuality = "exact" | "partial" | "contaminated";

/** Why a truth is UNKNOWN (truth.ts adds the per-decision reasons: after-throw, source-moved, ...). */
export type UnknownWhy = TruthWhy;

export type Truth = { t: "taken"; n: number } | { t: "not" } | { t: "unknown"; why: UnknownWhy };

/** One raw V8 block range: offsets into the source V8 ran (identity-mapped to the file on disk in P1). */
export interface PathRange {
  start: number;
  end: number;
  count: number;
  /** 1-based lines of `start` and `end` in the file on disk. */
  line: number;
  endLine: number;
}

export interface PathFn {
  /** `file:line:name` of the hop. */
  key: string;
  name: string;
  file: string;
  /** The hop's line. */
  line: number;
  /** V8's name for the joined function ("" for an anonymous one). */
  v8Name?: string;
  /** Lines the joined function spans. */
  startLine?: number;
  endLine?: number;
  mapping: "identity" | "none";
  /** sha1 (12 hex) of the file read at capture time; P2 checks it before trusting offsets. */
  sourceHash?: string;
  calls: { hops: number; coverage: number | null; checked: boolean };
  truth: Truth;
  /** V8 reported block (not just function) counts for this function. */
  blocks: boolean;
  ranges: PathRange[];
  truncated?: boolean;
  /**
   * Hops of this function that threw or rejected, and for every distinct error recorded under one of
   * its hops (its own, its callees') the line of its innermost frame in this function: where the
   * exception passed through it. The truth model's throw cut.
   */
  errors?: { hops: number; lines: number[] };
  /** The file was modified after the app started: V8 may have compiled an older text. */
  stale?: boolean;
  /** Decisions, loops, exits and the flowchart graph (built lazily: analyze.ts). */
  analysis?: FnAnalysis;
}

export interface Lane {
  spanId: string;
  kind: "handler" | "function";
  name: string;
  file?: string;
  line?: number;
  fnKey?: string;
  /** Lanes above this one in the span tree. */
  depth: number;
  /** Hops this lane's function had in the trace (H). */
  calls: number;
  truth: Truth;
  threw?: boolean;
}

export interface PathWindow {
  /** ms the quiet gate waited before firing. */
  quietMs: number;
  /** ms from our trace's `done` to the final take. */
  settleMs: number;
  /**
   * Other requests inside the window: `METHOD path` for one that started, `late work from METHOD
   * path` for a finished one that still recorded spans.
   */
  taint: string[];
  retries: number;
  /** Attempts discarded for a retry (their traces stay, stamped `pathTrace.supersededBy`). */
  attempts: Array<{ traceId: string; quality: PathQuality; contamination: string[] }>;
  /** The no-replay control window, when the same K > H showed on both tries. */
  control?: { ms: number; clean: boolean; reason?: string };
  /** Duration of the reset take and of the final take, ms. */
  takeMs: [number, number];
  /** Project scripts kept / scripts V8 reported. */
  scripts: number;
  totalScripts: number;
}

export interface PathPayload {
  v: typeof PATH_PAYLOAD_VERSION;
  traceId: string;
  replayOf: string;
  quality: PathQuality;
  /** Why the capture is CONTAMINATED (empty otherwise). */
  contamination: string[];
  warnings: string[];
  window: PathWindow;
  lanes: Lane[];
  functions: Record<string, PathFn>;
  /** The request's verdict line and the analysis cost (built lazily on POST / first GET). */
  analysis?: PayloadAnalysis;
}

/* ----------------------------------------------------------------- tunables */

export interface PathTimings {
  quietMs: number;
  quietMaxMs: number;
  pollMs: number;
  settleMs: number;
  settleMaxMs: number;
  /** Longest control window (it otherwise matches the attempt's window). */
  controlMaxMs: number;
}

export const DEFAULT_TIMINGS: PathTimings = {
  quietMs: 150,
  quietMaxMs: 3000,
  pollMs: 25,
  settleMs: 250,
  settleMaxMs: 2000,
  controlMaxMs: 3000,
};

/** Payload caps (plan dataModel): beyond them, functions become unknown 'too-large'. */
export const MAX_FUNCTIONS = 30;
export const MAX_RANGES = 2000;
/** Lanes kept in a payload (one per hop: a hot helper would otherwise add one per call). */
export const MAX_LANES = 300;
/** Lines after a handler's registration line where its function may start (a wrapped call). */
const HANDLER_LOOKAHEAD = 3;
/** Payloads kept for GET /api/traces/:id/path. */
export const PATH_LRU = 20;

/* ------------------------------------------------------------------ errors */

/**
 * Stable machine codes of the path API's error bodies (`{ code, error, ...details }`):
 * method 400 · not-found 404 · no-path 404 · superseded 404 · evicted 410 · path-off 409 · busy 409
 * · not-quiet 409 · take-failed 500 · replay-failed 502.
 */
export type PathErrorCode =
  | "method"
  | "not-found"
  | "no-path"
  | "superseded"
  | "evicted"
  | "path-off"
  | "busy"
  | "not-quiet"
  | "take-failed"
  | "replay-failed";

export interface PathErrorBody {
  code: PathErrorCode;
  /** A sentence for the user. */
  error: string;
  [k: string]: unknown;
}

/** A capture that could not run (or was refused before firing). `body` is the JSON answer. */
export class PathError extends Error {
  /** The replay's trace, when the failure came after it ran (it is stamped `pathTrace.failed`). */
  trace?: TraceRecord;
  constructor(
    readonly status: number,
    readonly body: PathErrorBody,
  ) {
    super(body.error);
  }
}

/* ------------------------------------------------------------ state + meta */

export interface PathMeta {
  state: "off" | "on" | "disabled-c8" | "error";
  reason?: string;
}

/** The request path's state for /api/meta, the banner and the routes. */
export function pathMeta(cov: CoverageSource | undefined = coverageHandle(), env = process.env): PathMeta {
  if (cov) return cov.reason ? { state: cov.state, reason: cov.reason } : { state: cov.state };
  return pathFlag(env)
    ? { state: "off", reason: "HOPLENS_PATH is set but coverage did not start at boot (load the register hook)" }
    : { state: "off", reason: "restart with HOPLENS_PATH=1" };
}

/* ------------------------------------------------------------------- deps */

/** The store events and counters the window needs (TraceStore satisfies it). */
export interface PathStore {
  on(event: "start" | "update", listener: (t: TraceRecord) => void): unknown;
  off(event: "start" | "update", listener: (t: TraceRecord) => void): unknown;
  inflight(): number;
  inflightTraces?(): TraceRecord[];
  /** Announce a finished trace that changed (its `pathTrace` stamp): TraceStore.update. */
  update?(t: TraceRecord): void;
}

export interface FireResult {
  trace?: TraceRecord;
  status: number;
  error?: string;
}

export interface CaptureDeps {
  coverage: CoverageSource | undefined;
  store: PathStore;
  /** Fire the replay once and resolve when its trace is done (runOnce). */
  fire: () => Promise<FireResult>;
  root: string;
  /** A reason to refuse right now (a Replay xN batch is running), else undefined. */
  busy?: () => string | undefined;
  /** Read a source file (default fs.readFileSync); undefined when unreadable. */
  readSource?: (abs: string) => string | undefined;
  timings?: Partial<PathTimings>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/* ------------------------------------------------------------- the window */

const locks = new WeakSet<object>();

/**
 * Capture the request path of `source` by replaying it once, alone. Resolves with the payload of
 * the NEW trace (also stamped `pathTrace`); throws PathError for a refusal (400 method, 409 busy /
 * not-quiet / path-off, 500 take-failed, 502 replay-failed).
 */
export async function capturePath(deps: CaptureDeps, source: TraceRecord): Promise<PathPayload> {
  const method = (source.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD")
    throw new PathError(400, {
      code: "method",
      error: `Only GET and HEAD requests can be traced for their path: replaying a ${method} would run its side effects again`,
    });
  const cov = deps.coverage;
  if (!cov || cov.state !== "on") throw pathOff(cov);
  if (locks.has(deps.store))
    throw new PathError(409, {
      code: "busy",
      error: "Another path capture is running; try again when it finishes",
    });
  locks.add(deps.store);
  try {
    const t: PathTimings = { ...DEFAULT_TIMINGS, ...deps.timings };
    let first: Attempt;
    try {
      first = await attempt(deps, cov, t, source, true);
    } catch (err) {
      if (err instanceof PathError && err.trace) stamp(deps, err.trace, { failed: err.body.code }, source);
      throw err;
    }
    let chosen = first;
    const discarded: Attempt[] = [];
    let control: PathWindow["control"];
    if (first.contaminated) {
      let second: Attempt | undefined;
      try {
        second = await attempt(deps, cov, t, source, false);
      } catch (err) {
        // The app got busy (or the replay failed) on the retry: keep the first capture, contaminated.
        if (err instanceof PathError && err.trace) stamp(deps, err.trace, { failed: err.body.code }, source);
      }
      if (second) {
        discarded.push(first);
        chosen = second;
        // Same excess on both runs with nothing foreign in either window: calls the hops cannot see
        // (a function also called through its module-local binding), or a background job (a timer)
        // that ran about as often in both windows. A control window with no replay tells them apart.
        if (
          second.contaminated &&
          !first.taint.length &&
          !second.taint.length &&
          !first.implausible &&
          !second.implausible &&
          sameExcess(first, second)
        ) {
          control = await controlWindow(deps, cov, t, second);
          if (control.clean) {
            for (const key of Object.keys(second.excess)) {
              const fn = second.payload.functions[key];
              if (fn) fn.calls.checked = false;
              second.payload.warnings.push(
                `${key} ran ${second.excess[key]} more time(s) than it has hops on both runs, and not at all with no replay: calls through a local binding are not hops, so its call count is not cross-checked`,
              );
            }
            second.contaminated = false;
            second.payload.contamination = [];
            second.payload.quality = "partial";
          } else {
            second.payload.contamination.push(
              `background work: ${control.reason ?? "the traced functions also ran with no request"} (a timer or job; its calls are counted in)`,
            );
          }
        }
      }
    }
    const payload = chosen.payload;
    payload.window.retries = discarded.length;
    payload.window.attempts = discarded.map((a) => ({
      traceId: a.trace.id,
      quality: "contaminated" as const,
      contamination: a.payload.contamination,
    }));
    if (control) payload.window.control = control;
    if (chosen.contaminated) markContaminated(payload);
    for (const a of discarded) stamp(deps, a.trace, { supersededBy: chosen.trace.id }, source);
    stamp(deps, chosen.trace, { quality: payload.quality }, source);
    return payload;
  } finally {
    locks.delete(deps.store);
  }
}

/** Mark a replay as a path trace and announce the change (list rows and the live stream show it). */
function stamp(
  deps: CaptureDeps,
  trace: TraceRecord,
  how: { quality: PathQuality } | { supersededBy: string } | { failed: string },
  source: TraceRecord,
): void {
  trace.pathTrace =
    "quality" in how
      ? { quality: how.quality, replayOf: source.id }
      : { quality: "contaminated", replayOf: source.id, ...how };
  try {
    deps.store.update?.(trace);
  } catch {
    /* the stamp is on the record either way */
  }
}

function pathOff(cov: CoverageSource | undefined): PathError {
  const m = pathMeta(cov);
  return new PathError(409, {
    code: "path-off",
    error:
      m.state === "error"
        ? `The request path stopped working: ${m.reason ?? "coverage failed"}`
        : `The request path is off: ${m.reason ?? m.state}`,
    state: m.state,
    reason: m.reason,
  });
}

/** A failed take: coverage went away under us (downgraded) or the inspector errored. */
function takeFailed(cov: CoverageSource, trace?: TraceRecord): PathError {
  const err =
    cov.state !== "on"
      ? pathOff(cov)
      : new PathError(500, {
          code: "take-failed",
          error: "Reading the coverage counts failed; try Trace path again",
        });
  err.trace = trace;
  return err;
}

interface Attempt {
  trace: TraceRecord;
  payload: PathPayload;
  contaminated: boolean;
  taint: string[];
  /** fnKey -> K - H where K > H. */
  excess: Record<string, number>;
  /** A block counted more often than its function was entered, outside a loop. */
  implausible: boolean;
  /** Joined coverage functions (script url + start offset), for the control window. */
  joined: JoinedRef[];
  /** ms from the reset take to the final take. */
  windowMs: number;
}

function sameExcess(a: Attempt, b: Attempt): boolean {
  const ka = Object.keys(a.excess).sort();
  const kb = Object.keys(b.excess).sort();
  return ka.length > 0 && ka.join("\n") === kb.join("\n") && ka.every((k) => a.excess[k] === b.excess[k]);
}

/**
 * Watch the store for other requests while a window is open. Collected raw and labelled at the end
 * (`taint()`), once our own trace is known: its 'start' fires before fire() resolves.
 */
function watchOthers(store: PathStore, isOurs: (t: TraceRecord) => boolean, onOurUpdate?: () => void) {
  const starts: TraceRecord[] = [];
  const updates: TraceRecord[] = [];
  const onStart = (s: TraceRecord) => starts.push(s);
  const onUpdate = (u: TraceRecord) => {
    if (isOurs(u)) onOurUpdate?.();
    else updates.push(u);
  };
  store.on("start", onStart);
  store.on("update", onUpdate);
  return {
    stop() {
      store.off("start", onStart);
      store.off("update", onUpdate);
    },
    taint(): string[] {
      const out = [
        ...starts.filter((x) => !isOurs(x)).map((x) => `${x.method} ${x.path}`),
        ...updates.filter((x) => !isOurs(x)).map((x) => `late work from ${x.method} ${x.path}`),
      ];
      return out.filter((v, i) => out.indexOf(v) === i);
    },
  };
}

async function attempt(
  deps: CaptureDeps,
  cov: CoverageSource,
  t: PathTimings,
  source: TraceRecord,
  firstTry: boolean,
): Promise<Attempt> {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // 1. Quiet gate: fail before firing.
  const gateStart = now();
  let quietSince: number | undefined;
  for (;;) {
    const busy = deps.busy?.();
    if (busy)
      throw new PathError(409, {
        code: "not-quiet",
        error: `The app is busy (${busy}); try again when it is idle`,
        reason: busy,
        inflight: deps.store.inflight(),
        firstTry,
      });
    const n = deps.store.inflight();
    const at = now();
    if (n > 0) quietSince = undefined;
    else quietSince ??= at;
    if (quietSince !== undefined && at - quietSince >= t.quietMs) break;
    if (at - gateStart >= t.quietMaxMs) {
      const running = deps.store.inflightTraces?.() ?? [];
      const reason = `${n} request${n === 1 ? "" : "s"} in flight`;
      throw new PathError(409, {
        code: "not-quiet",
        error: `The app never went idle (${reason}); nothing was sent. Try again when it is idle`,
        reason,
        inflight: n,
        requests: running.slice(0, 5).map((r) => `${r.method} ${r.path}`),
        firstTry,
      });
    }
    await sleep(t.pollMs);
  }
  const quietMs = now() - gateStart;

  // 2. Reset, then watch for anything else that runs inside the window.
  const reset = cov.take(() => false);
  if (!reset) throw takeFailed(cov);
  const resetAt = now();
  let ours: TraceRecord | undefined;
  let settleUntil = Number.POSITIVE_INFINITY;
  let settleCap = Number.POSITIVE_INFINITY;
  const others = watchOthers(
    deps.store,
    (x) => !!ours && (x === ours || x.id === ours.id),
    () => {
      settleUntil = Math.min(settleCap, now() + t.settleMs);
    },
  );
  let final: ReturnType<CoverageSource["take"]>;
  let settleMs = 0;
  let windowMs = 0;
  try {
    // 3. One replay, waited until its trace is done.
    const fired = await deps.fire();
    if (!fired.trace) {
      throw new PathError(502, {
        code: "replay-failed",
        error: fired.error ?? "The replay finished without a trace",
        status: fired.status,
      });
    }
    ours = fired.trace;
    // 4. Settle: late spans and timers the request scheduled.
    const doneAt = now();
    settleCap = doneAt + t.settleMaxMs;
    settleUntil = Math.min(settleCap, doneAt + t.settleMs);
    for (let at = now(); at < settleUntil; at = now()) await sleep(Math.min(t.pollMs, settleUntil - at));
    settleMs = now() - doneAt;
    final = cov.take((url) => isProjectScript(url, deps.root));
    windowMs = now() - resetAt;
  } finally {
    others.stop();
  }
  const trace = ours!;
  if (!final) throw takeFailed(cov, trace);
  const taint = others.taint();

  const built = buildPayload(trace, final.scripts, deps.root, deps.readSource ?? readFile, {
    droppedHops: droppedHops(trace),
    mtime: deps.readSource ? undefined : mtimeOf,
    processStart: PROCESS_START,
  });
  const contamination: string[] = [];
  if (taint.length) contamination.push(`other requests ran during the capture: ${taint.slice(0, 5).join(", ")}`);
  for (const [key, extra] of Object.entries(built.excess))
    contamination.push(`${key} ran ${extra} more time(s) than its hops (K > H)`);
  for (const why of Object.values(built.implausible)) contamination.push(why);
  const payload: PathPayload = {
    v: PATH_PAYLOAD_VERSION,
    traceId: trace.id,
    replayOf: source.id,
    quality: contamination.length ? "contaminated" : built.partial ? "partial" : "exact",
    contamination,
    warnings: built.warnings,
    window: {
      quietMs: r1(quietMs),
      settleMs: r1(settleMs),
      taint,
      retries: 0,
      attempts: [],
      takeMs: [r1(reset.ms), r1(final.ms)],
      scripts: final.scripts.length,
      totalScripts: final.total,
    },
    lanes: built.lanes,
    functions: built.functions,
  };
  return {
    trace,
    payload,
    contaminated: contamination.length > 0,
    taint,
    excess: built.excess,
    implausible: Object.keys(built.implausible).length > 0,
    joined: built.joined,
    windowMs,
  };
}

/**
 * The control window: reset, wait as long as the attempt's window (capped) without firing anything,
 * take. Any count on the attempt's joined functions, or any other request, means work the replay
 * did not do ran in the windows: background work, not a local binding.
 */
async function controlWindow(
  deps: CaptureDeps,
  cov: CoverageSource,
  t: PathTimings,
  a: Attempt,
): Promise<NonNullable<PathWindow["control"]>> {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wait = Math.min(Math.max(a.windowMs, t.pollMs), t.controlMaxMs);
  if (!cov.take(() => false)) return { ms: 0, clean: false, reason: "the control take failed" };
  const t0 = now();
  const others = watchOthers(deps.store, () => false);
  let taken: ReturnType<CoverageSource["take"]>;
  try {
    for (let at = now(); at - t0 < wait; at = now()) await sleep(Math.min(t.pollMs, wait - (at - t0)));
    taken = cov.take((url) => isProjectScript(url, deps.root));
  } finally {
    others.stop();
  }
  const ms = r1(now() - t0);
  if (!taken) return { ms, clean: false, reason: "the control take failed" };
  const taint = others.taint();
  if (taint.length) return { ms, clean: false, reason: `other requests ran: ${taint.slice(0, 5).join(", ")}` };
  const want = new Map<string, Set<number>>();
  for (const j of a.joined) {
    const set = want.get(j.url) ?? new Set<number>();
    set.add(j.start);
    want.set(j.url, set);
  }
  let calls = 0;
  for (const s of taken.scripts) {
    const starts = want.get(s.url);
    if (!starts) continue;
    for (const f of s.functions) {
      const r0 = f.ranges[0];
      if (r0 && starts.has(r0.startOffset)) calls += r0.count;
    }
  }
  return calls > 0
    ? { ms, clean: false, reason: `the traced functions ran ${calls} time(s) in ${ms}ms with no request` }
    : { ms, clean: true };
}

/**
 * Function hops the trace did not record: the ones over MAX_FN_SPANS_PER_TRACE. facts.droppedSpans
 * also counts late spans (core capture.ts bumps it per late span), but those are still pushed to
 * spans with attrs["hoplens.late"], so they are recorded hops: subtract them.
 */
function droppedHops(trace: TraceRecord): number {
  const late = trace.spans.filter((s) => s.attrs?.["hoplens.late"]).length;
  return Math.max(Math.max(0, (trace.facts?.droppedSpans ?? 0) - late), droppedFunctionSpans(trace));
}

/** CONTAMINATED: keep the capture, but no truth survives. */
function markContaminated(p: PathPayload): void {
  p.quality = "contaminated";
  const unknown: Truth = { t: "unknown", why: "contaminated" };
  for (const fn of Object.values(p.functions)) fn.truth = unknown;
  for (const lane of p.lanes) lane.truth = unknown;
  p.warnings.unshift(
    "Other work ran while this request was captured, so the counts are not this request's alone: every decision is UNKNOWN. Trace path again when the app is idle.",
  );
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/* ---------------------------------------------------------- script filter */

/** Normalize for comparison: Windows paths compare case-insensitively. */
function norm(p: string): string {
  const n = path.normalize(p);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/** A file:// script inside the project root, outside node_modules, build output and Hoplens' own state. */
export function isProjectScript(url: string, root: string): boolean {
  if (!url.startsWith("file://")) return false;
  let file: string;
  try {
    file = fileURLToPath(url.replace(/[?#].*$/, ""));
  } catch {
    return false;
  }
  const f = norm(file);
  const r = norm(root);
  const base = r.endsWith(path.sep) ? r : r + path.sep;
  if (!f.startsWith(base)) return false;
  return !/[\\/](node_modules|\.next|\.hoplens|@hoplens)[\\/]/i.test(f.slice(base.length - 1));
}

function readFile(abs: string): string | undefined {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

function mtimeOf(abs: string): number | undefined {
  try {
    return fs.statSync(abs).mtimeMs;
  } catch {
    return undefined;
  }
}

/** When this process started (epoch ms): a file modified later may not be the text V8 compiled. */
const PROCESS_START = Date.now() - process.uptime() * 1000;
/** Slack for coarse file-system timestamps. */
const MTIME_SLACK_MS = 2000;

/** Frames of a captured stack: `at fn (file:line:col)` or `at file:line:col`. */
const FRAME = /^\s*at\s+(?:.*?\()?([^()\s][^()]*?):(\d+):\d+\)?\s*(?:\[framework\])?\s*$/;

/** Lines of `file` in a stack, innermost first. */
export function stackLines(stack: string, file: string): number[] {
  const out: number[] = [];
  for (const l of stack.split("\n")) {
    const m = FRAME.exec(l);
    if (m && m[1]!.replace(/\\/g, "/") === file) out.push(Number(m[2]));
  }
  return out;
}

/* --------------------------------------------------------------- the join */

interface SourceText {
  text: string;
  /** Offsets where each line starts. */
  starts: number[];
  hash: string;
}

function sourceText(text: string): SourceText {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return { text, starts, hash: createHash("sha1").update(text).digest("hex").slice(0, 12) };
}

/** 1-based line of an offset. */
function lineAt(src: SourceText, offset: number): number {
  let lo = 0;
  let hi = src.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (src.starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The module's own top-level function (V8 reports it as an anonymous function at offset 0). */
const isModuleFn = (f: FunctionCoverage) => f.functionName === "" && (f.ranges[0]?.startOffset ?? 1) === 0;

interface JoinedRef {
  url: string;
  start: number;
}

interface Built {
  lanes: Lane[];
  functions: Record<string, PathFn>;
  excess: Record<string, number>;
  /** fnKey -> why its block counts cannot be this request's alone. */
  implausible: Record<string, string>;
  joined: JoinedRef[];
  partial: boolean;
  warnings: string[];
}

/** Loop keywords: a block inside a loop may run more often than its function was entered. */
const LOOP_WORD = /\b(for|while|do)\b/;

/**
 * Source text without whole-line `//` comments ("// for each row" is common). Anything else is kept:
 * a loop word in a string or a trailing comment only makes the check skip, never fire.
 */
const stripComments = (text: string) => text.replace(/^[ \t]*\/\/[^\n]*/gm, " ");

/**
 * A block counted more often than its function was entered (K), with no loop before it in the
 * function: one call runs each such block at most once, so the extra counts are an earlier call
 * of the function resuming after an await inside the window. Conservative: any loop word between
 * the function's start and the block skips the check.
 */
function implausibleBlock(
  fn: FunctionCoverage,
  K: number,
  src: SourceText,
): { count: number; line: number } | undefined {
  const start = fn.ranges[0]!.startOffset;
  for (const r of fn.ranges.slice(1)) {
    if (r.count <= K) continue;
    if (LOOP_WORD.test(stripComments(src.text.slice(start, r.startOffset)))) continue;
    return { count: r.count, line: lineAt(src, r.startOffset) };
  }
  return undefined;
}

const LANE_KINDS = new Set(["handler", "function"]);

/** Join the trace's handler/function hops to coverage functions and cross-check their call counts (pure). */
export function buildPayload(
  trace: TraceRecord,
  scripts: readonly ScriptCoverage[],
  root: string,
  read: (abs: string) => string | undefined,
  opts: {
    droppedHops?: number;
    /** File mtime (ms) for the staleness check; omitted: no check. */
    mtime?: (abs: string) => number | undefined;
    processStart?: number;
  } = {},
): Built {
  const droppedHopsN = opts.droppedHops ?? 0;
  const byFile = new Map<string, ScriptCoverage>();
  for (const s of scripts) {
    try {
      byFile.set(norm(fileURLToPath(s.url.replace(/[?#].*$/, ""))), s);
    } catch {
      /* not a file url */
    }
  }
  const texts = new Map<string, SourceText | null>();
  const textOf = (abs: string): SourceText | null => {
    const k = norm(abs);
    if (!texts.has(k)) {
      const t = read(abs);
      texts.set(k, t === undefined ? null : sourceText(t));
    }
    return texts.get(k)!;
  };

  const laneSpans = trace.spans.filter((s) => LANE_KINDS.has(s.kind));
  const byId = new Map(trace.spans.map((s) => [s.id, s] as const));
  const keyOf = (s: SpanRecord) => (s.location ? `${s.location.file}:${s.location.line}:${s.name}` : undefined);
  const hops = new Map<string, number>();
  for (const s of laneSpans) {
    const k = keyOf(s);
    if (k) hops.set(k, (hops.get(k) ?? 0) + 1);
  }
  // Exceptions per function: its own hops that threw, and every error stack (its own, its callees')
  // recorded under one of its hops: the frames there say which statement the exception left from.
  const thrown = new Map<string, { hops: number; stacks: string[] }>();
  const bucket = (k: string) => {
    let b = thrown.get(k);
    if (!b) thrown.set(k, (b = { hops: 0, stacks: [] }));
    return b;
  };
  for (const s of trace.spans) {
    if (!s.error) continue;
    const own = LANE_KINDS.has(s.kind) ? keyOf(s) : undefined;
    if (own) bucket(own).hops++;
    const seen = new Set<string>();
    for (let a: SpanRecord | undefined = s; a; a = a.parentId ? byId.get(a.parentId) : undefined) {
      const k = LANE_KINDS.has(a.kind) ? keyOf(a) : undefined;
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const b = bucket(k);
      if (b.stacks.length < 50 && s.error.stack) b.stacks.push(s.error.stack);
    }
  }

  const functions: Record<string, PathFn> = {};
  const excess: Record<string, number> = {};
  const implausible: Record<string, string> = {};
  const joinedRefs: JoinedRef[] = [];
  const warnings: string[] = [];
  if (droppedHopsN > 0)
    warnings.push(
      `hops capped: the trace skipped ${droppedHopsN} function span(s) (over ${MAX_FN_SPANS_PER_TRACE} per trace), so call counts are not cross-checked and functions called after the cap have no lane`,
    );
  let partial = false;
  let fnCount = 0;

  const resolve = (s: SpanRecord, key: string): PathFn => {
    const loc = s.location!;
    const base: PathFn = {
      key,
      name: s.name,
      file: loc.file,
      line: loc.line,
      mapping: "none",
      calls: { hops: hops.get(key) ?? 0, coverage: null, checked: false },
      truth: { t: "unknown", why: "join-mismatch" },
      blocks: false,
      ranges: [],
    };
    if (++fnCount > MAX_FUNCTIONS) {
      base.truth = { t: "unknown", why: "too-large" };
      return base;
    }
    const abs = path.resolve(root, loc.file);
    const script = byFile.get(norm(abs));
    const src = textOf(abs);
    if (!src) {
      base.truth = { t: "unknown", why: "source-unreadable" };
      return base;
    }
    base.sourceHash = src.hash;
    const mt = opts.mtime?.(abs);
    if (mt !== undefined && opts.processStart !== undefined && mt > opts.processStart + MTIME_SLACK_MS)
      base.stale = true;
    if (!script) return base;
    const joined = join(s, script, src);
    if (joined === "ambiguous") {
      base.truth = { t: "unknown", why: "join-ambiguous" };
      return base;
    }
    if (!joined) return base;
    const r0 = joined.ranges[0]!;
    joinedRefs.push({ url: script.url, start: r0.startOffset });
    const K = r0.count;
    const H = base.calls.hops;
    base.mapping = "identity";
    base.v8Name = joined.functionName;
    base.startLine = lineAt(src, r0.startOffset);
    base.endLine = lineAt(src, Math.max(r0.startOffset, r0.endOffset - 1));
    base.blocks = joined.isBlockCoverage;
    base.calls.coverage = K;
    const ranges = joined.ranges.slice(0, MAX_RANGES);
    if (joined.ranges.length > MAX_RANGES) base.truncated = true;
    base.ranges = ranges.map((r) => ({
      start: r.startOffset,
      end: r.endOffset,
      count: r.count,
      line: lineAt(src, r.startOffset),
      endLine: lineAt(src, Math.max(r.startOffset, r.endOffset - 1)),
    }));
    const t = thrown.get(key);
    if (t) {
      const lines: number[] = [];
      for (const st of new Set(t.stacks)) {
        const l = stackLines(st, loc.file).find((x) => x >= base.startLine! && x <= base.endLine!);
        if (l !== undefined) lines.push(l);
      }
      base.errors = { hops: t.hops, lines: lines.sort((a, b) => a - b) };
    }
    if (K < H) {
      // Fewer calls than hops: the join picked the wrong function (or the hop is not this code).
      base.truth = { t: "unknown", why: "join-mismatch" };
      return base;
    }
    if (!joined.isBlockCoverage) {
      // Function-level count only (compiled before coverage started, or another inspector session
      // downgraded precise coverage): no block ranges to read decisions from.
      warnings.push(`${key}: V8 kept only a function-level count (no block ranges)`);
      base.truth = { t: "unknown", why: "no-blocks" };
      return base;
    }
    if (droppedHopsN > 0) {
      // H is a lower bound once the trace hit the hop cap: K > H says nothing.
      base.truth = K > 0 ? { t: "taken", n: K } : { t: "not" };
      partial = true;
      return base;
    }
    base.calls.checked = true;
    if (K > H) excess[key] = K - H;
    const odd = implausibleBlock(joined, K, src);
    if (odd)
      implausible[key] =
        `${key}: a block ran ${odd.count} times in ${K} call(s) outside any loop (line ${odd.line}): an earlier call resumed inside the window`;
    base.truth = K > 0 ? { t: "taken", n: K } : { t: "not" };
    return base;
  };

  const lanes: Lane[] = [];
  const ordered = laneOrder(laneSpans, byId);
  if (ordered.length > MAX_LANES) {
    partial = true;
    warnings.push(`${ordered.length - MAX_LANES} lanes not shown (a payload keeps ${MAX_LANES})`);
  }
  for (const { s, depth } of ordered) {
    const key = keyOf(s);
    const lane: Lane = {
      spanId: s.id,
      kind: s.kind as Lane["kind"],
      name: s.name,
      depth,
      calls: key ? (hops.get(key) ?? 0) : 1,
      truth: { t: "unknown", why: "no-location" },
    };
    if (s.location) {
      lane.file = s.location.file;
      lane.line = s.location.line;
    }
    if (s.error) lane.threw = true;
    if (key) {
      lane.fnKey = key;
      functions[key] ??= resolve(s, key);
      lane.truth = functions[key]!.truth;
    }
    if (lane.truth.t === "unknown") partial = true;
    if (lanes.length < MAX_LANES) lanes.push(lane);
  }
  return { lanes, functions, excess, implausible, joined: joinedRefs, partial, warnings };
}

/**
 * Lane spans in tree order: each one after its nearest lane ancestor, siblings by start time (span
 * start times alone can put a child first: a hop's span may open a moment after its first callee's).
 */
function laneOrder(spans: SpanRecord[], byId: Map<string, SpanRecord>): Array<{ s: SpanRecord; depth: number }> {
  const parentOf = (s: SpanRecord): string | undefined => {
    for (let p = s.parentId ? byId.get(s.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined)
      if (LANE_KINDS.has(p.kind)) return p.id;
    return undefined;
  };
  const kids = new Map<string | undefined, SpanRecord[]>();
  for (const s of spans) {
    const p = parentOf(s);
    const list = kids.get(p);
    if (list) list.push(s);
    else kids.set(p, [s]);
  }
  const out: Array<{ s: SpanRecord; depth: number }> = [];
  const walk = (parent: string | undefined, depth: number) => {
    const list = (kids.get(parent) ?? []).slice().sort((a, b) => a.start - b.start);
    for (const s of list) {
      out.push({ s, depth });
      walk(s.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

/**
 * The coverage function a hop names. A function hop's line is its declaration line: the function
 * starting there, by V8 name when several do. A handler hop's line is its registration call: the
 * outermost function starting within a few lines of it that ran.
 */
function join(s: SpanRecord, script: ScriptCoverage, src: SourceText): FunctionCoverage | "ambiguous" | undefined {
  const line = s.location!.line;
  const fns = script.functions.filter((f) => f.ranges.length && !isModuleFn(f));
  if (s.kind === "function") {
    const at = fns.filter((f) => lineAt(src, f.ranges[0]!.startOffset) === line);
    const named = at.filter((f) => f.functionName === s.name);
    if (named.length === 1) return named[0];
    if (named.length > 1) return "ambiguous";
    if (at.length === 1) return at[0];
    return at.length > 1 ? "ambiguous" : undefined;
  }
  const near = fns.filter((f) => {
    const l = lineAt(src, f.ranges[0]!.startOffset);
    return l >= line && l <= line + HANDLER_LOOKAHEAD && f.ranges[0]!.count > 0;
  });
  const outer = near.filter(
    (f) =>
      !near.some(
        (g) =>
          g !== f &&
          g.ranges[0]!.startOffset <= f.ranges[0]!.startOffset &&
          g.ranges[0]!.endOffset >= f.ranges[0]!.endOffset,
      ),
  );
  if (outer.length === 1) return outer[0];
  return outer.length > 1 ? "ambiguous" : undefined;
}

/* -------------------------------------------------------------- the store */

/** The last PATH_LRU payloads, keyed by the new trace's id. One per store (so per Runtime). */
export class PathResults {
  private readonly map = new Map<string, PathPayload>();
  constructor(readonly cap = PATH_LRU) {}
  get(id: string): PathPayload | undefined {
    const v = this.map.get(id);
    if (v) {
      this.map.delete(id);
      this.map.set(id, v);
    }
    return v;
  }
  set(id: string, v: PathPayload): void {
    this.map.delete(id);
    this.map.set(id, v);
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number {
    return this.map.size;
  }
}

const results = new WeakMap<object, PathResults>();

export function pathResults(owner: object): PathResults {
  let r = results.get(owner);
  if (!r) results.set(owner, (r = new PathResults()));
  return r;
}
