import { describe, expect, test } from "vitest";
import { computeFacts } from "../src/facts";
import { DEFAULT_THRESHOLDS, analyze } from "../src/insights";
import type { Finding, FindingRule, SpanRecord, TraceRecord } from "../src/types";
import { db, fetchSpan, makeTrace, skeleton, span } from "./helpers";

function run(t: TraceRecord, factsOverride: Partial<ReturnType<typeof computeFacts>> = {}): Finding[] {
  const facts = { ...computeFacts(t), ...factsOverride };
  return analyze(t, facts);
}
const rules = (fs: Finding[]) => fs.map((f) => f.rule);
const only = (fs: Finding[], rule: FindingRule) => fs.filter((f) => f.rule === rule);

describe("n-plus-1", () => {
  test("same query shape x5 under one parent fires, names fn + location", () => {
    const { root, handler, fn } = skeleton(200);
    const qs = Array.from({ length: 6 }, (_, i) =>
      db(fn.id, 10 + i * 10, 18 + i * 10, `SELECT * FROM products WHERE id = ${i + 1}`),
    );
    const out = only(run(makeTrace([root, handler, fn, ...qs], { duration: 200 })), "n-plus-1");
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.count).toBe(6);
    expect(f.fn).toBe("listProducts");
    expect(f.location).toEqual({ file: "src/lib/store.ts", line: 42 });
    expect(f.title).toContain("listProducts");
    expect(f.title).toContain("x6");
    expect(f.estSavedMs).toBe(40);
    expect(f.spanIds).toHaveLength(6);
  });

  test("covers fetch: GET /users/:id once per post", () => {
    const { root, handler, fn } = skeleton(300);
    const fs = Array.from({ length: 5 }, (_, i) =>
      fetchSpan(fn.id, 10 + i * 20, 25 + i * 20, `https://jsonplaceholder.typicode.com/users/${i + 1}`),
    );
    const out = only(run(makeTrace([root, handler, fn, ...fs], { duration: 300 })), "n-plus-1");
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("jsonplaceholder.typicode.com/users/:id");
  });

  test("a loop over a traced per-item function fires (each query has its own wrapper parent)", () => {
    const { root, handler, fn } = skeleton(400);
    const spans: SpanRecord[] = [root, handler, fn];
    for (let i = 0; i < 10; i++) {
      const w = span({ kind: "function", name: "getUser", parentId: fn.id, start: 10 + i * 30, end: 35 + i * 30 });
      spans.push(w, fetchSpan(w.id, w.start + 1, w.end - 1, `https://jsonplaceholder.typicode.com/users/${i + 1}`));
    }
    const out = run(makeTrace(spans, { duration: 400 }));
    const n1 = only(out, "n-plus-1");
    expect(n1).toHaveLength(1);
    expect(n1[0]!.count).toBe(10);
    expect(n1[0]!.fn).toBe("listProducts");
    expect(n1[0]!.title).toContain("via getUser()");
    // Claimed, so neither the per-call wrappers nor the fetches are reported again.
    expect(rules(out)).not.toContain("parallelizable");
    expect(rules(out)).not.toContain("duplicate");
  });

  test("one wrapper call running a query 5 times stays a direct-parent group; 2 wrappers x 3 do not fire", () => {
    const { root, handler, fn } = skeleton(400);
    const spans: SpanRecord[] = [root, handler, fn];
    for (let w = 0; w < 2; w++) {
      const wrap = span({
        kind: "function",
        name: "loadPage",
        parentId: fn.id,
        start: 10 + w * 100,
        end: 90 + w * 100,
      });
      spans.push(wrap);
      for (let i = 0; i < 3; i++)
        spans.push(db(wrap.id, wrap.start + 1 + i * 10, wrap.start + 8 + i * 10, `SELECT * FROM t WHERE id = ${i}`));
    }
    expect(rules(run(makeTrace(spans, { duration: 400 })))).not.toContain("n-plus-1");
  });

  test("4 repeats, or 5 repeats split across parents, do not fire", () => {
    const { root, handler, fn } = skeleton(200);
    const other = span({ kind: "function", name: "other", parentId: handler.id, start: 150, end: 190 });
    const qs = [
      ...Array.from({ length: 4 }, (_, i) => db(fn.id, 10 + i * 10, 15 + i * 10, `SELECT * FROM t WHERE id = ${i}`)),
      db(other.id, 160, 165, "SELECT * FROM t WHERE id = 99"),
    ];
    const out = run(makeTrace([root, handler, fn, other, ...qs], { duration: 200 }));
    expect(rules(out)).not.toContain("n-plus-1");
  });
});

describe("duplicate", () => {
  test("exact same query + params twice fires", () => {
    const { root, handler, fn } = skeleton(100);
    const a = db(fn.id, 10, 20, "SELECT * FROM users WHERE id = $1", {
      attrs: { "db.statement": "SELECT * FROM users WHERE id = $1", "hoplens.db.params": "[1]" },
    });
    const b = db(fn.id, 30, 45, "SELECT * FROM users WHERE id = $1", {
      attrs: { "db.statement": "SELECT * FROM users WHERE id = $1", "hoplens.db.params": "[1]" },
    });
    const out = only(run(makeTrace([root, handler, fn, a, b])), "duplicate");
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(2);
    expect(out[0]!.estSavedMs).toBe(10);
  });

  test("a parameterized statement without params (third-party OTel db span) is not a duplicate", () => {
    const { root, handler, fn } = skeleton(100);
    const a = db(fn.id, 10, 20, "SELECT * FROM users WHERE id = $1");
    const b = db(fn.id, 30, 45, "SELECT * FROM users WHERE id = $1");
    const c = db(fn.id, 50, 55, "SELECT * FROM users WHERE email = :email");
    const d = db(fn.id, 60, 65, "SELECT * FROM users WHERE email = :email");
    expect(rules(run(makeTrace([root, handler, fn, a, b, c, d])))).not.toContain("duplicate");
    // A literal statement with no placeholders is still an exact duplicate.
    const e = db(fn.id, 70, 75, "SELECT count(*) FROM users");
    const f = db(fn.id, 80, 85, "SELECT count(*) FROM users");
    expect(rules(run(makeTrace([root, handler, fn, e, f])))).toContain("duplicate");
  });

  test("different params do not fire", () => {
    const { root, handler, fn } = skeleton(100);
    const a = db(fn.id, 10, 20, "q", { attrs: { "db.statement": "q", "hoplens.db.params": "[1]" } });
    const b = db(fn.id, 30, 45, "q", { attrs: { "db.statement": "q", "hoplens.db.params": "[2]" } });
    expect(rules(run(makeTrace([root, handler, fn, a, b])))).not.toContain("duplicate");
  });

  test("not reported again when n-plus-1 fires on the same group", () => {
    const { root, handler, fn } = skeleton(200);
    const qs = Array.from({ length: 5 }, (_, i) => db(fn.id, 10 + i * 10, 15 + i * 10, "SELECT * FROM t WHERE id = 1"));
    const out = run(makeTrace([root, handler, fn, ...qs], { duration: 200 }));
    expect(rules(out)).toContain("n-plus-1");
    expect(rules(out)).not.toContain("duplicate");
  });
});

describe("parallelizable", () => {
  test("sequential sibling fetches >= 10ms fire with estSavedMs = sum - max", () => {
    const { root, handler, fn } = skeleton(200);
    const a = fetchSpan(fn.id, 10, 40, "https://api.github.com/repos/vercel/next.js");
    const b = fetchSpan(fn.id, 41, 61, "https://api.open-meteo.com/v1/forecast?lat=1");
    const c = db(fn.id, 62, 112, "SELECT * FROM orders");
    const out = only(run(makeTrace([root, handler, fn, a, b, c], { duration: 200 })), "parallelizable");
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(3);
    expect(out[0]!.estSavedMs).toBe(30 + 20 + 50 - 50);
    expect(out[0]!.title).toContain("could run in parallel");
    expect(out[0]!.fn).toBe("listProducts");
  });

  test("a 2-call chain (usually a data dependency: geocode -> weather) does not fire", () => {
    const { root, handler, fn } = skeleton(400);
    const a = fetchSpan(fn.id, 10, 150, "https://geocoding-api.open-meteo.com/v1/search?name=Paris");
    const b = fetchSpan(fn.id, 151, 290, "https://api.open-meteo.com/v1/forecast?lat=1");
    expect(rules(run(makeTrace([root, handler, fn, a, b], { duration: 400 })))).not.toContain("parallelizable");
  });

  test("overlapping (already parallel), short, or far-apart siblings do not fire", () => {
    const { root, handler, fn } = skeleton(300);
    const a = fetchSpan(fn.id, 10, 40, "https://a.dev/x");
    const b = fetchSpan(fn.id, 20, 50, "https://b.dev/y"); // overlaps a
    const c = fetchSpan(fn.id, 51, 55, "https://c.dev/z"); // < 10ms
    const d = fetchSpan(fn.id, 150, 170, "https://d.dev/w"); // gap 95ms after b
    expect(rules(run(makeTrace([root, handler, fn, a, b, c, d], { duration: 300 })))).not.toContain("parallelizable");
  });
});

describe("parallelizable: one cause, one finding", () => {
  const loop = (fnId: string, n: number, overlap: number) =>
    Array.from({ length: n }, (_, i) =>
      span({
        kind: "function",
        name: "getOrder",
        parentId: fnId,
        start: 1 + i * (16 - overlap),
        end: 17 + i * (16 - overlap),
      }),
    );
  test("1ms timer overlap between awaited calls (Windows) keeps a 6-call loop as one run", () => {
    const { root, handler, fn } = skeleton(200);
    const out = only(run(makeTrace([root, handler, fn, ...loop(fn.id, 6, 1)], { duration: 200 })), "parallelizable");
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(6);
  });
  test("the fingerprint does not depend on how many calls the run had", () => {
    const a = skeleton(200);
    const b = skeleton(200);
    const six = only(
      run(makeTrace([a.root, a.handler, a.fn, ...loop(a.fn.id, 6, 0)], { duration: 200 })),
      "parallelizable",
    );
    const four = only(
      run(makeTrace([b.root, b.handler, b.fn, ...loop(b.fn.id, 4, 0)], { duration: 200 })),
      "parallelizable",
    );
    expect(six[0]!.fingerprint).toBe(four[0]!.fingerprint);
  });
  test("a loop split by a real gap reports one finding (the longer run)", () => {
    const { root, handler, fn } = skeleton(400);
    const first = loop(fn.id, 4, 0);
    const second = loop(fn.id, 3, 0).map((s) => ({ ...s, id: `${s.id}b`, start: s.start + 200, end: s.end + 200 }));
    const out = only(run(makeTrace([root, handler, fn, ...first, ...second], { duration: 400 })), "parallelizable");
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(4);
  });
});

describe("slow-fn", () => {
  test("function self time >= 100ms fires", () => {
    const { root, handler, fn } = skeleton(400);
    const out = only(run(makeTrace([root, handler, fn], { duration: 400 })), "slow-fn");
    expect(out).toHaveLength(1);
    expect(out[0]!.fn).toBe("listProducts");
    expect(out[0]!.location?.line).toBe(42);
  });

  test(">= 50% share of a short trace fires; child I/O is not self time", () => {
    const { root, handler, fn } = skeleton(60);
    expect(rules(run(makeTrace([root, handler, fn], { duration: 60 })))).toContain("slow-fn");

    const big = skeleton(400);
    const q = db(big.fn.id, 3, 397, "SELECT pg_sleep(0.4)");
    expect(rules(run(makeTrace([big.root, big.handler, big.fn, q], { duration: 400 })))).not.toContain("slow-fn");
  });

  test("share test needs real self time: a 26ms timer in a 44ms request doesn't fire", () => {
    // Live /api/products: listProducts awaits wait(12), ~26ms self with timer slop, 57% of 44ms.
    const root = span({ kind: "request", start: 0, end: 44 });
    const handler = span({ kind: "handler", parentId: root.id, start: 1, end: 43 });
    const fn = span({ kind: "function", name: "listProducts", parentId: handler.id, start: 10, end: 36 });
    expect(rules(run(makeTrace([root, handler, fn], { duration: 44 })))).not.toContain("slow-fn");
  });

  test("tiny traces don't trip the share test", () => {
    const { root, handler, fn } = skeleton(10);
    expect(rules(run(makeTrace([root, handler, fn], { duration: 10 })))).not.toContain("slow-fn");
  });
});

describe("fetch-uncached", () => {
  test("GET with cache: no-store or revalidate: 0 fires", () => {
    const { root, handler, fn } = skeleton(100);
    const a = fetchSpan(fn.id, 10, 20, "https://api.example.com/prices", { "hoplens.fetch.cache": "no-store" });
    const b = fetchSpan(fn.id, 30, 40, "https://cdn.example.com/x", { "hoplens.fetch.revalidate": "0" });
    const out = only(run(makeTrace([root, handler, fn, a, b])), "fetch-uncached");
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.title).join("|")).toContain("no-store");
  });

  test("an upstream CDN status (cf-cache-status DYNAMIC / MISS) is not Next's cache and does not fire", () => {
    const { root, handler, fn } = skeleton(100);
    const a = fetchSpan(fn.id, 10, 20, "https://pokeapi.co/api/v2/pokemon/25", {
      "hoplens.fetch.cache": "force-cache",
      "hoplens.fetch.upstreamCache": "DYNAMIC",
    });
    const b = fetchSpan(fn.id, 30, 40, "https://cdn.example.com/x", { "hoplens.fetch.upstreamCache": "MISS" });
    expect(rules(run(makeTrace([root, handler, fn, a, b])))).not.toContain("fetch-uncached");
  });

  test("cached or non-GET fetches do not fire", () => {
    const { root, handler, fn } = skeleton(100);
    const a = fetchSpan(fn.id, 10, 20, "https://api.example.com/p", { "hoplens.fetch.cacheHit": "HIT" });
    const b = fetchSpan(fn.id, 30, 40, "https://api.example.com/p", {
      "http.method": "POST",
      "hoplens.fetch.cache": "no-store",
    });
    const c = fetchSpan(fn.id, 50, 60, "https://api.example.com/q", { "hoplens.fetch.cache": "force-cache" });
    expect(rules(run(makeTrace([root, handler, fn, a, b, c])))).not.toContain("fetch-uncached");
  });
});

describe("cold-compile", () => {
  test("compileMs >= 300 fires with estSavedMs", () => {
    const root = span({ kind: "request", start: 0, end: 500 });
    const c = span({ kind: "compile", parentId: root.id, start: 0, end: 350 });
    const out = only(run(makeTrace([root, c], { duration: 500 })), "cold-compile");
    expect(out).toHaveLength(1);
    expect(out[0]!.estSavedMs).toBe(350);
    expect(out[0]!.spanIds).toEqual([c.id]);
  });

  test("cold flag alone fires; warm + fast compile does not", () => {
    const root = span({ kind: "request", start: 0, end: 50 });
    const c = span({ kind: "compile", parentId: root.id, start: 0, end: 5 });
    expect(rules(run(makeTrace([root, c], { duration: 50 }), { cold: true }))).toContain("cold-compile");
    expect(rules(run(makeTrace([root, c], { duration: 50 }), { cold: false }))).not.toContain("cold-compile");
  });
});

describe("large-payload", () => {
  test("response > 1MB fires, request > 1MB fires", () => {
    const t = makeTrace([]);
    const out = only(run(t, { resBytes: 2 * 1024 * 1024, reqBytes: 1024 * 1024 + 1 }), "large-payload");
    expect(out.map((f) => f.title)).toEqual(["Response body is 2.0MB", "Request body is 1.0MB"]);
  });
  test("exactly 1MB does not fire", () => {
    expect(rules(run(makeTrace([]), { resBytes: 1024 * 1024 }))).not.toContain("large-payload");
  });
});

describe("swallowed-error", () => {
  const failing = (parentId: string): SpanRecord =>
    span({
      kind: "function",
      name: "chargeCard",
      parentId,
      start: 10,
      end: 20,
      error: { type: "TypeError", message: "x is undefined", stack: "", location: { file: "src/pay.ts", line: 7 } },
    });

  test("errored span on a 200 fires with the error location", () => {
    const { root, handler, fn } = skeleton(100);
    const out = only(run(makeTrace([root, handler, fn, failing(fn.id)], { status: 200 })), "swallowed-error");
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("warn");
    expect(out[0]!.location).toEqual({ file: "src/pay.ts", line: 7 });
    expect(out[0]!.fn).toBe("chargeCard");
  });

  test("one failure propagating fn -> fetch is reported once, at the outermost span", () => {
    const { root, handler, fn } = skeleton(100);
    const err = { type: "TimeoutError", message: "The operation was aborted due to timeout", stack: "" };
    const inv = span({ kind: "function", name: "fetchInventory", parentId: fn.id, start: 10, end: 60, error: err });
    const f = fetchSpan(inv.id, 11, 59, "https://httpbin.org/delay/3");
    f.error = { ...err };
    const out = only(run(makeTrace([root, handler, fn, inv, f], { status: 200 })), "swallowed-error");
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("fetchInventory");
  });

  test("a failure re-thrown with a new message (fetch HTTP 503 -> UpstreamError) is still one finding", () => {
    const { root, handler, fn } = skeleton(100);
    const inv = span({
      kind: "function",
      name: "fetchInventory",
      parentId: fn.id,
      start: 10,
      end: 60,
      error: { type: "UpstreamError", message: "dummyjson.com returned 503", stack: "" },
    });
    const f = fetchSpan(inv.id, 11, 59, "https://dummyjson.com/http/503");
    f.error = { type: "Error", message: "HTTP 503", stack: "" };
    const out = only(run(makeTrace([root, handler, fn, inv, f], { status: 200 })), "swallowed-error");
    expect(out.map((x) => x.fn)).toEqual(["fetchInventory"]);
  });

  test("fingerprint is stable across fetch urls with different ids", () => {
    const mk = (id: number) => {
      const { root, handler, fn } = skeleton(100);
      const f = fetchSpan(fn.id, 10, 20, `https://pokeapi.co/api/v2/pokemon/${id}`);
      f.error = { type: "Error", message: "HTTP 404", stack: "" };
      return only(run(makeTrace([root, handler, fn, f], { status: 200 })), "swallowed-error")[0]!.fingerprint;
    };
    expect(mk(25)).toBe(mk(9999));
  });

  test("errored span on a 500 does not fire", () => {
    const { root, handler, fn } = skeleton(100);
    expect(rules(run(makeTrace([root, handler, fn, failing(fn.id)], { status: 500 })))).not.toContain(
      "swallowed-error",
    );
  });
});

describe("logs-on-success", () => {
  test("warn/error logs on a 2xx fire", () => {
    const t = makeTrace([], {
      status: 201,
      logs: [
        { t: 1, level: "warn", text: "deprecated option", location: { file: "src/a.ts", line: 3 } },
        { t: 2, level: "error", text: "retrying upstream\nstack...", location: { file: "src/b.ts", line: 9 } },
      ],
    });
    const out = only(run(t), "logs-on-success");
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("warn");
    expect(out[0]!.count).toBe(2);
    expect(out[0]!.location).toEqual({ file: "src/b.ts", line: 9 });
    expect(out[0]!.title).toContain("retrying upstream");
  });

  test("info logs on a 2xx, or warn logs on a 500, do not fire", () => {
    expect(rules(run(makeTrace([], { logs: [{ t: 1, level: "log", text: "hi" }] })))).not.toContain("logs-on-success");
    expect(rules(run(makeTrace([], { status: 500, logs: [{ t: 1, level: "warn", text: "w" }] })))).not.toContain(
      "logs-on-success",
    );
  });
});

describe("analyze()", () => {
  test("fingerprints are stable across traces with different ids/values", () => {
    const mk = (offset: number) => {
      const { root, handler, fn } = skeleton(200);
      const qs = Array.from({ length: 5 }, (_, i) =>
        db(fn.id, 10 + i * 10, 15 + i * 10, `SELECT * FROM t WHERE id = ${i + offset}`),
      );
      return only(run(makeTrace([root, handler, fn, ...qs], { duration: 200 })), "n-plus-1")[0]!.fingerprint;
    };
    expect(mk(1)).toBe(mk(100));
  });

  test("disable and thresholds options are honoured", () => {
    const { root, handler, fn } = skeleton(400);
    const t = makeTrace([root, handler, fn], { duration: 400 });
    const facts = computeFacts(t);
    expect(rules(analyze(t, facts, { disable: ["slow-fn"] }))).not.toContain("slow-fn");
    expect(rules(analyze(t, facts, { thresholds: { slowFnMs: 1000, slowFnShare: 1.1 } }))).not.toContain("slow-fn");
    expect(DEFAULT_THRESHOLDS.nPlusOneMin).toBe(5);
  });

  test("sorted by severity, then estimated savings", () => {
    const { root, handler, fn } = skeleton(400);
    const qs = Array.from({ length: 20 }, (_, i) => db(fn.id, 10 + i, 11 + i, `SELECT * FROM t WHERE id = ${i}`));
    const out = run(
      makeTrace([root, handler, fn, ...qs], { duration: 400, logs: [{ t: 1, level: "warn", text: "w" }] }),
    );
    const ranks = out.map((f) => ({ error: 0, warn: 1, info: 2 })[f.severity]);
    expect([...ranks].sort()).toEqual(ranks);
  });
});
