import { EventEmitter } from "node:events";
import type { TraceRecord, TraceSummary } from "./types";

export interface Internal {
  // Unredacted request data kept server-side so "Edit and resend" works; never sent to the UI.
  rawHeaders: Record<string, string>;
  rawBody?: string;
}

type StoreEvent = "start" | "done" | "clear";

/**
 * Ring buffer of recent traces plus a typed event stream the UI subscribes to via SSE.
 *
 * ```ts
 * const store = new TraceStore(300);
 * store.on("done", (t) => console.log(t.id, t.status));
 * ```
 */
export class TraceStore extends EventEmitter {
  private readonly traces = new Map<string, TraceRecord>();
  private readonly internals = new WeakMap<TraceRecord, Internal>();

  constructor(private readonly max: number) {
    super();
    this.setMaxListeners(100);
  }

  override on(event: "start" | "done", listener: (trace: TraceRecord) => void): this;
  override on(event: "clear", listener: () => void): this;
  override on(event: StoreEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override off(event: "start" | "done", listener: (trace: TraceRecord) => void): this;
  override off(event: "clear", listener: () => void): this;
  override off(event: StoreEvent, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  add(t: TraceRecord, internal: Internal): void {
    this.traces.set(t.id, t);
    this.internals.set(t, internal);
    while (this.traces.size > this.max) {
      const oldest = this.traces.keys().next().value;
      if (oldest !== undefined) this.traces.delete(oldest);
    }
    this.emit("start", t);
  }

  finish(t: TraceRecord): void {
    t.done = true;
    this.emit("done", t);
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

  clear(): void {
    this.traces.clear();
    this.emit("clear");
  }
}

export function summarize(t: TraceRecord): TraceSummary {
  return {
    id: t.id,
    runId: t.runId,
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
    hops: t.spans.filter((s) => s.kind !== "router").length,
  };
}
