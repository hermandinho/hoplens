import { batch, signal } from "@preact/signals";
import { HoplensApiError, api } from "../api/client";
import type { ReplayResult, ReplayRun, TraceSummary } from "../api/types";
import { fmtMs as fmt } from "./stats";

/*
 * Replay xN (plan 4.2 WP7, keys `r` / `R` in 3.9). One job at a time: the core runs a batch
 * sequentially and answers once, with warm p50/p95 (cold runs left out) and the previous batch for
 * the same request ("vs last run"). Progress comes from the live trace stream: every run of a batch
 * carries `batchId`, so the runs already captured are counted while the POST is still open.
 *
 * The pure helpers (request shaping, the run strip, the median run, the "vs last run" line, when a
 * compare is worth offering) are exported for tests; the components only render what they return.
 */

/** Runs per replay (`R`). */
export const REPLAY_N = 10;

export interface ReplayRequest {
  method: string;
  /** Path with query, starting with "/". */
  path: string;
  headers?: Record<string, string>;
  body?: string;
  profile?: string;
}

export type ReplaySource = { kind: "trace"; traceId: string } | { kind: "builder"; routeKey: string };

export type ReplayPhase = "confirm" | "running" | "done" | "error";

export interface ReplayJob {
  id: number;
  source: ReplaySource;
  req: ReplayRequest;
  n: number;
  phase: ReplayPhase;
  /** Client clock when the POST went out (progress counts traces started after it). */
  startedAt: number;
  /** Duration of the request it was replayed from (trace source only). */
  sourceMs?: number;
  result?: ReplayResult;
  error?: string;
}

export const replayJob = signal<ReplayJob | null>(null);

/* ----------------------------------------------------------------- pure helpers */

/** A repeat of anything but GET/HEAD/OPTIONS repeats its side effects too: ask first (plan 4.2 WP7). */
export function needsConfirm(method: string, n: number): boolean {
  return n > 1 && !/^(GET|HEAD|OPTIONS)$/i.test(method);
}

/** "/api/feed?x=1" from either a path or an absolute URL. */
export function pathOf(url: string): string {
  if (url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return `/${url}`;
  }
}

/** Headers the core sets per run, or that would make every run look like the same batch. */
const DROP_HEADERS = new Set(["x-hoplens-batch", "content-length", "host", "connection", "transfer-encoding"]);

/** The captured request (GET /api/traces/:id/request) as a run input. */
export function requestFromRaw(raw: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): ReplayRequest {
  const method = (raw.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.headers ?? {})) {
    if (DROP_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  const canHaveBody = method !== "GET" && method !== "HEAD";
  return {
    method,
    path: pathOf(raw.url),
    headers,
    body: canHaveBody && raw.body ? raw.body : undefined,
  };
}

/** A run that counts toward the warm stats and has a server duration. */
function counted(r: ReplayRun): r is ReplayRun & { duration: number } {
  return !r.excluded && typeof r.duration === "number";
}

/** The counted run closest to the warm p50 (earliest on a tie). */
export function medianRun(res: Pick<ReplayResult, "runs" | "warm">): ReplayRun | undefined {
  const p50 = res.warm.p50;
  if (p50 === undefined) return undefined;
  let best: ReplayRun | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const r of res.runs) {
    if (!counted(r) || !r.traceId) continue;
    const d = Math.abs(r.duration - p50);
    if (d < gap) {
      best = r;
      gap = d;
    }
  }
  return best;
}

export type StripKind = "warm" | "cold" | "fail" | "pending";

export interface StripCell {
  key: string;
  traceId?: string;
  ms?: number;
  /** Bar height, 0-1 of the tallest run. */
  h: number;
  kind: StripKind;
  median: boolean;
  label: string;
}

const EXCLUDED_LABEL: Record<string, string> = {
  cold: "cold, left out of p50/p95",
  "5xx": "5xx, left out",
  error: "did not reach the app",
  "no-trace": "no trace captured, left out",
};

/**
 * One bar per run, in run order, then a pending slot for each run not done yet. Heights share one
 * scale (the slowest run), so the strip reads as the spread of the batch.
 */
export function stripCells(
  runs: readonly { runId: string; traceId?: string; ms?: number; kind: StripKind; why?: string }[],
  n: number,
  medianTraceId?: string,
): StripCell[] {
  let max = 0;
  for (const r of runs) if (r.ms !== undefined && r.ms > max) max = r.ms;
  const out: StripCell[] = runs.map((r, i) => {
    const ms = r.ms;
    const h = ms !== undefined && max > 0 ? Math.max(0.08, ms / max) : 0.08;
    const median = !!medianTraceId && r.traceId === medianTraceId;
    const what = ms !== undefined ? fmt(ms) : "no duration";
    const why = r.why ? `, ${r.why}` : r.kind === "pending" ? ", running" : "";
    return {
      key: r.runId,
      traceId: r.traceId,
      ms,
      h,
      kind: r.kind,
      median,
      label: `Run ${i + 1}: ${what}${why}${median ? " (median run)" : ""}`,
    };
  });
  for (let i = out.length; i < n; i++)
    out.push({ key: `pending-${i}`, h: 0, kind: "pending", median: false, label: `Run ${i + 1}: not run yet` });
  return out;
}

/** The finished batch's runs as strip input. */
export function resultRuns(res: ReplayResult) {
  return res.runs.map((r) => ({
    runId: r.runId,
    traceId: r.traceId,
    ms: r.duration ?? (r.error ? undefined : r.elapsed),
    kind: (r.excluded === "cold" ? "cold" : r.excluded ? "fail" : "warm") as StripKind,
    why: r.excluded ? EXCLUDED_LABEL[r.excluded] : undefined,
  }));
}

/** Traces of this job captured so far (batch runs of the same request since it started), oldest first. */
export function progressTraces(
  traces: readonly TraceSummary[],
  job: Pick<ReplayJob, "req" | "startedAt">,
): TraceSummary[] {
  const out = traces.filter(
    (t) =>
      !!t.batchId &&
      t.startedAt >= job.startedAt - 1000 &&
      t.method.toUpperCase() === job.req.method.toUpperCase() &&
      pathOf(t.url) === job.req.path,
  );
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Live traces as strip input: finished ones get a bar, the one in flight a pending slot. */
export function liveRuns(traces: readonly TraceSummary[]) {
  return traces
    .filter((t) => t.done)
    .map((t) => ({
      runId: t.id,
      traceId: t.id,
      ms: t.duration,
      kind: (t.facts?.cold ? "cold" : (t.status ?? 0) >= 500 || t.error ? "fail" : "warm") as StripKind,
      why: t.facts?.cold ? "cold" : undefined,
    }));
}

export type DeltaTone = "worse" | "better" | "same";

/** Same rule as a regression (plan 3.5): a move of at least max(20%, 5ms) counts. */
export function deltaTone(deltaMs: number, baseMs: number): DeltaTone {
  const floor = Math.max(5, Math.abs(baseMs) * 0.2);
  if (deltaMs >= floor) return "worse";
  if (deltaMs <= -floor) return "better";
  return "same";
}

export interface VsLast {
  text: string;
  tone: DeltaTone;
}

/** The "vs last run" line, or a note that this is the first replay of the request. */
export function vsLastRun(res: Pick<ReplayResult, "previous" | "warm" | "key">, now: number): VsLast | null {
  const prev = res.previous;
  if (!prev) return { text: `First replay of ${res.key} this session`, tone: "same" };
  const a = prev.warm.p50;
  const b = res.warm.p50;
  const when = ago(now - prev.at);
  if (a === undefined || b === undefined) return { text: `Last run ${when}: no warm runs to compare`, tone: "same" };
  const d = b - a;
  const pct = a > 0 ? Math.round((d / a) * 100) : 0;
  const sign = d > 0 ? "+" : d < 0 ? "-" : "";
  const p95 =
    prev.warm.p95 !== undefined && res.warm.p95 !== undefined
      ? `, p95 ${fmt(prev.warm.p95)} -> ${fmt(res.warm.p95)}`
      : "";
  return {
    text: `vs last run ${when}: p50 ${fmt(a)} -> ${fmt(b)} (${sign}${Math.abs(pct)}%)${p95}`,
    tone: deltaTone(d, a),
  };
}

export interface CompareOffer {
  /** Baseline: the median run. */
  a: string;
  b: string;
  label: string;
  detail: string;
}

/**
 * When a compare tells the reader something: the request replayed from (or, from the builder, the
 * slowest run) is off the batch median by at least max(20%, 5ms). Otherwise null; no button.
 */
export function compareOffer(
  res: Pick<ReplayResult, "runs" | "warm">,
  source?: { traceId: string; ms?: number },
): CompareOffer | null {
  const med = medianRun(res);
  const p50 = res.warm.p50;
  if (!med?.traceId || p50 === undefined) return null;
  if (source) {
    if (source.ms === undefined || source.traceId === med.traceId) return null;
    if (deltaTone(source.ms - p50, p50) === "same") return null;
    return {
      a: med.traceId,
      b: source.traceId,
      label: "Compare with the median run",
      detail: `this request ${fmt(source.ms)} vs median run ${fmt(med.duration ?? p50)}`,
    };
  }
  let slow: ReplayRun | undefined;
  for (const r of res.runs) if (counted(r) && r.traceId && (!slow || r.duration > (slow.duration ?? 0))) slow = r;
  if (!slow?.traceId || slow.traceId === med.traceId || res.warm.n < 3) return null;
  if (deltaTone((slow.duration ?? 0) - p50, p50) !== "worse") return null;
  return {
    a: med.traceId,
    b: slow.traceId,
    label: "Compare the slowest run with the median",
    detail: `slowest ${fmt(slow.duration ?? 0)} vs median ${fmt(med.duration ?? p50)}`,
  };
}

/** "p50 323ms . p95 410ms . 9 warm, 1 cold left out" */
export function statsLine(res: Pick<ReplayResult, "warm" | "coldExcluded" | "runs">): string {
  const w = res.warm;
  const parts: string[] = [];
  if (w.p50 !== undefined) parts.push(`p50 ${fmt(w.p50)}`);
  if (w.p95 !== undefined) parts.push(`p95 ${fmt(w.p95)}`);
  if (w.min !== undefined && w.max !== undefined && w.n > 1) parts.push(`${fmt(w.min)}-${fmt(w.max)}`);
  const left = res.runs.length - w.n - res.coldExcluded;
  let counts = `${w.n} warm`;
  if (res.coldExcluded) counts += `, ${res.coldExcluded} cold left out`;
  if (left > 0) counts += `, ${left} failed`;
  parts.push(counts);
  return parts.join(" · ");
}

/** Why a batch ended early, in words; undefined when it ran every run. */
export function stopNote(res: Pick<ReplayResult, "stopped" | "runs" | "repeat">): string | undefined {
  const done = `${res.runs.length} of ${res.repeat}`;
  switch (res.stopped) {
    case "5xx":
      return `Stopped after ${done}: the app answered 5xx`;
    case "unreachable":
      return `Stopped after ${done}: the app did not answer`;
    case "timeout":
      return `Stopped after ${done}: hit the 120s limit`;
    default:
      return undefined;
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/* --------------------------------------------------------------------- actions */

let nextId = 1;

export function isRunning(): boolean {
  return replayJob.peek()?.phase === "running" || replayingOnce.peek() || batchesInFlight.peek() > 0;
}

/** Batches started outside the job (a Changes verdict row's replay x10) that are still open. */
export const batchesInFlight = signal(0);

/** Reactive "a replay is running" for buttons outside the panel. */
export function replayBusy(): boolean {
  return replayJob.value?.phase === "running" || replayingOnce.value || batchesInFlight.value > 0;
}

/**
 * POST /api/run with `repeat` and read the batch. A 502 (every run failed to reach the app) still
 * carries the batch and resolves as a result; any other failure rejects with the core's message.
 */
export async function runBatch(req: ReplayRequest, n: number): Promise<ReplayResult> {
  try {
    return (await api.run({ ...req, repeat: n })) as unknown as ReplayResult;
  } catch (err) {
    if (err instanceof HoplensApiError) {
      let body: (Partial<ReplayResult> & { error?: string }) | undefined;
      try {
        body = JSON.parse(err.body) as Partial<ReplayResult> & { error?: string };
      } catch {
        throw new Error(err.message);
      }
      if (Array.isArray(body.runs)) return body as ReplayResult;
      throw new Error(body.error ?? err.message);
    }
    throw err;
  }
}

/** A one-off batch outside the replay panel (Changes): counted so `r` / `R` wait for it. */
export async function runSideBatch(req: ReplayRequest, n = REPLAY_N): Promise<ReplayResult> {
  batchesInFlight.value++;
  try {
    return await runBatch(req, n);
  } finally {
    batchesInFlight.value--;
  }
}

/**
 * Start a replay of `req` x`n`. A non-GET repeat waits in "confirm" until `confirmReplay()`.
 * Ignored while another batch runs (the core runs one request at a time anyway).
 */
export function startReplay(
  source: ReplaySource,
  req: ReplayRequest,
  opts: { n?: number; sourceMs?: number; confirmed?: boolean } = {},
): void {
  if (isRunning()) return;
  const n = opts.n ?? REPLAY_N;
  const job: ReplayJob = {
    id: nextId++,
    source,
    req,
    n,
    phase: needsConfirm(req.method, n) && !opts.confirmed ? "confirm" : "running",
    startedAt: Date.now(),
    sourceMs: opts.sourceMs,
  };
  replayJob.value = job;
  if (job.phase === "running") void execute(job);
}

export function confirmReplay(): void {
  const job = replayJob.peek();
  if (job?.phase !== "confirm") return;
  const running: ReplayJob = { ...job, phase: "running", startedAt: Date.now() };
  replayJob.value = running;
  void execute(running);
}

/** Drop the confirm prompt or a finished result. A running batch can't be called back. */
export function dismissReplay(): void {
  if (!isRunning()) replayJob.value = null;
}

/** Replay a captured request: fetch what the handler saw, then run it. */
export async function replayTrace(trace: { id: string; duration?: number }, n = REPLAY_N): Promise<void> {
  if (isRunning()) return;
  try {
    const raw = await api.rawRequest(trace.id);
    startReplay({ kind: "trace", traceId: trace.id }, requestFromRaw(raw), { n, sourceMs: trace.duration });
  } catch (err) {
    replayJob.value = {
      id: nextId++,
      source: { kind: "trace", traceId: trace.id },
      req: { method: "GET", path: "/" },
      n,
      phase: "error",
      startedAt: Date.now(),
      error: `Could not read the captured request: ${(err as Error).message}`,
    };
  }
}

/**
 * Replay once (`r`): no batch, the core's single-run answer. Resolves to the new trace id so the
 * caller can open it.
 */
export async function replayOnce(trace: { id: string }): Promise<string | undefined> {
  if (isRunning() || replayingOnce.peek()) return undefined;
  replayingOnce.value = true;
  try {
    const raw = await api.rawRequest(trace.id);
    const res = await api.run({ ...requestFromRaw(raw) });
    if (res.error) throw new Error(res.error);
    return res.traceId;
  } finally {
    replayingOnce.value = false;
  }
}

/** A single replay (`r`) is in flight. */
export const replayingOnce = signal(false);

async function execute(job: ReplayJob): Promise<void> {
  let result: ReplayResult | undefined;
  let error: string | undefined;
  try {
    result = await runBatch(job.req, job.n);
  } catch (err) {
    error = (err as Error).message;
  }
  // A newer job replaced this one (it can't while running, but a dismiss + restart could race).
  if (replayJob.peek()?.id !== job.id) return;
  batch(() => {
    replayJob.value = result ? { ...job, phase: "done", result } : { ...job, phase: "error", error };
  });
}
