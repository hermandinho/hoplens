// Guards for the analysis hot paths that were rewritten for speed (sweep's event ordering, shapeOf's
// caching): each is checked against a straightforward reference implementation on random traces.
import { describe, expect, test } from "vitest";
import { bucketOf, computeFacts, isMarker, isRedis, normalizeSql, normalizeUrl, timeBudget } from "../src/facts";
import { analyze } from "../src/insights";
import { methodOf, shapeOf, statementOf, urlOf } from "../src/insights/context";
import type { SpanRecord, TimeBucket } from "../src/types";
import { makeTrace, span } from "./helpers";

// Deterministic PRNG so a failure reproduces.
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

const KINDS: SpanRecord["kind"][] = ["request", "handler", "function", "db", "fetch", "compile", "router", "proxy"];

/** Random trace: coarse integer times so exact start / end ties (the tie-break paths) are common. */
function randomSpans(seed: number, n: number, duration: number): SpanRecord[] {
  const r = rng(seed);
  const spans: SpanRecord[] = [span({ kind: "request", start: 0, end: duration })];
  for (let i = 1; i < n; i++) {
    const parent = spans[Math.floor(r() * spans.length)]!;
    const kind = KINDS[1 + Math.floor(r() * (KINDS.length - 1))]!;
    const start = Math.floor(r() * 12) * 5 - 5; // some before 0
    const len = Math.floor(r() * 6) * 5; // some zero-length markers
    const attrs: SpanRecord["attrs"] = {};
    if (kind === "db") {
      if (r() < 0.5) attrs["db.system"] = r() < 0.5 ? "redis" : "REDIS";
      if (r() < 0.9) attrs["db.statement"] = `SELECT * FROM t${Math.floor(r() * 3)} WHERE id = ${Math.floor(r() * 4)}`;
    }
    if (kind === "fetch" && r() < 0.9) {
      attrs[r() < 0.5 ? "url.full" : "http.url"] = `https://api.example.com/items/${Math.floor(r() * 4)}?q=${i}`;
      if (r() < 0.5) attrs["http.method"] = r() < 0.5 ? "post" : "GET";
    }
    spans.push(
      span({
        kind,
        name: kind === "db" && r() < 0.2 ? `prisma:findMany${Math.floor(r() * 2)}` : `${kind}${Math.floor(r() * 3)}`,
        parentId: r() < 0.9 ? parent.id : `gone${i}`,
        start,
        end: start + len + (r() < 0.2 ? duration : 0), // some run past the end
        attrs,
      }),
    );
  }
  return spans;
}

/** The original sweep: one event list sorted by (instant, closes before opens). */
function referenceBudget(spans: SpanRecord[], duration: number, presort = true): Record<TimeBucket, number> {
  const time: Record<TimeBucket, number> = { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 };
  if (!(duration > 0)) return time;
  const sorted = presort ? [...spans].sort((a, b) => a.start - b.start) : spans;
  const timed = sorted.filter((s) => !isMarker(s) && s.end > 0 && s.start < duration);
  if (timed.length === 0) {
    time.idle = duration;
    return time;
  }
  let a = Number.POSITIVE_INFINITY;
  let b = Number.NEGATIVE_INFINITY;
  for (const s of timed)
    if (s.kind === "compile") {
      a = Math.min(a, s.start);
      b = Math.max(b, s.end);
    }
  let win: [number, number] | undefined;
  if (b > a) {
    let code = Number.POSITIVE_INFINITY;
    for (const s of timed)
      if ((s.kind === "handler" || s.kind === "function" || s.kind === "proxy") && s.start >= a && s.start < code)
        code = s.start;
    if (code < b) b = code;
    if (b > a) win = [a, b];
  }
  const byId = new Map(timed.map((s) => [s.id, s]));
  const depth = (s: SpanRecord) => {
    let d = 0;
    for (let p = s.parentId ? byId.get(s.parentId) : undefined; p && d < 256; d++)
      p = p.parentId ? byId.get(p.parentId) : undefined;
    return d;
  };
  const events: Array<{ at: number; open: boolean; s: SpanRecord }> = [];
  for (const s of timed) {
    events.push({ at: Math.max(0, s.start), open: true, s });
    events.push({ at: Math.min(duration, s.end), open: false, s });
  }
  events.sort((x, y) => x.at - y.at || (x.open === y.open ? 0 : x.open ? 1 : -1));
  const active: SpanRecord[] = [];
  let cursor = 0;
  const flush = (to: number) => {
    if (to <= cursor) return;
    let best: SpanRecord | undefined;
    for (const s of active)
      if (
        !best ||
        s.start > best.start ||
        (s.start === best.start && (s.end < best.end || (s.end === best.end && depth(s) > depth(best))))
      )
        best = s;
    const bucket = best ? bucketOf(best) : "idle";
    const g = bucket === "idle" && win ? Math.max(0, Math.min(to, win[1]) - Math.max(cursor, win[0])) : 0;
    if (g >= 50) {
      time.compile += g;
      time.idle += to - cursor - g;
    } else time[bucket] += to - cursor;
    cursor = to;
  };
  for (const ev of events) {
    flush(ev.at);
    if (ev.open) active.push(ev.s);
    else active.splice(active.indexOf(ev.s), 1);
  }
  flush(duration);
  return time;
}

/** The original shapeOf, computed fresh every time. */
function referenceShape(s: SpanRecord): string | undefined {
  if (s.kind === "db") {
    const q = statementOf(s);
    if (q) return `${isRedis(s) ? "redis" : "db"}:${normalizeSql(q)}`;
    return s.name.startsWith("prisma:") ? `db:${s.name}` : undefined;
  }
  if (s.kind === "fetch") {
    const u = urlOf(s);
    return u ? `fetch:${methodOf(s)} ${normalizeUrl(u)}` : undefined;
  }
  return undefined;
}

describe("hot-path rewrites match their reference", () => {
  test("timeBudget equals the single-sorted-event-list sweep on random traces", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const duration = 20 + (seed % 7) * 10;
      const spans = randomSpans(seed, 3 + (seed % 40), duration);
      const sorted = [...spans].sort((a, b) => a.start - b.start);
      expect(timeBudget(sorted, duration), `seed ${seed}`).toEqual(referenceBudget(spans, duration));
      // Server-Timing calls it with spans in insertion order, unsorted.
      expect(timeBudget(spans, duration), `seed ${seed} unsorted`).toEqual(referenceBudget(spans, duration, false));
    }
  });

  test("computeFacts time buckets match the reference on unsorted input", () => {
    for (let seed = 401; seed <= 500; seed++) {
      const spans = randomSpans(seed, 30, 60).reverse();
      const ref = referenceBudget(spans, 60);
      const facts = computeFacts(makeTrace(spans, { duration: 60 }));
      for (const k of Object.keys(ref) as TimeBucket[])
        expect(facts.time[k], `seed ${seed} ${k}`).toBe(Math.round(ref[k] * 100) / 100);
    }
  });

  test("shapeOf equals a fresh computation, repeatedly and across spans", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const spans = randomSpans(seed, 30, 50);
      for (let pass = 0; pass < 3; pass++)
        for (const s of spans) expect(shapeOf(s), `seed ${seed}`).toBe(referenceShape(s));
    }
  });

  test("analyze is deterministic across fresh copies of one trace", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const a = randomSpans(seed, 40, 80);
      const b = a.map((s) => ({ ...s, attrs: { ...s.attrs } }));
      const ta = makeTrace(a, { duration: 80 });
      const tb = makeTrace(b, { duration: 80 });
      expect(analyze(tb, computeFacts(tb))).toEqual(analyze(ta, computeFacts(ta)));
    }
  });
});
