import { EventEmitter } from "node:events";
import { type IntervalHistogram, PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";

/*
 * Process health for the dev server (plan WP6): event-loop delay, memory, GC and process-level
 * errors. Nothing here runs on the request path; the only standing timer is one unref'd sampler.
 *
 * Process errors are observed without changing what the process does with them:
 *   - `uncaughtExceptionMonitor` fires before Node's default handling and cannot swallow anything
 *     (an uncaught exception still crashes, a user `uncaughtException` handler still runs).
 *   - `unhandledRejection` is different: merely having a listener stops Node's default
 *     "throw -> crash" for unhandled rejections. So we only listen while some OTHER listener exists
 *     (the process already doesn't crash on them), and re-check on every sampler tick. Without one,
 *     a rejection becomes an uncaught exception and `uncaughtExceptionMonitor` sees it with origin
 *     "unhandledRejection". If our listener is found alone when a rejection arrives (the other one
 *     went away between ticks), it detaches and re-raises so the default outcome still happens.
 */

export interface HealthSample {
  /** Epoch ms when the sample closed. */
  t: number;
  /** Event-loop delay over the sample window, in ms. */
  loopP50: number;
  loopP99: number;
  loopMax: number;
  loopMean: number;
  /** Bytes. */
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  /** GC pauses that ended in this window. */
  gcCount: number;
  gcMs: number;
}

export type ProcessErrorKind = "uncaughtException" | "unhandledRejection";

export interface ProcessErrorRecord {
  id: number;
  t: number;
  kind: ProcessErrorKind;
  name: string;
  message: string;
  stack?: string;
}

export interface GcTotals {
  count: number;
  totalMs: number;
  maxMs: number;
  /** "minor" | "major" | "incremental" | "weakcb" | "other" -> count. */
  byKind: Record<string, number>;
}

export interface HealthSnapshot {
  startedAt: number;
  /** Sampler period in ms; `samples` is a ring covering ring x sampleMs. */
  sampleMs: number;
  /** False when listeners are not attached (production, or stopped). */
  active: boolean;
  current: HealthSample | null;
  samples: HealthSample[];
  gc: GcTotals;
  errors: ProcessErrorRecord[];
  errorCounts: { uncaughtException: number; unhandledRejection: number };
  /** Whether our unhandledRejection listener is currently attached (another listener exists). */
  watchingRejections: boolean;
}

/** Small payload for the SSE `health` event. */
export interface HealthTick {
  current: HealthSample | null;
  errorCounts: HealthSnapshot["errorCounts"];
  /** Errors recorded since the previous tick sent to this client. */
  newErrors: ProcessErrorRecord[];
}

export interface HealthOptions {
  /** Attach process listeners / observers. Default: dev only (or HOPLENS_FORCE=1). */
  enabled?: boolean;
  /** Sampler period. Default 2000ms. */
  sampleMs?: number;
  /** Samples kept. Default 150 (5 minutes at 2s). */
  ring?: number;
  /** Process errors kept. Default 50. */
  errorRing?: number;
  /** monitorEventLoopDelay resolution. Default 20ms. */
  resolutionMs?: number;
}

const NS_PER_MS = 1e6;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;

const GC_KINDS: Record<number, string> = { 1: "minor", 2: "major", 4: "incremental", 8: "weakcb" };

function defaultEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.HOPLENS_FORCE === "1";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function nsToMs(ns: number): number {
  return Number.isFinite(ns) ? round(ns / NS_PER_MS) : 0;
}

/** Windows timers fire on a 15.625ms system tick. */
const WIN_TICK_MS = 15.625;

/**
 * monitorEventLoopDelay records the whole timer interval, resolution included: an idle loop reads
 * ~20ms at resolution 20 on Linux and ~31ms on Windows, where the interval rounds up to the 15.6ms
 * system tick. The floor to subtract is the lowest per-window p50 seen so far (an idle window's p50 is
 * that interval), clamped to [resolution, the platform's interval + 1ms], so a busy first window can't
 * make it swallow real delay. Pure; ms.
 */
export function loopFloorMs(
  prevFloor: number | undefined,
  windowP50: number,
  resolutionMs: number,
  platform: string = process.platform,
): number {
  const interval = platform === "win32" ? Math.ceil(resolutionMs / WIN_TICK_MS) * WIN_TICK_MS : resolutionMs;
  const lowest = Math.min(prevFloor ?? Number.POSITIVE_INFINITY, windowP50);
  return Math.max(resolutionMs, Math.min(interval + 1, lowest));
}

/** Node's --unhandled-rejections mode, as far as we can tell from flags. Default is "throw". */
function rejectionMode(): string {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
  for (const f of flags) {
    const m = /^--unhandled-rejections=(\S+)$/.exec(f);
    if (m?.[1]) return m[1];
  }
  return "throw";
}

function describe(kind: ProcessErrorKind, err: unknown, id: number): ProcessErrorRecord {
  let name = "Error";
  let message: string;
  let stack: string | undefined;
  if (err instanceof Error) {
    name = err.name || "Error";
    message = err.message;
    stack = typeof err.stack === "string" ? err.stack.slice(0, MAX_STACK) : undefined;
  } else {
    name = err === null ? "null" : typeof err;
    try {
      message = typeof err === "string" ? err : (JSON.stringify(err) ?? String(err));
    } catch {
      message = String(err);
    }
  }
  return { id, t: Date.now(), kind, name, message: String(message).slice(0, MAX_MESSAGE), stack };
}

export class HealthMonitor extends EventEmitter {
  readonly sampleMs: number;
  readonly enabled: boolean;
  private readonly ringSize: number;
  private readonly errorRingSize: number;
  private readonly resolutionMs: number;

  private startedAt = 0;
  private histogram?: IntervalHistogram;
  /** The timer interval the histogram includes, in ms (loopFloorMs); undefined before the first window. */
  private loopFloor?: number;
  private gcObserver?: PerformanceObserver;
  private timer?: NodeJS.Timeout;
  private running = false;
  private rejectionAttached = false;
  private reraised: unknown = undefined;

  private samples: HealthSample[] = [];
  private errors: ProcessErrorRecord[] = [];
  private errorSeq = 0;
  private counts = { uncaughtException: 0, unhandledRejection: 0 };
  private gcTotals: GcTotals = { count: 0, totalMs: 0, maxMs: 0, byKind: {} };
  private gcWindow = { count: 0, ms: 0 };

  constructor(opts: HealthOptions = {}) {
    super();
    this.enabled = opts.enabled ?? defaultEnabled();
    this.sampleMs = Math.max(50, opts.sampleMs ?? 2000);
    this.ringSize = Math.max(1, opts.ring ?? 150);
    this.errorRingSize = Math.max(1, opts.errorRing ?? 50);
    this.resolutionMs = Math.max(1, opts.resolutionMs ?? 20);
    // SSE clients come and go; never warn about many of them.
    this.setMaxListeners(0);
  }

  get active(): boolean {
    return this.running;
  }

  start(): this {
    if (this.running || !this.enabled) return this;
    this.running = true;
    this.startedAt = Date.now();
    try {
      this.histogram = monitorEventLoopDelay({ resolution: this.resolutionMs });
      this.histogram.enable();
    } catch {
      this.histogram = undefined;
    }
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.onGc(e);
      });
      this.gcObserver.observe({ entryTypes: ["gc"] });
    } catch {
      this.gcObserver = undefined;
    }
    process.on("uncaughtExceptionMonitor", this.onUncaught);
    this.syncRejectionListener();
    this.timer = setInterval(() => this.tick(), this.sampleMs);
    this.timer.unref();
    return this;
  }

  /** Detach every listener, observer and timer. Collected data stays readable. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.histogram?.disable();
    this.histogram = undefined;
    this.gcObserver?.disconnect();
    this.gcObserver = undefined;
    process.off("uncaughtExceptionMonitor", this.onUncaught);
    if (this.rejectionAttached) process.off("unhandledRejection", this.onRejection);
    this.rejectionAttached = false;
  }

  /** Close the current window now (the sampler calls this; tests call it directly). */
  sample(): HealthSample {
    const h = this.histogram;
    const mem = process.memoryUsage();
    const has = !!h && h.count > 0;
    if (has) this.loopFloor = loopFloorMs(this.loopFloor, nsToMs(h.percentile(50)), this.resolutionMs);
    // Delay beyond the sampler's own interval (see loopFloorMs).
    const delay = (ns: number) => (has ? round(Math.max(0, nsToMs(ns) - (this.loopFloor ?? this.resolutionMs))) : 0);
    const s: HealthSample = {
      t: Date.now(),
      loopP50: has ? delay(h.percentile(50)) : 0,
      loopP99: has ? delay(h.percentile(99)) : 0,
      loopMax: has ? delay(h.max) : 0,
      loopMean: has ? delay(h.mean) : 0,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      gcCount: this.gcWindow.count,
      gcMs: round(this.gcWindow.ms),
    };
    h?.reset();
    this.gcWindow = { count: 0, ms: 0 };
    this.samples.push(s);
    if (this.samples.length > this.ringSize) this.samples.splice(0, this.samples.length - this.ringSize);
    return s;
  }

  snapshot(): HealthSnapshot {
    return {
      startedAt: this.startedAt,
      sampleMs: this.sampleMs,
      active: this.running,
      current: this.samples[this.samples.length - 1] ?? null,
      samples: this.samples.slice(),
      gc: { ...this.gcTotals, totalMs: round(this.gcTotals.totalMs), byKind: { ...this.gcTotals.byKind } },
      errors: this.errors.slice(),
      errorCounts: { ...this.counts },
      watchingRejections: this.rejectionAttached,
    };
  }

  /** Errors with id > `afterId`, oldest first. */
  errorsSince(afterId: number): ProcessErrorRecord[] {
    return this.errors.filter((e) => e.id > afterId);
  }

  get lastErrorId(): number {
    return this.errorSeq;
  }

  private tick(): void {
    try {
      this.syncRejectionListener();
      const s = this.sample();
      this.emit("sample", s);
    } catch {
      // A health sampler must never surface as an uncaught error from our own timer.
    }
  }

  /** Listen to unhandledRejection only while some other listener exists (see file header). */
  private syncRejectionListener(): void {
    const others = process.listenerCount("unhandledRejection") - (this.rejectionAttached ? 1 : 0);
    if (others > 0 && !this.rejectionAttached) {
      process.on("unhandledRejection", this.onRejection);
      this.rejectionAttached = true;
    } else if (others <= 0 && this.rejectionAttached) {
      process.off("unhandledRejection", this.onRejection);
      this.rejectionAttached = false;
    }
  }

  private record(kind: ProcessErrorKind, err: unknown): void {
    try {
      const rec = describe(kind, err, ++this.errorSeq);
      this.counts[kind]++;
      this.errors.push(rec);
      if (this.errors.length > this.errorRingSize) this.errors.splice(0, this.errors.length - this.errorRingSize);
      this.emit("processError", rec);
    } catch {
      // Recording is best effort; never interfere with the error itself.
    }
  }

  private readonly onUncaught = (err: unknown, origin: string): void => {
    if (this.reraised !== undefined && err === this.reraised) {
      this.reraised = undefined;
      return;
    }
    this.record(origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException", err);
  };

  private readonly onRejection = (reason: unknown): void => {
    this.record("unhandledRejection", reason);
    if (process.listenerCount("unhandledRejection") > 1) return;
    // We are the only listener: without us Node would have applied its default. Restore it.
    process.off("unhandledRejection", this.onRejection);
    this.rejectionAttached = false;
    const mode = rejectionMode();
    if (mode === "throw" || mode === "strict") {
      // Already recorded as a rejection; the monitor will see the re-raise and must not count it twice.
      this.reraised = reason;
      throw reason;
    }
    if (mode === "warn" || mode === "warn-with-error-code") {
      process.emitWarning(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
      if (mode === "warn-with-error-code") process.exitCode = 1;
    }
  };

  private onGc(e: { duration: number; detail?: unknown }): void {
    const ms = e.duration;
    const kindNum = (e.detail as { kind?: number } | undefined)?.kind;
    const kind = (kindNum !== undefined && GC_KINDS[kindNum]) || "other";
    this.gcTotals.count++;
    this.gcTotals.totalMs += ms;
    if (ms > this.gcTotals.maxMs) this.gcTotals.maxMs = round(ms);
    this.gcTotals.byKind[kind] = (this.gcTotals.byKind[kind] ?? 0) + 1;
    this.gcWindow.count++;
    this.gcWindow.ms += ms;
  }
}
