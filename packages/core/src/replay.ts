import { randomUUID } from "node:crypto";
import type { Runtime } from "./runtime";
import { preview } from "./serialize";
import type { TraceRecord } from "./types";

/* ------------------------------------------------------------------ inputs */

export interface RunInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  profile?: string;
  /** Replay xN (WP7): run the request N times in a row (1-50). Absent = a single run, legacy response. */
  repeat?: number;
  /** Keep repeating after a 5xx (default: stop at the first one). */
  keepGoing?: boolean;
}

/** Hard limits for a replay batch (plan 4.2 WP7). */
export const MAX_REPEAT = 50;
export const BATCH_TOTAL_MS = 120_000;
/** How long one run waits for its trace to finish after the response arrived. */
export const TRACE_WAIT_MS = 60_000;

export class RunInputError extends Error {}

/**
 * Parse a `repeat` value from the query string or JSON body. `undefined` = not a batch.
 * Non-integers and values < 1 are rejected; values above MAX_REPEAT are capped (`capped: true`).
 */
export function parseRepeat(raw: unknown): { n: number; capped: boolean; requested: number } | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1) throw new RunInputError(`repeat must be a whole number from 1 to ${MAX_REPEAT}`);
  return n > MAX_REPEAT ? { n: MAX_REPEAT, capped: true, requested: n } : { n, capped: false, requested: n };
}

export function parseFlag(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "1" || raw.toLowerCase() === "true";
  return false;
}

/* ------------------------------------------------------------------- stats */

export interface WarmStats {
  /** Runs that count: warm (not cold), reached the app, status < 500, trace captured. */
  n: number;
  p50?: number;
  p95?: number;
  min?: number;
  max?: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Exact quantile with linear interpolation between closest ranks (q in [0,1]); undefined when empty. */
export function quantile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function warmStats(durations: readonly number[]): WarmStats {
  const s = durations.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  if (s.length === 0) return { n: 0 };
  return {
    n: s.length,
    p50: r1(quantile(s, 0.5)!),
    p95: r1(quantile(s, 0.95)!),
    min: r1(s[0]!),
    max: r1(s[s.length - 1]!),
  };
}

/* --------------------------------------------------------- "vs last run" */

export interface PreviousBatch {
  batchId: string;
  /** epoch ms when the batch finished. */
  at: number;
  warm: WarmStats;
  coldExcluded: number;
}

/** Key a replay is compared under: method + path (with query) + profile. */
export function runKey(method: string, path: string, profile?: string): string {
  return `${method.toUpperCase()} ${path}${profile ? ` @${profile}` : ""}`;
}

/** Small LRU of the last replay batch per runKey (Runtime.lastRuns, cap 100). */
export class LastRuns {
  private readonly map = new Map<string, PreviousBatch>();
  constructor(readonly cap = 100) {}
  get size() {
    return this.map.size;
  }
  get(key: string): PreviousBatch | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: PreviousBatch): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

/** Delta of this batch against the previous one; undefined when either side has no warm runs. */
export function vsPrevious(
  warm: WarmStats,
  prev: PreviousBatch | undefined,
): { p50Ms: number; p95Ms: number; p50Pct: number } | undefined {
  if (!prev || warm.p50 === undefined || prev.warm.p50 === undefined) return undefined;
  const p50Ms = r1(warm.p50 - prev.warm.p50);
  return {
    p50Ms,
    p95Ms: r1(warm.p95! - prev.warm.p95!),
    p50Pct: prev.warm.p50 > 0 ? Math.round((p50Ms / prev.warm.p50) * 1000) / 1000 : 0,
  };
}

/* --------------------------------------------------------------- one run */

export interface PreparedRun {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  hasBody: boolean;
}

/** Validate the input and resolve headers (profile, ${ENV} interpolation, content-type). */
export function prepareRun(rt: Runtime, input: RunInput): PreparedRun {
  const port = rt.appPort ?? (Number(process.env.PORT) || 3000);
  if (!input.path || typeof input.path !== "string" || !input.path.startsWith("/"))
    throw new RunInputError("Path must start with /");
  const headers: Record<string, string> = {};
  const profile = input.profile ? rt.options.profiles?.[input.profile] : undefined;
  if (input.profile && !profile) throw new RunInputError(`Unknown profile "${input.profile}"`);
  for (const [k, v] of Object.entries(profile?.headers ?? {})) headers[k.toLowerCase()] = interpolate(v);
  for (const [k, v] of Object.entries(input.headers ?? {}))
    if (k.trim()) headers[k.trim().toLowerCase()] = interpolate(String(v));
  const method = (input.method || "GET").toUpperCase();
  const hasBody = input.body !== undefined && input.body !== "" && method !== "GET" && method !== "HEAD";
  if (hasBody && !headers["content-type"])
    headers["content-type"] = /^\s*[[{]/.test(input.body!) ? "application/json" : "text/plain";
  return { port, method, path: input.path, headers, body: hasBody ? input.body : undefined, hasBody };
}

export function interpolate(v: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}

export interface RunOnceResult {
  runId: string;
  trace?: TraceRecord;
  status: number;
  error?: string;
  /** The deadline (signal) cut this run short. */
  timedOut?: boolean;
  /** Client-side wall time, ms. */
  elapsed: number;
}

/**
 * Fire one request at the app with a fresh `x-hoplens-run` id (and `x-hoplens-batch` when given),
 * then wait up to `traceWaitMs` for its trace to finish. Never throws.
 */
export async function runOnce(
  rt: Runtime,
  p: PreparedRun,
  opts: { batchId?: string; traceWaitMs?: number; signal?: AbortSignal } = {},
): Promise<RunOnceResult> {
  const runId = randomUUID();
  const headers: Record<string, string> = { ...p.headers, "x-hoplens-run": runId };
  if (opts.batchId) headers["x-hoplens-batch"] = opts.batchId;

  // Subscribe before firing: the trace can finish before fetch() resolves.
  let onDone: ((t: TraceRecord) => void) | undefined;
  let captured: TraceRecord | undefined;
  let wake: (() => void) | undefined;
  onDone = (t: TraceRecord) => {
    if (t.runId !== runId) return;
    captured = t;
    wake?.();
  };
  rt.store.on("done", onDone);
  const unsubscribe = () => {
    if (onDone) rt.store.off("done", onDone);
    onDone = undefined;
  };

  const started = Date.now();
  let status = 0;
  let error: string | undefined;
  let timedOut = false;
  try {
    try {
      const r = await fetch(`http://127.0.0.1:${p.port}${p.path}`, {
        method: p.method,
        headers,
        body: p.body,
        redirect: "manual",
        signal: opts.signal,
      });
      status = r.status;
      await r.arrayBuffer().catch(() => undefined);
    } catch (err: any) {
      if (opts.signal?.aborted) {
        timedOut = true;
        error = "Stopped: the replay hit its time limit";
      } else {
        error = `Could not reach your app on port ${p.port}: ${err?.cause?.code ?? err?.message ?? err}`;
      }
    }
    if (!error && !captured) {
      const wait = Math.max(0, opts.traceWaitMs ?? TRACE_WAIT_MS);
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, wait);
        wake = finish;
        opts.signal?.addEventListener("abort", finish, { once: true });
        if (captured || opts.signal?.aborted) finish();
      });
    }
  } finally {
    unsubscribe();
  }
  const trace = error ? undefined : (captured ?? rt.store.byRun(runId));
  if (trace && p.hasBody) attachRequestBody(rt, trace, p);
  return { runId, trace, status, error, timedOut: timedOut || undefined, elapsed: Date.now() - started };
}

/** The app may not have read the body (or capture skipped it): fill it in from what we sent. */
function attachRequestBody(rt: Runtime, trace: TraceRecord, p: PreparedRun) {
  const internal = rt.store.internal(trace);
  if (internal) internal.rawBody = p.body;
  if (trace.request.body !== undefined) return;
  trace.request.body = {
    contentType: p.headers["content-type"],
    size: Buffer.byteLength(p.body!),
    text: p.body!.slice(0, 20000),
  };
  try {
    trace.request.body.json = preview(JSON.parse(p.body!), rt.redactor);
    trace.request.body.text = undefined;
  } catch {
    /* keep text */
  }
}

/* ------------------------------------------------------------- the batch */

export type RunExclusion = "cold" | "5xx" | "error" | "no-trace";

export interface BatchRun {
  runId: string;
  traceId?: string;
  status: number;
  error?: string;
  /** Client-side wall time, ms. */
  elapsed: number;
  /** Server-side trace duration, ms (what the stats use). */
  duration?: number;
  cold: boolean;
  /** Why the run is left out of `warm`; absent = counted. */
  excluded?: RunExclusion;
}

export type BatchStop = "5xx" | "unreachable" | "timeout";

export interface BatchResult {
  batchId: string;
  key: string;
  /** What was asked for, before the cap. */
  requested: number;
  repeat: number;
  capped: boolean;
  runs: BatchRun[];
  warm: WarmStats;
  coldExcluded: number;
  /** Set when the batch ended before `repeat` runs. */
  stopped?: BatchStop;
  /** The previous batch for the same key (method, path, profile), if any. */
  previous: PreviousBatch | null;
  vsPrevious?: { p50Ms: number; p95Ms: number; p50Pct: number };
  /** Last run's trace + status, so single-run callers can read a batch the same way. */
  traceId?: string;
  status: number;
  elapsed: number;
}

/**
 * HTTP status for a batch: 502 only when the app was never reached (every run failed and the batch
 * stopped as unreachable). A batch cut off by its time limit did reach the app: 200.
 */
export function batchHttpStatus(r: Pick<BatchResult, "runs" | "stopped">): 200 | 502 {
  return r.stopped === "unreachable" && r.runs.every((x) => x.excluded === "error") ? 502 : 200;
}

export function toBatchRun(r: RunOnceResult): BatchRun {
  const t = r.trace;
  const cold = !!t?.facts?.cold;
  const excluded: RunExclusion | undefined = r.error
    ? "error"
    : r.status >= 500
      ? "5xx"
      : !t || t.duration === undefined
        ? "no-trace"
        : cold
          ? "cold"
          : undefined;
  const out: BatchRun = { runId: r.runId, traceId: t?.id, status: r.status, elapsed: r.elapsed, cold };
  if (r.error) out.error = r.error;
  if (t?.duration !== undefined) out.duration = Math.round(t.duration * 10) / 10;
  if (excluded) out.excluded = excluded;
  return out;
}

/** Fold the runs into the response shape (pure). */
export function summarizeBatch(runs: readonly BatchRun[]): { warm: WarmStats; coldExcluded: number } {
  return {
    warm: warmStats(runs.filter((r) => !r.excluded).map((r) => r.duration!)),
    coldExcluded: runs.filter((r) => r.excluded === "cold").length,
  };
}

export interface BatchOptions {
  totalMs?: number;
  traceWaitMs?: number;
  now?: () => number;
}

/**
 * Replay xN: run sequentially, stop at the first 5xx (unless keepGoing), at an unreachable app, or
 * when the total time cap runs out. Cold runs are kept in `runs` but left out of `warm`.
 */
export async function runBatch(
  rt: Runtime,
  input: RunInput,
  repeat: { n: number; capped: boolean; requested?: number },
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const p = prepareRun(rt, input);
  const now = opts.now ?? Date.now;
  const totalMs = opts.totalMs ?? BATCH_TOTAL_MS;
  const batchId = `b_${randomUUID().slice(0, 8)}`;
  const key = runKey(p.method, p.path, input.profile);
  const started = now();
  const deadline = started + totalMs;
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), totalMs);
  const runs: BatchRun[] = [];
  let stopped: BatchStop | undefined;
  try {
    for (let i = 0; i < repeat.n; i++) {
      const remaining = deadline - now();
      if (remaining <= 0 || ac.signal.aborted) {
        stopped = "timeout";
        break;
      }
      const r = await runOnce(rt, p, {
        batchId,
        traceWaitMs: Math.min(opts.traceWaitMs ?? TRACE_WAIT_MS, remaining),
        signal: ac.signal,
      });
      runs.push(toBatchRun(r));
      if (r.timedOut) {
        stopped = "timeout";
        break;
      }
      if (r.error) {
        stopped = "unreachable";
        break;
      }
      if (r.status >= 500 && !input.keepGoing) {
        stopped = "5xx";
        break;
      }
    }
  } finally {
    clearTimeout(killer);
  }

  const { warm, coldExcluded } = summarizeBatch(runs);
  const previous = rt.lastRuns.get(key) ?? null;
  if (warm.n > 0) rt.lastRuns.set(key, { batchId, at: Date.now(), warm, coldExcluded });
  const last = runs[runs.length - 1];
  const result: BatchResult = {
    batchId,
    key,
    requested: repeat.requested ?? repeat.n,
    repeat: repeat.n,
    capped: repeat.capped,
    runs,
    warm,
    coldExcluded,
    previous,
    traceId: last?.traceId,
    status: last?.status ?? 0,
    elapsed: now() - started,
  };
  if (stopped) result.stopped = stopped;
  const delta = vsPrevious(warm, previous ?? undefined);
  if (delta) result.vsPrevious = delta;
  return result;
}
