import { mapStack } from "./sourcemap";
import type { SourceLocation } from "./types";

/*
 * Call sites of wrapped (traced) functions: where the caller invoked the wrapper, e.g. the loop line
 * `for (const p of posts) await getUser(p.id)`, not getUser's declaration. Used as an N+1 finding's
 * location when the repeats go through a per-item function.
 *
 * Request-path cost: an N+1 needs the same function called repeatedly under one parent, so only the
 * 2nd call of a wrapped function under a given parent span captures anything (`shouldCapture`), and
 * that capture keeps a few structured V8 frames (`Error.captureStackTrace` with a small limit, a few
 * us): V8 formats `.stack` lazily, on first read. Only an N+1 finding reads it, after the response
 * finished, and the mapped result is cached per span. Every other call costs a WeakMap + Map lookup.
 */

/** Frames kept: the caller, plus a few to skip helpers that aren't project files (e.g. `step()`). */
const FRAMES = 6;

interface Pending {
  holder: { stack?: string };
  root: string;
  resolved?: SourceLocation | null;
}

/** Structured frames of whoever called `fn` (frames of `fn` and above are omitted). */
export function captureCallSite(fn: (...args: any[]) => any): { stack?: string } | undefined {
  const E = Error as ErrorConstructor & { stackTraceLimit: number };
  if (typeof E.captureStackTrace !== "function") return undefined;
  const prev = E.stackTraceLimit;
  try {
    E.stackTraceLimit = FRAMES;
    const holder: { stack?: string } = {};
    E.captureStackTrace(holder, fn);
    return holder;
  } catch {
    return undefined;
  } finally {
    E.stackTraceLimit = prev;
  }
}

const calls = new WeakMap<object, Map<unknown, number>>();

/**
 * True on the 2nd call of `fn` under `parent` (a span, or the trace when no span is active): the
 * first repeat, where an N+1 loop shows itself. Later calls are not counted.
 */
export function shouldCapture(parent: object, fn: unknown): boolean {
  let m = calls.get(parent);
  if (!m) calls.set(parent, (m = new Map()));
  const n = m.get(fn) ?? 0;
  if (n >= 2) return false;
  m.set(fn, n + 1);
  return n === 1;
}

// Keyed by the OTel span object while it runs, then by our SpanRecord. Both weak: nothing outlives the trace.
const bySpan = new WeakMap<object, { stack?: string }>();
const byRecord = new WeakMap<object, Pending>();

export function noteSpanCallSite(span: object, holder: { stack?: string } | undefined): void {
  if (holder) bySpan.set(span, holder);
}

/** Moves a running span's captured frames onto its record (at span end). */
export function moveCallSite(span: object, rec: object, root: string): void {
  const holder = bySpan.get(span);
  if (!holder) return;
  bySpan.delete(span);
  byRecord.set(rec, { holder, root });
}

/** For tests and adapters: attach frames to a record directly. */
export function setRecordCallSite(rec: object, holder: { stack?: string }, root: string): void {
  byRecord.set(rec, { holder, root });
}

/** The call site of the first record in `recs` that has one (an N+1 group's wrappers). */
export function firstCallSite(recs: readonly object[]): SourceLocation | undefined {
  for (const r of recs) {
    if (!byRecord.has(r)) continue;
    const loc = callSiteOf(r);
    if (loc) return loc;
  }
  return undefined;
}

/**
 * The first project frame that called the span's wrapper, source-mapped; undefined when none was
 * captured (no trace, a reloaded trace) or no frame is in the project. Resolved once per span.
 */
export function callSiteOf(rec: object | undefined): SourceLocation | undefined {
  if (!rec) return undefined;
  const p = byRecord.get(rec);
  if (!p) return undefined;
  if (p.resolved === undefined) {
    try {
      const stack = p.holder.stack;
      p.resolved = (typeof stack === "string" ? mapStack(stack, p.root).location : undefined) ?? null;
    } catch {
      p.resolved = null;
    }
  }
  return p.resolved ?? undefined;
}
