import { describe, expect, test } from "vitest";
import {
  MAX_ANALYZED_SPANS,
  TIME_BUCKETS,
  bucketOf,
  computeFacts,
  foldNestedFetches,
  normalizeSql,
  normalizeUrl,
  selfTimes,
  timeBudget,
  unionLength,
} from "../src/facts";
import { db, fetchSpan, makeTrace, skeleton, span } from "./helpers";

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe("unionLength", () => {
  test("disjoint intervals add up", () => {
    expect(
      unionLength([
        [0, 10],
        [20, 25],
      ]),
    ).toBe(15);
  });
  test("overlapping and nested intervals are counted once", () => {
    expect(
      unionLength([
        [0, 10],
        [5, 15],
        [6, 7],
        [30, 40],
      ]),
    ).toBe(25);
  });
  test("unsorted input, abutting intervals, empty intervals", () => {
    expect(
      unionLength([
        [10, 20],
        [0, 10],
        [5, 5],
      ]),
    ).toBe(20);
    expect(unionLength([])).toBe(0);
  });
});

describe("timeBudget (interval union self time)", () => {
  test("buckets sum to the duration and nested time goes to the innermost span", () => {
    const { root, handler, fn } = skeleton(100);
    const q = db(fn.id, 10, 40, "SELECT 1");
    const time = timeBudget([root, handler, fn, q], 100);
    expect(sum(time)).toBeCloseTo(100, 5);
    expect(time.db).toBeCloseTo(30);
    // fn self (2..98 minus 10..40) + handler self (1..2, 98..99)
    expect(time.fn).toBeCloseTo(96 - 30 + 2);
    // root self = 0..1 and 99..100: covered by no child span → idle
    expect(time.idle).toBeCloseTo(2);
  });

  test("overlapping children (Promise.all) are not double counted", () => {
    const { root, handler, fn } = skeleton(100);
    const a = fetchSpan(fn.id, 10, 50, "https://api.example.com/a");
    const b = fetchSpan(fn.id, 20, 60, "https://api.example.com/b");
    const c = db(fn.id, 30, 45, "SELECT 1");
    const time = timeBudget([root, handler, fn, a, b, c], 100);
    expect(sum(time)).toBeCloseTo(100, 5);
    // 10..60 is covered by I/O; c (db) starts latest inside 30..45 so it owns that slice.
    expect(time.ext + time.db).toBeCloseTo(50);
    expect(time.db).toBeCloseTo(15);
  });

  test("zero-duration markers (Drizzle) are excluded from timing", () => {
    const { root, handler, fn } = skeleton(100);
    const marker = db(fn.id, 50, 50, "SELECT * FROM t");
    const time = timeBudget([root, handler, fn, marker], 100);
    expect(time.db).toBe(0);
    expect(sum(time)).toBeCloseTo(100, 5);
  });

  test("orphan spans (broken parent link) still get bucketed and spans past the end are clipped", () => {
    const root = span({ kind: "request", start: 0, end: 50 });
    const orphan = db("missing", 10, 80, "SELECT 1");
    const time = timeBudget([root, orphan], 50);
    expect(time.db).toBeCloseTo(40);
    expect(sum(time)).toBeCloseTo(50, 5);
  });

  test("no spans → all idle", () => {
    expect(timeBudget([], 20).idle).toBe(20);
  });

  test("bucket mapping", () => {
    expect(bucketOf(span({ kind: "db", attrs: { "db.system": "redis" } }))).toBe("cache");
    expect(bucketOf(span({ kind: "db" }))).toBe("db");
    expect(bucketOf(span({ kind: "fetch" }))).toBe("ext");
    expect(bucketOf(span({ kind: "compile" }))).toBe("compile");
    expect(bucketOf(span({ kind: "render" }))).toBe("framework");
    expect(bucketOf(span({ kind: "handler" }))).toBe("fn");
  });
});

describe("selfTimes", () => {
  test("self = duration minus union of children, clipped to the parent", () => {
    const p = span({ kind: "function", start: 0, end: 100 });
    const c1 = span({ kind: "db", parentId: p.id, start: 10, end: 30 });
    const c2 = span({ kind: "db", parentId: p.id, start: 20, end: 40 });
    const c3 = span({ kind: "db", parentId: p.id, start: 90, end: 120 });
    const self = selfTimes([p, c1, c2, c3]);
    expect(self.get(p.id)).toBeCloseTo(100 - 30 - 10);
  });
});

describe("computeFacts", () => {
  test("counts, bytes, ttfb, compile, cold/epoch passthrough", () => {
    const { root, handler, fn } = skeleton(200);
    const compile = span({ kind: "compile", parentId: root.id, start: 0, end: 80 });
    const compile2 = span({ kind: "compile", parentId: root.id, start: 40, end: 90 });
    const spans = [
      root,
      compile,
      compile2,
      handler,
      fn,
      db(fn.id, 100, 110, "SELECT 1"),
      db(fn.id, 110, 120, "GET k", { attrs: { "db.system": "redis", "db.statement": "GET k" } }),
      fetchSpan(fn.id, 120, 150, "https://x.dev/a"),
    ];
    const t = makeTrace(spans, {
      duration: 200,
      logs: [
        { t: 1, level: "warn", text: "w" },
        { t: 2, level: "error", text: "e" },
        { t: 3, level: "log", text: "l" },
      ],
    });
    const f = computeFacts(t, { ttfb: 180.123, reqBytes: 12, resBytes: 3400, epoch: 3, cold: true });
    expect(f.counts).toEqual({ spans: 8, db: 1, fetch: 1, cache: 1, fn: 1, warn: 1, error: 1 });
    expect(f.compileMs).toBe(90);
    expect(f.ttfb).toBe(180.12);
    expect(f.reqBytes).toBe(12);
    expect(f.resBytes).toBe(3400);
    expect(f.epoch).toBe(3);
    expect(f.cold).toBe(true);
    expect(f.droppedSpans).toBe(0);
    expect(f.truncated).toBeUndefined();
    expect(Object.keys(f.time).sort()).toEqual([...TIME_BUCKETS].sort());
    expect(sum(f.time)).toBeCloseTo(200, 0);
  });

  test("falls back to captured body sizes", () => {
    const t = makeTrace([], {
      request: { headers: {}, body: { size: 7 } },
      response: { headers: {}, body: { size: 9 } },
    });
    const f = computeFacts(t);
    expect(f.reqBytes).toBe(7);
    expect(f.resBytes).toBe(9);
    expect(f.time.idle).toBe(100);
  });

  test("Turbopack's untraced compile gap between compile spans counts as compile, not idle", () => {
    // Shape of a real cold hit: resolve/load route module, ~3s untraced compile, prepare, handler.
    const root = span({ kind: "request", start: 0, end: 3300 });
    // proxy.ts ran before the compile; it must not cut the compile window short.
    const proxy = span({ kind: "proxy", start: 1, end: 2 });
    const resolve = span({ kind: "compile", name: "resolve page components", parentId: root.id, start: 5, end: 120 });
    const load = span({ kind: "compile", name: "load route module", parentId: root.id, start: 120, end: 238 });
    const prepare = span({ kind: "compile", name: "prepare route module", parentId: root.id, start: 3043, end: 3060 });
    const handler = span({ kind: "handler", parentId: root.id, start: 3062, end: 3290 });
    const f = computeFacts(makeTrace([proxy, root, resolve, load, prepare, handler], { duration: 3300 }));
    expect(f.time.compile).toBeCloseTo(3060 - 5, 0);
    expect(f.compileMs).toBeCloseTo(3060 - 5, 0);
    // Before the first compile span and between prepare and the handler stays idle.
    expect(f.time.idle).toBeCloseTo(5 - 1 + 2 + 10, 0);
    expect(sum(f.time)).toBeCloseTo(3300, 0);
  });

  test("warm hit: back-to-back compile spans add no gap", () => {
    const root = span({ kind: "request", start: 0, end: 100 });
    const a = span({ kind: "compile", parentId: root.id, start: 2, end: 7 });
    const b = span({ kind: "compile", parentId: root.id, start: 7, end: 12 });
    const handler = span({ kind: "handler", parentId: root.id, start: 13, end: 99 });
    expect(computeFacts(makeTrace([root, a, b, handler])).compileMs).toBe(10);
  });

  test("warm hit on a dynamic route: a short hole between load and prepare stays idle", () => {
    // Shape of tr_28ii4q (/api/db/orders/[id], warm): load 20.6-21.3, prepare 38.6-42.5, no compile.
    const root = span({ kind: "request", start: 0, end: 60 });
    const load = span({ kind: "compile", name: "load route module", parentId: root.id, start: 20.6, end: 21.3 });
    const prepare = span({ kind: "compile", name: "prepare route module", parentId: root.id, start: 38.6, end: 42.5 });
    const handler = span({ kind: "handler", parentId: root.id, start: 43, end: 58 });
    const f = computeFacts(makeTrace([root, load, prepare, handler], { duration: 60 }));
    expect(f.compileMs).toBeCloseTo(0.7 + 3.9, 5);
    expect(f.time.compile).toBeCloseTo(0.7 + 3.9, 5);
    expect(f.time.idle).toBeCloseTo(60 - 15 - 4.6, 5);
  });

  test("span cap sets truncated", () => {
    const spans = Array.from({ length: MAX_ANALYZED_SPANS + 10 }, (_, i) => db("p", i, i + 1, "SELECT 1"));
    const f = computeFacts(makeTrace(spans, { duration: 3000 }));
    expect(f.truncated).toBe(true);
    expect(f.counts.spans).toBe(MAX_ANALYZED_SPANS + 10);
    expect(f.counts.db).toBe(MAX_ANALYZED_SPANS);
  });
});

describe("normalizeSql", () => {
  test("strips literals, numbers and $n placeholders", () => {
    expect(normalizeSql("SELECT * FROM products WHERE id = $1 AND name = 'O''Brien' AND qty > 10")).toBe(
      "SELECT * FROM products WHERE id = ? AND name = ? AND qty > ?",
    );
  });
  test("same shape with different values normalizes identically", () => {
    expect(normalizeSql("select * from t where id = 1")).toBe(normalizeSql("select  *\n from t where id = 42"));
  });
  test("collapses IN lists and multi-row VALUES", () => {
    expect(normalizeSql("SELECT * FROM t WHERE id IN (1, 2, 3, $4)")).toBe("SELECT * FROM t WHERE id IN (?)");
    expect(normalizeSql("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y'), (3, 'z')")).toBe(
      "INSERT INTO t (a, b) VALUES (?, ?)",
    );
  });
  test("keeps identifiers with digits and quoted identifiers", () => {
    expect(normalizeSql('SELECT col1 FROM "table2" WHERE x = true')).toBe('SELECT col1 FROM "table2" WHERE x = ?');
  });
  test("caps input at 4k chars", () => {
    const long = `SELECT ${"a, ".repeat(5000)}b FROM t`;
    expect(normalizeSql(long).length).toBeLessThanOrEqual(4096);
  });
});

describe("normalizeUrl", () => {
  test("numeric and uuid segments become :id, query values dropped, host kept", () => {
    expect(normalizeUrl("https://api.example.com/users/42/posts/0b6c2f1e-1d2a-4c3b-9e8f-112233445566?page=2&q=x")).toBe(
      "api.example.com/users/:id/posts/:id?page&q",
    );
  });
  test("long hex ids (ObjectId) become :id; slugs stay", () => {
    expect(normalizeUrl("https://h.dev/items/507f1f77bcf86cd799439011/edit")).toBe("h.dev/items/:id/edit");
    expect(normalizeUrl("https://h.dev/blog/hello-world")).toBe("h.dev/blog/hello-world");
  });
  test("relative urls keep no host", () => {
    expect(normalizeUrl("/api/orders/17?x=1")).toBe("/api/orders/:id?x");
  });
  test("different ids normalize identically", () => {
    expect(normalizeUrl("https://jsonplaceholder.typicode.com/users/1")).toBe(
      normalizeUrl("https://jsonplaceholder.typicode.com/users/9"),
    );
  });
});

describe("foldNestedFetches", () => {
  test("Next's AppRender.fetch + our nested fetch span for the same call become one span", () => {
    const { root, handler, fn } = skeleton(200);
    const outer = span({
      kind: "fetch",
      name: "fetch GET https://jsonplaceholder.typicode.com/posts",
      parentId: fn.id,
      start: 10,
      end: 60,
      attrs: { "http.url": "https://jsonplaceholder.typicode.com/posts", "http.method": "GET" },
    });
    const inner = fetchSpan(outer.id, 11, 59, "https://jsonplaceholder.typicode.com/posts", {
      "hoplens.fetch.cache": "no-store",
    });
    inner.location = { file: "src/lib/external.ts", line: 9 };
    const other = fetchSpan(fn.id, 70, 80, "https://api.example.com/x");
    const out = foldNestedFetches([root, handler, fn, outer, inner, other]);
    expect(out.map((s) => s.id)).toEqual([root.id, handler.id, fn.id, outer.id, other.id]);
    expect(outer.attrs["hoplens.fetch.cache"]).toBe("no-store");
    expect(outer.location).toEqual({ file: "src/lib/external.ts", line: 9 });
    expect(outer.start).toBe(10);
    expect(computeFacts(makeTrace(out, { duration: 200 })).counts.fetch).toBe(2);
  });

  test("a nested fetch to a different url is kept", () => {
    const { fn } = skeleton(100);
    const outer = fetchSpan(fn.id, 10, 60, "https://a.dev/x");
    const inner = fetchSpan(outer.id, 11, 59, "https://b.dev/y");
    expect(foldNestedFetches([fn, outer, inner])).toHaveLength(3);
  });
});
