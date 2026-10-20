import { EventEmitter } from "node:events";
import type { FindingSummary, TraceRecord, TraceSummary } from "./types";

export interface Internal {
  // Unredacted request data kept server-side so "Edit and resend" works; never sent to the UI.
  rawHeaders: Record<string, string>;
  rawBody?: string;
}

type StoreEvent = "start" | "done" | "update" | "clear" | "internal";

/** Minimum gap between two `update` events for the same trace (ms). */
export const UPDATE_THROTTLE_MS = 250;

/**
 * Most traces pinned at once per kind (automatic Compare pins; manual `p` pins). Pinning past this
 * releases the oldest pin of the same kind.
 */
export const MAX_PINS = 20;

/** Drop the oldest entries of an insertion-ordered set until it holds `max`. */
function trim(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/**
 * Ring buffer of recent traces plus a typed event stream the UI subscribes to via SSE.
 *
 * Events: `start` (trace began), `done` (finished, facts + findings computed), `update` (a finished
 * trace changed afterwards, e.g. late spans landed; throttled to one per trace per
 * UPDATE_THROTTLE_MS, trailing edge included so the last change always goes out), `clear`.
 *
 * ```ts
 * const store = new TraceStore(300);
 * store.on("done", (t) => console.log(t.id, t.status));
 * ```
 */
export class TraceStore extends EventEmitter {
  private readonly traces = new Map<string, TraceRecord>();
  private readonly internals = new WeakMap<TraceRecord, Internal>();
  /** trace id -> when its last `update` went out. Entries leave with the trace. */
  private readonly lastUpdate = new Map<string, number>();
  private readonly pendingUpdate = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Pinned trace ids, oldest pin first, in two disjoint sets of at most `maxPins` each: automatic pins
   * (Compare pins both sides) and manual ones (the `p` key, "kept past rotation"). Automatic pins only
   * ever release other automatic pins, so opening compares can't drop a pin the user made. Pinned
   * traces are skipped by eviction and don't count toward `max`, so at most `max + 2 * maxPins` traces
   * are retained. Both are subsets of `traces`: only a retained trace can be pinned, and pinned traces
   * leave only through clear().
   */
  private readonly pins = new Set<string>();
  private readonly manualPins = new Set<string>();
  /**
   * Requests currently running: added in add(), removed in finish(), whether or not the trace is
   * still retained (a request evicted or cleared while in flight is still running). The request
   * path's quiet gate reads it (path/capture.ts).
   */
  private readonly running = new Set<TraceRecord>();

  constructor(
    private readonly max: number,
    private readonly throttleMs = UPDATE_THROTTLE_MS,
    private readonly maxPins = MAX_PINS,
  ) {
    super();
    this.setMaxListeners(100);
  }

  override on(event: "start" | "done" | "update", listener: (trace: TraceRecord) => void): this;
  override on(event: "clear", listener: () => void): this;
  override on(event: "internal", listener: (what: string) => void): this;
  override on(event: StoreEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override off(event: "start" | "done" | "update", listener: (trace: TraceRecord) => void): this;
  override off(event: "clear", listener: () => void): this;
  override off(event: "internal", listener: (what: string) => void): this;
  override off(event: StoreEvent, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  add(t: TraceRecord, internal: Internal): void {
    if (!t.done) this.running.add(t);
    this.traces.set(t.id, t);
    this.internals.set(t, internal);
    while (this.traces.size - this.pins.size - this.manualPins.size > this.max) {
      const oldest = this.oldestUnpinned();
      if (oldest === undefined) break;
      this.traces.delete(oldest);
      this.forgetUpdates(oldest);
    }
    this.emit("start", t);
  }

  finish(t: TraceRecord): void {
    t.done = true;
    this.running.delete(t);
    // Cleared or evicted while in flight: announcing it would re-add a row the UI can't open.
    if (this.traces.get(t.id) !== t) return;
    this.emit("done", t);
  }

  /**
   * A finished trace changed (late spans). Emits `update` at most once per `throttleMs` per trace:
   * immediately when the last one is old enough, otherwise once at the end of the window. Ignored for
   * in-flight, cleared or evicted traces.
   */
  update(t: TraceRecord): void {
    if (!t.done || this.traces.get(t.id) !== t || this.pendingUpdate.has(t.id)) return;
    const fire = () => {
      this.pendingUpdate.delete(t.id);
      if (this.traces.get(t.id) !== t) return;
      this.lastUpdate.set(t.id, Date.now());
      this.emit("update", t);
    };
    const last = this.lastUpdate.get(t.id);
    const wait = last === undefined ? 0 : last + this.throttleMs - Date.now();
    if (wait <= 0) {
      fire();
      return;
    }
    const timer = setTimeout(fire, wait);
    timer.unref?.();
    this.pendingUpdate.set(t.id, timer);
  }

  /**
   * Keep a retained trace past ring rotation. Automatic pins (Compare pins both sides so its view and
   * deep link survive live traffic) are capped at `maxPins`: past that the oldest automatic pin is
   * released. `manual` pins (the user's `p`) have their own cap and are never released by automatic
   * ones; an automatic pin of a manually pinned trace leaves it manual. Re-pinning refreshes the
   * place. False when the trace is not retained.
   */
  pin(id: string, opts: { manual?: boolean } = {}): boolean {
    if (!this.traces.has(id)) return false;
    if (opts.manual) {
      this.pins.delete(id);
      this.manualPins.delete(id);
      this.manualPins.add(id);
      trim(this.manualPins, this.maxPins);
    } else if (!this.manualPins.has(id)) {
      this.pins.delete(id);
      this.pins.add(id);
      trim(this.pins, this.maxPins);
    }
    return true;
  }

  /** Release a pin (manual or automatic). The trace stays until normal rotation evicts it. */
  unpin(id: string): boolean {
    const a = this.pins.delete(id);
    const m = this.manualPins.delete(id);
    return a || m;
  }

  isPinned(id: string): boolean {
    return this.pins.has(id) || this.manualPins.has(id);
  }

  /** Pinned ids (automatic, then manual), oldest pin first within each. */
  pinned(): string[] {
    return [...this.pins, ...this.manualPins];
  }

  /** Manually pinned ids (the `p` key), oldest first. */
  manuallyPinned(): string[] {
    return Array.from(this.manualPins);
  }

  private oldestUnpinned(): string | undefined {
    for (const id of this.traces.keys()) if (!this.isPinned(id)) return id;
    return undefined;
  }

  private forgetUpdates(id: string): void {
    this.lastUpdate.delete(id);
    const timer = this.pendingUpdate.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingUpdate.delete(id);
    }
  }

  /** How many requests are running right now (started, not finished). */
  inflight(): number {
    return this.running.size;
  }

  /** The running requests, oldest first (for a "2 requests in flight" message). */
  inflightTraces(): TraceRecord[] {
    return Array.from(this.running);
  }

  /**
   * A request the HTTP hook passed through untraced (the framework's internal prefixes: Next's
   * /_next/*). Only the request path's capture window listens (onInternal); without a listener this
   * is one listenerCount read.
   */
  noteInternal(method: string | undefined, url: string): void {
    if (this.listenerCount("internal") === 0) return;
    const path = url.replace(/[?#].*$/, "");
    this.emit("internal", `${method ?? "GET"} ${path}`);
  }

  /** Listen to noteInternal (`METHOD path`); the answer unsubscribes. */
  onInternal(listener: (what: string) => void): () => void {
    this.on("internal", listener);
    return () => {
      this.off("internal", listener);
    };
  }

  get(id: string): TraceRecord | undefined {
    return this.traces.get(id);
  }

  internal(t: TraceRecord): Internal | undefined {
    return this.internals.get(t);
  }

  byRun(runId: string): TraceRecord | undefined {
    for (const t of this.traces.values()) if (t.runId === runId) return t;
    return undefined;
  }

  list(): TraceSummary[] {
    return Array.from(this.traces.values()).reverse().map(summarize);
  }

  /** Retained full records, newest first. */
  records(): TraceRecord[] {
    return Array.from(this.traces.values()).reverse();
  }

  clear(): void {
    this.traces.clear();
    this.pins.clear();
    this.manualPins.clear();
    for (const timer of this.pendingUpdate.values()) clearTimeout(timer);
    this.pendingUpdate.clear();
    this.lastUpdate.clear();
    this.emit("clear");
  }
}

export function summarize(t: TraceRecord): TraceSummary {
  return {
    id: t.id,
    runId: t.runId,
    batchId: t.batchId,
    startedAt: t.startedAt,
    duration: t.duration,
    done: t.done,
    method: t.method,
    path: t.path,
    url: t.url,
    route: t.route,
    kind: t.kind,
    status: t.status,
    error: t.error?.message,
    hops: t.spans.filter((s) => s.kind !== "router" && s.kind !== "compile").length,
    facts: t.facts,
    findings: t.findings?.map((f) => {
      const out: FindingSummary = { rule: f.rule, severity: f.severity, title: f.title, fingerprint: f.fingerprint };
      if (f.fn !== undefined) out.fn = f.fn;
      if (f.location !== undefined) out.location = f.location;
      if (f.count !== undefined) out.count = f.count;
      if (f.estSavedMs !== undefined) out.estSavedMs = f.estSavedMs;
      return out;
    }),
    ...(t.pathTrace ? { pathTrace: t.pathTrace } : {}),
  };
}
