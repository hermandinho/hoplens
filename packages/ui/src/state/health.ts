import { computed, signal } from "@preact/signals";
import { HoplensApiError, api, tapLive } from "../api/client";
import type {
  HealthErrorCounts,
  HealthSample,
  HealthSnapshot,
  HealthTick,
  ProcessErrorRecord,
  TraceSummary,
} from "../api/types";

/*
 * Process health for the top bar's status slot (plan 4.2 WP6): event-loop delay, memory and the
 * process-level errors (uncaught exceptions, unhandled rejections) the core records.
 *
 * Source: one GET /api/health on start (and after every live-stream reconnect, so errors recorded
 * while disconnected still show), then the `event: health` ticks on the main /api/events stream.
 * An older core without /api/health answers 404: the strip then stays hidden ("missing").
 *
 * The pure helpers (applySnapshot, applyTick, loopLevel, fmtMem, requestRate) are unit-tested.
 */

/** Samples kept client-side (matches the core ring: 5 minutes at 2s). */
export const SAMPLE_CAP = 150;
/** Process errors kept client-side (matches the core error ring). */
export const ERROR_CAP = 50;
/** Loop p99 at or above this is red (plan 4.2 WP6: "red when p99 > 100ms"). */
export const LOOP_ERR_MS = 100;
/** Loop p99 at or above this is amber: noticeable stalls, not yet a blocked loop. */
export const LOOP_WARN_MS = 50;
/** Window for the request rate next to the live dot. */
export const RATE_WINDOW_MS = 10_000;

export type HealthAvailability = "unknown" | "available" | "missing";

export interface HealthState {
  availability: HealthAvailability;
  /** False when the core's monitor is off (production build, or stopped). */
  active: boolean;
  sampleMs: number;
  current: HealthSample | null;
  /** Oldest first, at most SAMPLE_CAP. */
  samples: HealthSample[];
  /** Oldest first (by id), at most ERROR_CAP. */
  errors: ProcessErrorRecord[];
  /** Totals since the process started; can exceed `errors.length` once the ring wrapped. */
  errorCounts: HealthErrorCounts;
  /** Whether unhandled rejections are recorded (the core only listens while the app has a listener). */
  watchingRejections: boolean;
}

export const EMPTY_HEALTH: HealthState = {
  availability: "unknown",
  active: false,
  sampleMs: 2000,
  current: null,
  samples: [],
  errors: [],
  errorCounts: { uncaughtException: 0, unhandledRejection: 0 },
  watchingRejections: false,
};

function mergeErrors(a: readonly ProcessErrorRecord[], b: readonly ProcessErrorRecord[]): ProcessErrorRecord[] {
  if (b.length === 0) return a as ProcessErrorRecord[];
  const byId = new Map<number, ProcessErrorRecord>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => x.id - y.id).slice(-ERROR_CAP);
}

/** Replace the state with a full snapshot (keeps nothing but the merged error list). */
export function applySnapshot(prev: HealthState, snap: HealthSnapshot): HealthState {
  return {
    availability: "available",
    active: snap.active,
    sampleMs: snap.sampleMs,
    current: snap.current,
    samples: snap.samples.slice(-SAMPLE_CAP),
    // A snapshot is authoritative, but a tick may have raced ahead of it: keep the union.
    errors: mergeErrors(prev.errors, snap.errors),
    errorCounts: snap.errorCounts,
    watchingRejections: snap.watchingRejections,
  };
}

/** Fold one SSE tick in: the newest sample, counts, and the errors recorded since the last tick. */
export function applyTick(prev: HealthState, tick: HealthTick): HealthState {
  const cur = tick.current;
  const last = prev.samples[prev.samples.length - 1];
  const samples = cur && (!last || cur.t > last.t) ? [...prev.samples, cur].slice(-SAMPLE_CAP) : prev.samples;
  return {
    ...prev,
    availability: "available",
    active: prev.availability === "available" ? prev.active || cur !== null : cur !== null,
    current: cur ?? prev.current,
    samples,
    errors: mergeErrors(prev.errors, tick.newErrors),
    errorCounts: tick.errorCounts,
  };
}

export type LoopLevel = "ok" | "warn" | "err";

export function loopLevel(p99: number | undefined): LoopLevel {
  if (p99 === undefined || !Number.isFinite(p99)) return "ok";
  if (p99 >= LOOP_ERR_MS) return "err";
  if (p99 >= LOOP_WARN_MS) return "warn";
  return "ok";
}

/** A level from the last few samples is held this many ticks (2s each), so one stall stays visible. */
export const LOOP_HOLD_SAMPLES = 3;

export interface LoopView {
  level: LoopLevel;
  /** Which number the chip shows: the window's p99, or its max when a single stall set the level. */
  metric: "p99" | "max";
  ms: number;
}

const LEVEL_RANK: Record<LoopLevel, number> = { ok: 0, warn: 1, err: 2 };

/**
 * The loop chip (r2): a sustained delay (p99) is judged by `loopLevel`; one isolated stall barely
 * moves a 2s window's p99 (a 300ms block read "p99 34ms", green), so a max at or above LOOP_ERR_MS
 * is at least amber. The worst level of the last LOOP_HOLD_SAMPLES samples is held, with the number
 * that caused it. `recent` is oldest first and ends with the current sample.
 */
export function loopView(recent: readonly Pick<HealthSample, "loopP99" | "loopMax">[]): LoopView | undefined {
  const cur = recent[recent.length - 1];
  if (!cur) return undefined;
  let out: LoopView = { level: loopLevel(cur.loopP99), metric: "p99", ms: cur.loopP99 };
  for (const s of recent.slice(-LOOP_HOLD_SAMPLES)) {
    const byP99 = loopLevel(s.loopP99);
    const byMax: LoopLevel = Number.isFinite(s.loopMax) && s.loopMax >= LOOP_ERR_MS ? "warn" : "ok";
    const fromMax = LEVEL_RANK[byMax] > LEVEL_RANK[byP99];
    const level = fromMax ? byMax : byP99;
    if (LEVEL_RANK[level] > LEVEL_RANK[out.level]) {
      out = fromMax ? { level, metric: "max", ms: s.loopMax } : { level, metric: "p99", ms: s.loopP99 };
    }
  }
  return out;
}

/** Compact memory: "840K", "312M", "1.1G" (binary units, as the OS reports RSS). */
export function fmtMem(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  const K = 1024;
  const M = K * K;
  const G = M * K;
  if (bytes >= G) return `${(bytes / G).toFixed(bytes >= 10 * G ? 0 : 1)}G`;
  if (bytes >= M) return `${Math.round(bytes / M)}M`;
  if (bytes >= K) return `${Math.round(bytes / K)}K`;
  return `${Math.round(bytes)}B`;
}

/** Loop delay in ms, rounded for a status line: "4ms", "120ms", "1.2s". */
export function fmtLoop(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms >= 999.5) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Requests per second over the last `windowMs`, counting only app requests (assets excluded).
 * `traces` is newest first (the store's order), so the scan stops at the first one outside the window.
 */
export function requestRate(
  traces: readonly Pick<TraceSummary, "startedAt" | "kind">[],
  now: number,
  windowMs = RATE_WINDOW_MS,
): number {
  const from = now - windowMs;
  let n = 0;
  for (const t of traces) {
    if (t.startedAt < from) break;
    if (t.startedAt > now || t.kind === "asset") continue;
    n++;
  }
  return n / (windowMs / 1000);
}

/** "4/s", "0.3/s", "" when idle. */
export function fmtRate(perSec: number): string {
  if (!(perSec > 0)) return "";
  if (perSec >= 10) return `${Math.round(perSec)}/s`;
  return `${perSec.toFixed(1).replace(/\.0$/, "")}/s`;
}

export function errorKindLabel(kind: ProcessErrorRecord["kind"]): string {
  return kind === "uncaughtException" ? "Uncaught exception" : "Unhandled rejection";
}

/** Errors newer than `seenId`. */
export function unseenErrors(errors: readonly ProcessErrorRecord[], seenId: number): number {
  let n = 0;
  for (const e of errors) if (e.id > seenId) n++;
  return n;
}

/* ------------------------------------------------------------------ live state */

export const healthState = signal<HealthState>(EMPTY_HEALTH);
/** Highest process-error id the user has looked at (opening the errors panel marks all seen). */
export const seenErrorId = signal(0);
/** The process-errors panel in the status slot. */
export const errorsPanelOpen = signal(false);

export const processErrors = computed(() => healthState.value.errors);
export const processErrorTotal = computed(() => {
  const c = healthState.value.errorCounts;
  return c.uncaughtException + c.unhandledRejection;
});
export const unseenProcessErrors = computed(() => unseenErrors(healthState.value.errors, seenErrorId.value));

export function markErrorsSeen(): void {
  const errs = healthState.peek().errors;
  const last = errs[errs.length - 1];
  if (last && last.id > seenErrorId.peek()) seenErrorId.value = last.id;
}

export function openErrorsPanel(): void {
  errorsPanelOpen.value = true;
  markErrorsSeen();
}

export function closeErrorsPanel(): void {
  errorsPanelOpen.value = false;
}

let loadSeq = 0;

async function loadSnapshot(): Promise<void> {
  const seq = ++loadSeq;
  try {
    const snap = await api.health();
    if (seq !== loadSeq) return;
    healthState.value = applySnapshot(healthState.peek(), snap);
  } catch (err) {
    if (seq !== loadSeq) return;
    // An older core has no endpoint: hide the strip. Anything else (core restarting) is transient;
    // the next tick or reconnect fills it in.
    if (err instanceof HoplensApiError && err.status === 404 && healthState.peek().availability !== "available")
      healthState.value = { ...healthState.peek(), availability: "missing" };
  }
}

let users = 0;
let untap: (() => void) | null = null;

/**
 * Start following process health. Reference-counted, so the status slot can call it from a
 * `useEffect`; the returned function releases it.
 */
export function initHealth(): () => void {
  users++;
  if (users === 1) {
    untap = tapLive((ev) => {
      if (ev.type === "health") healthState.value = applyTick(healthState.peek(), ev.tick);
      // After a reconnect: anything recorded while we were away.
      else if (ev.type === "hello" && healthState.peek().availability !== "unknown") void loadSnapshot();
    });
    void loadSnapshot();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
    if (users === 0) {
      untap?.();
      untap = null;
      loadSeq++;
    }
  };
}
