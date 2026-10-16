import { describe, expect, test } from "vitest";
import { redisReadResult, redisWriteSize } from "../src/capture";
import { QueryStatsStore, hostOf, requestCached } from "../src/queries";
import type { SpanRecord, TraceRecord } from "../src/types";
import { db, fetchSpan, makeTrace, skeleton, span } from "./helpers";

let seq = 0;
function feedTrace(n: number, extra: Partial<TraceRecord> = {}): TraceRecord {
  const { root, handler, fn } = skeleton(500);
  const spans: SpanRecord[] = [root, handler, fn];
  for (let i = 0; i < n; i++) {
    spans.push(
      db(fn.id, 10 + i * 10, 14 + i * 10, `SELECT * FROM users WHERE id = ${i}`, {
        attrs: { "db.statement": `SELECT * FROM users WHERE id = ${i}`, "db.system": "postgresql", "db.rows": 1 },
      }),
    );
  }
  return makeTrace(spans, { id: `q${++seq}`, startedAt: 1000 * seq, duration: 500, ...extra });
}

describe("QueryStatsStore", () => {
  test("groups by normalized shape: calls, traces, timing, rows, callers, routes, samples", () => {
    const q = new QueryStatsStore();
    q.add(feedTrace(10));
    q.add(feedTrace(5, { route: "/api/other", path: "/api/other" }));
    const snap = q.snapshot();
    expect(snap.queries).toHaveLength(1);
    const s = snap.queries[0]!;
    expect(s).toMatchObject({
      fingerprint: "db:SELECT * FROM users WHERE id = ?",
      kind: "db",
      shape: "SELECT * FROM users WHERE id = ?",
      system: "postgresql",
      calls: 15,
      traces: 2,
      timedCalls: 15,
      totalMs: 60,
      avgMs: 4,
      p95Ms: 4,
      maxMs: 4,
      avgRows: 1,
      errors: 0,
    });
    expect(s.callers).toEqual([{ fn: "listProducts", location: { file: "src/lib/store.ts", line: 42 }, calls: 15 }]);
    expect(s.routes).toEqual([
      { route: "GET /api/products", calls: 10 },
      { route: "GET /api/other", calls: 5 },
    ]);
    expect(s.traceIds).toEqual([`q${seq}`, `q${seq - 1}`]);
  });

  test("trace-id samples: newest first, max 5, filtered to retained traces", () => {
    const q = new QueryStatsStore();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = feedTrace(1);
      ids.push(t.id);
      q.add(t);
    }
    expect(q.snapshot().queries[0]!.traceIds).toEqual(ids.slice(-5).reverse());
    const kept = new Set(ids.slice(0, 4));
    expect(q.snapshot({ retained: (id) => kept.has(id) }).queries[0]!.traceIds).toEqual(ids.slice(0, 4).reverse());
  });

  test("markers counted but not timed; sorted by total time; kind filter; limit", () => {
    const { root, handler, fn } = skeleton(100);
    const spans = [
      root,
      handler,
      fn,
      db(fn.id, 5, 5, "select 1"), // Drizzle-style zero-duration marker
      db(fn.id, 10, 60, "select heavy"),
      db(fn.id, 60, 62, "GET k1", { attrs: { "db.system": "redis", "db.statement": "GET k1" } }),
    ];
    const q = new QueryStatsStore();
    q.add(makeTrace(spans));
    const snap = q.snapshot();
    expect(snap.queries.map((x) => x.shape)).toEqual(["select heavy", "GET k1", "select ?"]);
    const marker = snap.queries.find((x) => x.shape === "select ?")!;
    expect(marker).toMatchObject({ calls: 1, timedCalls: 0, totalMs: 0 });
    expect(marker.p95Ms).toBeUndefined();
    expect(q.snapshot({ kind: "cache" }).queries.map((x) => x.kind)).toEqual(["cache"]);
    expect(q.snapshot({ limit: 1 }).queries).toHaveLength(1);
  });

  test("redis hit/miss from span attrs", () => {
    const { root, handler, fn } = skeleton(100);
    const r = (start: number, attrs: Record<string, string | number | boolean>) =>
      db(fn.id, start, start + 1, "GET k", { attrs: { "db.system": "redis", "db.statement": "GET k", ...attrs } });
    const q = new QueryStatsStore();
    q.add(
      makeTrace([
        root,
        handler,
        fn,
        r(10, { "hoplens.redis.hit": true }),
        r(20, { "hoplens.redis.hit": false }),
        r(30, { "hoplens.redis.hit": true }),
        r(40, { "hoplens.redis.hits": 2, "hoplens.redis.misses": 1 }),
      ]),
    );
    expect(q.snapshot().queries[0]).toMatchObject({ kind: "cache", system: "redis", hits: 4, misses: 2 });
  });

  test("hosts: calls, p95, error %, cached % (request-side intent), status histogram", () => {
    const { root, handler, fn } = skeleton(1000);
    const spans: SpanRecord[] = [root, handler, fn];
    let at = 10;
    const add = (url: string, attrs: Record<string, string | number | boolean>, err = false) => {
      const s = fetchSpan(fn.id, at, at + 20, url, attrs);
      if (err) s.error = { type: "TypeError", message: "fetch failed", stack: "" };
      spans.push(s);
      at += 25;
    };
    add("https://api.test/users/1", { "http.response.status_code": 200, "hoplens.fetch.cache": "force-cache" });
    add("https://api.test/users/2", { "http.response.status_code": 200, "hoplens.fetch.revalidate": "60" });
    add("https://api.test/users/3", { "http.response.status_code": 404, "hoplens.fetch.cache": "no-store" });
    add("https://api.test/users/4", { "http.status_code": 200, "hoplens.fetch.revalidate": "0" });
    add("https://api.test/users/5", {}, true);
    add("https://API.test/users/6", { "http.response.status_code": 500, "http.method": "POST" });
    add("/api/internal", { "http.response.status_code": 200 });
    const q = new QueryStatsStore();
    q.add(makeTrace(spans));
    const snap = q.snapshot();
    const h = snap.hosts.find((x) => x.host === "api.test")!;
    expect(h).toMatchObject({
      calls: 6,
      errorPct: 50, // 404, network error, 500
      cachedPct: 40, // 2 of 5 GETs asked for caching
      uncachedPct: 40, // no-store + revalidate 0
      statuses: { "200": 3, "404": 1, "500": 1, error: 1 },
      p95Ms: 20,
    });
    expect(snap.hosts.find((x) => x.host === "")!.calls).toBe(1);
    const users = snap.queries.find((x) => x.shape === "GET api.test/users/:id")!;
    expect(users).toMatchObject({ kind: "fetch", calls: 5, errors: 2 });
  });

  test("hostOf and requestCached", () => {
    expect(hostOf("https://user:pw@Example.COM:8443/x?y")).toBe("example.com:8443");
    expect(hostOf("//cdn.test/a")).toBe("cdn.test");
    expect(hostOf("/relative")).toBe("");
    const s = (attrs: Record<string, string>) => fetchSpan("p", 0, 1, "https://x", attrs);
    expect(requestCached(s({ "hoplens.fetch.revalidate": "false" }))).toBe(true);
    expect(requestCached(s({ "hoplens.fetch.revalidate": "0" }))).toBe(false);
    expect(requestCached(s({ "hoplens.fetch.cacheHit": "force-cache" }))).toBe(true);
    expect(requestCached(s({}))).toBe(false);
  });

  test("bounded: fingerprints and hosts capped, least recently seen dropped", () => {
    const q = new QueryStatsStore({ maxQueries: 10, maxHosts: 3 });
    for (let i = 0; i < 50; i++) {
      const { root, handler, fn } = skeleton(100);
      q.add(
        makeTrace([
          root,
          handler,
          fn,
          db(fn.id, 1, 2, `SELECT * FROM t${i}`),
          fetchSpan(fn.id, 3, 4, `https://h${i}.test/x`),
        ]),
      );
    }
    const snap = q.snapshot({ limit: 1000 });
    expect(snap.queries.length).toBe(10);
    expect(snap.hosts.map((h) => h.host).sort()).toEqual(["h47.test", "h48.test", "h49.test"]);
  });

  test("clear() resets and moves `since`; malformed traces never throw", () => {
    let now = 1;
    const q = new QueryStatsStore({}, () => now);
    q.add(feedTrace(2));
    now = 5;
    q.clear();
    expect(q.snapshot()).toEqual({ queries: [], hosts: [], since: 5 });
    expect(() => q.add({} as TraceRecord)).not.toThrow();
    expect(() =>
      q.add(makeTrace([span({ kind: "db", attrs: { "db.statement": 5 as unknown as string } })])),
    ).not.toThrow();
  });
});

describe("redis attributes", () => {
  test("GET-like reads: null = miss, value size in bytes", () => {
    expect(redisReadResult("GET", null)).toEqual({ "hoplens.redis.hit": false });
    expect(redisReadResult("GET", undefined)).toEqual({ "hoplens.redis.hit": false });
    expect(redisReadResult("GET", "héllo")).toEqual({ "hoplens.redis.hit": true, "hoplens.redis.valueSize": 6 });
    expect(redisReadResult("HGET", Buffer.from([1, 2, 3]))).toEqual({
      "hoplens.redis.hit": true,
      "hoplens.redis.valueSize": 3,
    });
    expect(redisReadResult("GET", "")).toEqual({ "hoplens.redis.hit": true, "hoplens.redis.valueSize": 0 });
    // An object reply (client-side decoding) is a hit with no cheap size.
    expect(redisReadResult("JSON.GET", { a: 1 })).toEqual({ "hoplens.redis.hit": true });
  });

  test("multi-key reads count hits and misses", () => {
    expect(redisReadResult("MGET", ["a", null, "bc"])).toEqual({
      "hoplens.redis.hits": 2,
      "hoplens.redis.misses": 1,
      "hoplens.redis.hit": false,
      "hoplens.redis.valueSize": 3,
    });
    expect(redisReadResult("MGET", ["a"])).toMatchObject({ "hoplens.redis.hit": true });
  });

  test("collection reads: empty = miss", () => {
    expect(redisReadResult("HGETALL", {})).toMatchObject({ "hoplens.redis.hit": false });
    expect(redisReadResult("HGETALL", { f: "vv" })).toEqual({
      "hoplens.redis.hit": true,
      "hoplens.redis.valueSize": 2,
    });
    expect(redisReadResult("SMEMBERS", [])).toMatchObject({ "hoplens.redis.hit": false });
  });

  test("writes and other commands", () => {
    expect(redisReadResult("SET", "OK")).toBeUndefined();
    expect(redisReadResult("DEL", 1)).toBeUndefined();
    expect(redisWriteSize("SET", ["k", "abcd", "EX", 60])).toBe(4);
    expect(redisWriteSize("SETEX", ["k", 60, "abc"])).toBe(3);
    expect(redisWriteSize("MSET", ["k1", "a", "k2", "bb"])).toBe(3);
    expect(redisWriteSize("HSET", ["h", "f1", "a", "f2", "bbb"])).toBe(4);
    expect(redisWriteSize("HSET", ["h", { f1: "a", f2: "bb" }])).toBe(3);
    expect(redisWriteSize("SET", ["k", Buffer.alloc(10)])).toBe(10);
    expect(redisWriteSize("SET", ["k", { not: "sizable" }])).toBeUndefined();
    expect(redisWriteSize("GET", ["k"])).toBeUndefined();
    expect(redisWriteSize("SET", "junk" as unknown as unknown[])).toBeUndefined();
  });
});
