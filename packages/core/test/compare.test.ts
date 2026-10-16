// WP8 core: trace compare (span matching, folded groups, deltas, findings, header/body diff),
// trace pinning in the store, and GET /api/compare.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sendJson } from "../src/api/module";
import {
  type CompareRow,
  MAX_DIFF_OPS,
  compareTraces,
  diffBodies,
  diffFindings,
  diffHeaders,
  diffJson,
  findBaselines,
  identityOf,
  matchTrees,
  summaryDirection,
} from "../src/compare";
import { DEFAULT_REDACT } from "../src/options";
import type { Runtime } from "../src/runtime";
import { makeRedactor } from "../src/serialize";
import { handleUi } from "../src/server";
import { TraceStore } from "../src/store";
import type { Finding, SpanRecord, TraceRecord } from "../src/types";
import { db, fetchSpan, makeTrace, skeleton, span } from "./helpers";

const redactor = makeRedactor([...DEFAULT_REDACT]);

/** request > handler > listProducts > n x `sql` (each 5ms, sequential), total = 20 + 5n ms. */
function queries(id: string, n: number, sql = "SELECT * FROM products WHERE id = 1", extra: Partial<TraceRecord> = {}) {
  const duration = 20 + 5 * n;
  const { root, handler, fn } = skeleton(duration);
  const spans: SpanRecord[] = [root, handler, fn];
  for (let i = 0; i < n; i++) spans.push(db(fn.id, 5 + i * 5, 10 + i * 5, sql.replace("= 1", `= ${i + 1}`)));
  return makeTrace(spans, { id, duration, ...extra });
}

const rowByLabel = (rows: CompareRow[], re: RegExp) => rows.find((r) => re.test(r.label));

/* ----------------------------------------------------------- span matching */

describe("span matching and folded groups", () => {
  test("N+1 vs one query of the same shape folds to x10 -> x1", () => {
    const r = compareTraces(queries("a", 10), queries("b", 1));
    const row = rowByLabel(r.rows, /SELECT/)!;
    expect(row.a?.count).toBe(10);
    expect(row.b?.count).toBe(1);
    expect(row.countDelta).toBe(-9);
    expect(row.status).toBe("changed");
    expect(row.a?.spanIds).toHaveLength(10);
    // Span level: occurrence 0 pairs, 9 left only in A.
    expect(r.spans).toEqual({ matched: 4, onlyA: 9, onlyB: 0, truncated: false });
    const dbPairs = r.pairs.filter((p) => p.key.startsWith("db|"));
    expect(dbPairs.map((p) => p.key.split("|").pop())).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(dbPairs[0]).toMatchObject({ a: row.a!.spanIds[0], b: row.b!.spanIds[0], deltaMs: 0 });
    expect(dbPairs[1]!.b).toBeUndefined();
    expect(r.counts.find((c) => c.name === "db")).toEqual({ name: "db", a: 10, b: 1, delta: -9 });
    expect(r.summary.direction).toBe("faster");
    expect(r.summary.sentence).toContain("x10 -> x1");
  });

  test("x1 -> x50 in the slower direction", () => {
    const r = compareTraces(queries("a", 1), queries("b", 50));
    const row = rowByLabel(r.rows, /SELECT/)!;
    expect([row.a?.count, row.b?.count]).toEqual([1, 50]);
    expect(row.deltaMs).toBe(245);
    expect(r.summary.direction).toBe("slower");
    expect(r.summary.largestBucket?.bucket).toBe("db");
    expect(r.summary.driverKey).toBe(row.key);
    expect(r.summary.sentence).toMatch(/^B is 245ms slower \(\+980%\): db \+245ms, SELECT \* FROM products/);
    expect(r.summary.sentence).toContain("x1 -> x50");
  });

  test("N+1 vs a batched IN query: different shapes, only-in-A and only-in-B rows", () => {
    const b = queries("b", 1, "SELECT * FROM products WHERE id IN (1, 2, 3)");
    const r = compareTraces(queries("a", 10), b);
    const nplus1 = rowByLabel(r.rows, /id = \?/)!;
    const batched = rowByLabel(r.rows, /IN \(\?\)/)!;
    expect(nplus1).toMatchObject({ status: "onlyA", countDelta: -10 });
    expect(nplus1.a?.count).toBe(10);
    expect(batched).toMatchObject({ status: "onlyB", countDelta: 1 });
    expect(r.counts.find((c) => c.name === "db")?.delta).toBe(-9);
  });

  test("reordered siblings of different shapes still match", () => {
    const mk = (id: string, swap: boolean) => {
      const { root, handler, fn } = skeleton(100);
      const q = db(fn.id, swap ? 40 : 5, swap ? 60 : 25, "SELECT * FROM users");
      const f = fetchSpan(fn.id, swap ? 5 : 30, swap ? 35 : 60, "https://rating.svc/api/r/1");
      return makeTrace([root, handler, fn, q, f], { id });
    };
    const r = compareTraces(mk("a", false), mk("b", true));
    expect(r.rows.every((row) => row.status !== "onlyA" && row.status !== "onlyB")).toBe(true);
    expect(r.spans).toEqual({ matched: 5, onlyA: 0, onlyB: 0, truncated: false });
    // Rows follow B's order.
    const kids = r.rows.filter((row) => row.depth === 3).map((row) => row.kind);
    expect(kids).toEqual(["fetch", "db"]);
  });

  test("a missing span is only-in-A, with its subtree, and B's extra is only-in-B", () => {
    const { root, handler, fn } = skeleton(100);
    const cache = span({ kind: "function", name: "cache.get", parentId: fn.id, start: 3, end: 5 });
    const inner = db(cache.id, 3, 4, "SELECT 1");
    const a = makeTrace([root, handler, fn, cache, inner], { id: "a" });
    const s = skeleton(100);
    const extra = fetchSpan(s.fn.id, 10, 14, "https://rating.svc/api/r/9");
    const b = makeTrace([s.root, s.handler, s.fn, extra], { id: "b" });
    const r = compareTraces(a, b);
    const gone = rowByLabel(r.rows, /cache\.get/)!;
    expect(gone.status).toBe("onlyA");
    expect(gone.b).toBeUndefined();
    const goneKid = r.rows.find((row) => row.parentKey === gone.key)!;
    expect(goneKid.status).toBe("onlyA");
    const added = r.rows.find((row) => row.kind === "fetch")!;
    expect(added.status).toBe("onlyB");
    expect(added.label).toBe("GET rating.svc/api/r/:id");
    expect(r.spans).toEqual({ matched: 3, onlyA: 2, onlyB: 1, truncated: false });
  });

  test("children of a folded group are pooled: getRating x3 > pg.query x3 vs x12 > x12", () => {
    const mk = (id: string, n: number) => {
      const { root, handler, fn } = skeleton(200);
      const spans: SpanRecord[] = [root, handler, fn];
      for (let i = 0; i < n; i++) {
        const g = span({ kind: "function", name: "getRating", parentId: fn.id, start: 5 + i * 10, end: 14 + i * 10 });
        spans.push(g, db(g.id, 6 + i * 10, 13 + i * 10, `SELECT r FROM ratings WHERE p = ${i}`));
      }
      return makeTrace(spans, { id });
    };
    const r = compareTraces(mk("a", 3), mk("b", 12));
    const g = rowByLabel(r.rows, /^getRating$/)!;
    const q = r.rows.find((row) => row.parentKey === g.key)!;
    expect([g.a?.count, g.b?.count, q.a?.count, q.b?.count]).toEqual([3, 12, 3, 12]);
    expect(q.depth).toBe(g.depth + 1);
    expect(q.key).toMatch(/>function\|getRating$/);
    expect(r.rows.filter((row) => row.kind === "db")).toHaveLength(1);
  });

  test("row keys are stable across traces and carry kind, identity and parent path", () => {
    const r1 = compareTraces(queries("a", 2), queries("b", 3));
    const r2 = compareTraces(queries("c", 5), queries("d", 1));
    expect(r1.rows.map((r) => r.key)).toEqual(r2.rows.map((r) => r.key));
    const q = rowByLabel(r1.rows, /SELECT/)!;
    expect(q.key).toBe("db|db:SELECT * FROM products WHERE id = ?|request|>handler|handler>function|listProducts");
    expect(new Set(r1.pairs.map((p) => p.key)).size).toBe(r1.pairs.length);
  });

  test("url-like tokens in names are normalized, the request root always matches", () => {
    expect(identityOf(span({ kind: "render", name: "render /products/123?x=1" }))).toBe("render /products/:id?x");
    expect(identityOf(span({ kind: "request", name: "GET /a" }))).toBe("");
    const a = makeTrace([span({ kind: "request", name: "GET /api/orders/1", start: 0, end: 10 })], { id: "a" });
    const b = makeTrace([span({ kind: "request", name: "GET /api/orders/2", start: 0, end: 12 })], { id: "b" });
    expect(compareTraces(a, b).rows).toHaveLength(1);
  });

  test("unchanged rows are 'same' (under 1ms or 10%)", () => {
    const r = compareTraces(queries("a", 2), queries("b", 2));
    expect(r.rows.every((row) => row.status === "same")).toBe(true);
    expect(r.summary.direction).toBe("same");
    expect(r.summary.sentence).toMatch(/^B takes about the same time/);
  });

  test("an 'about the same' sentence lists no deltas as causes (-37ms on ~400ms is noise)", async () => {
    const { db: q, makeTrace: mk, span: sp } = await import("./helpers");
    const side = (id: string, ext: number) => {
      const root = sp({ kind: "request", name: "GET /api/feed", start: 0, end: 400 + ext });
      const h = sp({ kind: "handler", name: "GET /api/feed", parentId: root.id, start: 1, end: 399 + ext });
      const f = sp({
        kind: "fetch",
        name: "fetch GET https://x.dev/users/1",
        parentId: h.id,
        start: 5,
        end: 300 + ext,
        attrs: { "url.full": "https://x.dev/users/1", "http.method": "GET" },
      });
      return mk([root, h, f, q(h.id, 301 + ext, 320 + ext, "SELECT 1")], { id, duration: 400 + ext });
    };
    const r = compareTraces(side("a", 0), side("b", -37));
    expect(r.summary.direction).toBe("same");
    expect(r.summary.sentence).toBe("B takes about the same time (-37ms, within noise).");
  });

  test("broken parent links become roots instead of vanishing", () => {
    const orphan = db("nope", 1, 2, "SELECT 1");
    const m = matchTrees([orphan], [db("gone", 1, 3, "SELECT 2")]);
    expect(m.rows).toHaveLength(1);
    expect(m.matched).toBe(1);
  });
});

/* ------------------------------------------------------- facts + findings */

describe("bucket deltas, sentence, findings", () => {
  test("bucket deltas cover every bucket and the sentence names the largest delta", () => {
    const a = queries("a", 1);
    const s = skeleton(120);
    const slow = fetchSpan(s.fn.id, 5, 105, "https://slow.svc/x");
    const b = makeTrace([s.root, s.handler, s.fn, db(s.fn.id, 105, 110, "SELECT * FROM products WHERE id = 1"), slow], {
      id: "b",
      duration: 120,
    });
    const r = compareTraces(a, b);
    expect(r.buckets.map((x) => x.bucket)).toEqual(["db", "cache", "ext", "fn", "framework", "compile", "idle"]);
    const ext = r.buckets.find((x) => x.bucket === "ext")!;
    expect(ext.delta).toBe(100);
    expect(r.summary.largestBucket?.bucket).toBe("ext");
    expect(r.summary.sentence).toContain("external +100ms");
    expect(r.summary.sentence).toContain("GET slow.svc/x only in B");
    expect(r.summary.deltaMs).toBe(95);
  });

  test("findings: added, resolved, count changed, kept; the sentence cites the new one", () => {
    const f = (fp: string, extra: Partial<Finding> = {}): Finding => ({
      rule: "n-plus-1",
      severity: "warn",
      title: `t ${fp}`,
      fingerprint: fp,
      spanIds: [],
      ...extra,
    });
    const d = diffFindings(
      [f("x"), f("y", { count: 10 }), f("z")],
      [f("y", { count: 50 }), f("z"), f("w", { location: { file: "src/lib/store.ts", line: 88 } })],
    );
    expect(d.added.map((x) => x.fingerprint)).toEqual(["w"]);
    expect(d.resolved.map((x) => x.fingerprint)).toEqual(["x"]);
    expect(d.changed).toEqual([{ fingerprint: "y", rule: "n-plus-1", title: "t y", a: 10, b: 50 }]);
    expect(d.kept).toBe(1);
    expect(d.added[0]).not.toHaveProperty("spanIds");

    const a = queries("a", 1);
    const b = queries("b", 50, undefined, {
      findings: [f("np1", { title: "findMany in a loop", location: { file: "src/lib/store.ts", line: 88 } })],
    });
    expect(compareTraces(a, b).summary.sentence).toMatch(/; new: findMany in a loop \(store\.ts:88\)\.$/);
  });

  test("uses stored facts when present", () => {
    const a = queries("a", 1);
    const b = queries("b", 1);
    const time = { db: 1, cache: 0, ext: 0, fn: 2, framework: 0, compile: 0, idle: 0 };
    const counts = { spans: 4, db: 1, fetch: 0, cache: 0, fn: 1, warn: 0, error: 0 };
    a.facts = { time, reqBytes: 0, resBytes: 10, counts, cold: true, compileMs: 0, droppedSpans: 0, epoch: 3 };
    b.facts = { ...a.facts, time: { ...time, db: 41 }, cold: false, epoch: 4, resBytes: 30 };
    const r = compareTraces(a, b);
    expect(r.buckets.find((x) => x.bucket === "db")).toEqual({ bucket: "db", a: 1, b: 41, delta: 40 });
    expect([r.a.epoch, r.b.epoch, r.a.cold, r.b.cold, r.b.resBytes]).toEqual([3, 4, true, false, 30]);
  });
});

/* -------------------------------------------------------------- JSON diff */

describe("diffJson", () => {
  test("equal values, including reordered object keys, produce no ops", () => {
    expect(diffJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }).ops).toEqual([]);
  });

  test("object add / remove / replace with JSON pointers", () => {
    const { ops } = diffJson({ a: 1, gone: true, "x/y": 1 }, { a: 2, "x/y": 1, fresh: "n" });
    expect(ops).toEqual([
      { op: "replace", path: "/a", a: 1, b: 2 },
      { op: "remove", path: "/gone", a: true },
      { op: "add", path: "/fresh", b: "n" },
    ]);
    expect(diffJson({ "a/b~c": 1 }, { "a/b~c": 2 }).ops[0]!.path).toBe("/a~1b~0c");
  });

  test("type changes are one op each, nested ones included", () => {
    const { ops } = diffJson(
      { n: 1, list: [1, 2], obj: { k: 1 }, v: "x", z: null },
      { n: "1", list: { 0: 1 }, obj: [1], v: null, z: 0 },
    );
    expect(ops).toEqual([
      { op: "type", path: "/n", a: 1, b: "1", aType: "number", bType: "string" },
      { op: "type", path: "/list", a: [1, 2], b: { 0: 1 }, aType: "array", bType: "object" },
      { op: "type", path: "/obj", a: { k: 1 }, b: [1], aType: "object", bType: "array" },
      { op: "type", path: "/v", a: "x", b: null, aType: "string", bType: "null" },
      { op: "type", path: "/z", a: null, b: 0, aType: "null", bType: "number" },
    ]);
    expect(diffJson([1], { a: 1 }).ops[0]).toMatchObject({ op: "type", path: "", aType: "array", bType: "object" });
  });

  test("arrays: an insertion is one add, a removal one remove, a modified item diffs inside", () => {
    expect(diffJson([1, 2, 3], [0, 1, 2, 3]).ops).toEqual([{ op: "add", path: "/0", b: 0 }]);
    expect(diffJson([1, 2, 3], [1, 3]).ops).toEqual([{ op: "remove", path: "/1", a: 2 }]);
    const items = [
      { id: 1, price: 10 },
      { id: 2, price: 20 },
    ];
    expect(diffJson(items, [{ id: 1, price: 10 }, { id: 2, price: 25 }, { id: 3 }]).ops).toEqual([
      { op: "replace", path: "/1/price", a: 20, b: 25 },
      { op: "add", path: "/2", b: { id: 3 } },
    ]);
    expect(diffJson({ tags: ["a"] }, { tags: [] }).ops).toEqual([{ op: "remove", path: "/tags/0", a: "a" }]);
  });

  test("redacted keys are compared but never echoed", () => {
    const { ops } = diffJson({ token: "abc", user: { password: "p1" } }, { token: "xyz", user: { password: "p1" } });
    expect(ops).toEqual([{ op: "replace", path: "/token", a: "[redacted]", b: "[redacted]" }]);
    expect(diffJson({}, { apiSecret: "s" }, { redactor }).ops).toEqual([
      { op: "add", path: "/apiSecret", b: "[redacted]" },
    ]);
    expect(diffJson({ token: { v: 1 } }, {}).ops).toEqual([{ op: "remove", path: "/token", a: "[redacted]" }]);
  });

  test("caps at MAX_DIFF_OPS and says so", () => {
    const a = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    const b = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i + 1]));
    const d = diffJson(a, b);
    expect(d.ops).toHaveLength(MAX_DIFF_OPS);
    expect(d.truncated).toBe(true);
    expect(diffJson(a, b, { maxOps: 5 }).ops).toHaveLength(5);
  });
});

/* ------------------------------------------------------- headers + bodies */

describe("headers and bodies", () => {
  test("header diff is case-insensitive, skips volatile headers and masks secrets", () => {
    const d = diffHeaders(
      { "Content-Type": "application/json", date: "Mon", authorization: "Bear… [redacted]", "x-a": "1" },
      { "content-type": "application/json", date: "Tue", authorization: "Bear… [redacted] 2", "x-b": "2" },
      redactor,
    );
    expect(d.ops).toEqual([
      { op: "replace", name: "authorization", a: "[redacted]", b: "[redacted]" },
      { op: "remove", name: "x-a", a: "1" },
      { op: "add", name: "x-b", b: "2" },
    ]);
    expect(diffHeaders({ date: "a" }, { date: "b" }).same).toBe(true);
  });

  test("bodies: json, text, binary, mixed, none, partial", () => {
    expect(diffBodies(undefined, undefined)).toMatchObject({ mode: "none", same: true });
    const j = diffBodies({ size: 7, json: { a: 1 } }, { size: 7, json: { a: 2 }, truncated: true });
    expect(j).toMatchObject({ mode: "json", same: false, partial: true, aSize: 7, bSize: 7 });
    expect(j.ops).toEqual([{ op: "replace", path: "/a", a: 1, b: 2 }]);
    expect(diffBodies({ size: 2, text: "hi" }, { size: 2, text: "hi" })).toMatchObject({ mode: "text", same: true });
    const t = diffBodies({ size: 2, text: "hi" }, { size: 3, text: "x".repeat(500) });
    expect(t.ops[0]!.b).toMatch(/\(\+300 chars\)$/);
    expect(diffBodies({ size: 4, binary: true }, { size: 4, binary: true })).toMatchObject({
      mode: "binary",
      same: true,
    });
    expect(diffBodies({ size: 4, json: {} }, { size: 2, text: "ok" }).ops[0]).toMatchObject({
      op: "type",
      aType: "object",
      bType: "string",
    });
    expect(diffBodies(undefined, { size: 2, text: "ok" })).toMatchObject({
      mode: "mixed",
      ops: [{ op: "add", path: "", b: "ok" }],
    });
  });

  test("compareTraces diffs request and response headers and bodies", () => {
    const a = queries("a", 1, undefined, {
      response: { headers: { "x-cache": "HIT" }, body: { size: 9, json: { items: [1, 2] } } },
    });
    const b = queries("b", 1, undefined, {
      status: 500,
      response: { headers: { "x-cache": "MISS" }, body: { size: 9, json: { error: "boom" } } },
    });
    const r = compareTraces(a, b);
    expect(r.response.status).toEqual({ a: 200, b: 500 });
    expect(r.response.headers.ops).toEqual([{ op: "replace", name: "x-cache", a: "HIT", b: "MISS" }]);
    expect(r.response.body.ops.map((o) => o.op)).toEqual(["remove", "add"]);
    expect(r.request.body.mode).toBe("none");
  });
});

/* ---------------------------------------------------------------- pinning */

describe("TraceStore pinning", () => {
  const add = (store: TraceStore, id: string) => store.add(makeTrace([], { id }), { rawHeaders: {} });

  test("a pinned trace survives 300 newer requests; unpinned ones rotate", () => {
    const store = new TraceStore(300);
    add(store, "keep");
    add(store, "drop");
    expect(store.pin("keep")).toBe(true);
    for (let i = 0; i < 300; i++) add(store, `n${i}`);
    expect(store.get("keep")).toBeDefined();
    expect(store.get("drop")).toBeUndefined();
    expect(store.get("n0")).toBeDefined();
    expect(store.records()).toHaveLength(301); // max unpinned + the pin
    store.unpin("keep");
    add(store, "next");
    expect(store.get("keep")).toBeUndefined();
    expect(store.records()).toHaveLength(300);
  });

  test("pins are capped: the oldest pin is released and rotates out", () => {
    const store = new TraceStore(5, undefined, 2);
    for (const id of ["a", "b", "c"]) add(store, id);
    store.pin("a");
    store.pin("b");
    store.pin("a"); // refresh: b is now the oldest pin
    store.pin("c");
    expect(store.pinned()).toEqual(["a", "c"]);
    for (let i = 0; i < 10; i++) add(store, `n${i}`);
    expect(store.get("a")).toBeDefined();
    expect(store.get("c")).toBeDefined();
    expect(store.get("b")).toBeUndefined();
    expect(store.records()).toHaveLength(7);
  });

  test("a manual pin (p) is never released by compare's automatic pins", () => {
    const store = new TraceStore(5, undefined, 2);
    for (const id of ["mine", "a", "b", "c", "d"]) add(store, id);
    store.pin("mine", { manual: true });
    for (const id of ["a", "b", "c", "d"]) store.pin(id); // two compares' worth of auto pins, past the cap
    expect(store.isPinned("mine")).toBe(true);
    expect(store.manuallyPinned()).toEqual(["mine"]);
    expect(store.pinned()).toEqual(["c", "d", "mine"]);
    store.pin("mine"); // compare opened on it: stays manual
    expect(store.manuallyPinned()).toEqual(["mine"]);
    for (let i = 0; i < 20; i++) add(store, `n${i}`);
    expect(store.get("mine")).toBeDefined();
    expect(store.records()).toHaveLength(8); // max + 2 auto + 1 manual
    expect(store.unpin("mine")).toBe(true);
    expect(store.isPinned("mine")).toBe(false);
  });

  test("only retained traces can be pinned; clear() drops pins", () => {
    const store = new TraceStore(3);
    expect(store.pin("ghost")).toBe(false);
    add(store, "a");
    store.pin("a");
    expect(store.isPinned("a")).toBe(true);
    store.clear();
    expect(store.pinned()).toEqual([]);
    add(store, "a2");
    expect(store.isPinned("a")).toBe(false);
  });
});

/* -------------------------------------------------------------- baselines */

describe("findBaselines", () => {
  test("previous build, previous same URL, route median (warm)", () => {
    const t = (id: string, startedAt: number, duration: number, epoch: number, extra: Partial<TraceRecord> = {}) => {
      const x = makeTrace([], { id, startedAt, duration, ...extra });
      x.facts = {
        time: { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 },
        reqBytes: 0,
        resBytes: 0,
        counts: { spans: 0, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 },
        cold: id === "cold",
        compileMs: 0,
        droppedSpans: 0,
        epoch,
      };
      return x;
    };
    const page2 = { url: "/api/products?page=2" };
    const cold = t("cold", 0, 900, 1);
    const e1 = t("e1", 1, 40, 1, page2);
    const e2a = t("e2a", 2, 50, 2, page2);
    const e2b = t("e2b", 3, 60, 2);
    const other = t("other", 4, 5, 2, { route: "/api/other", path: "/api/other", url: "/api/other" });
    const subject = t("subj", 5, 95, 2, page2);
    const later = t("later", 6, 45, 2);
    const records = [later, subject, other, e2b, e2a, e1, cold]; // newest first, like TraceStore.records()
    // The subject's own URL variant (?page=2) first: warm 40 50 -> lower median 40 (`e1`); the 900ms
    // cold one is ignored, and the bare /api/products requests are a different variant.
    expect(findBaselines(records, subject).map((x) => [x.kind, x.id])).toEqual([
      ["previous-build", "e1"],
      ["previous-url", "e2a"],
      ["route-median", "e1"],
    ]);
    // A variant with no other requests falls back to the whole route: warm 40 45 50 60 95 -> 50 (`e2a`).
    const lone = t("lone", 7, 70, 2, { url: "/api/products?page=9" });
    expect(findBaselines([lone, ...records], lone).find((x) => x.kind === "route-median")?.id).toBe("e2a");
  });

  test("route median prefers the subject's URL variant (?mode=n1 is not judged by ?mode=batch)", () => {
    const mk = (id: string, startedAt: number, duration: number, url: string) =>
      makeTrace([], { id, startedAt, duration, url, path: "/api/products", route: "/api/products" });
    const batch = [mk("b1", 1, 50, "/api/products?mode=batch"), mk("b2", 2, 55, "/api/products?mode=batch")];
    const n1 = [mk("n1", 3, 200, "/api/products?mode=n1"), mk("n2", 4, 210, "/api/products?mode=n1")];
    const subject = mk("s", 5, 220, "/api/products?mode=n1");
    const records = [subject, ...n1.reverse(), ...batch.reverse()];
    expect(findBaselines(records, subject).find((x) => x.kind === "route-median")?.url).toBe("/api/products?mode=n1");
  });

  test("nothing to compare against: empty list", () => {
    const only = makeTrace([], { id: "x" });
    expect(findBaselines([only], only)).toEqual([]);
  });
});

/* ------------------------------------------------------------ HTTP endpoint */

describe("GET /api/compare", () => {
  const store = new TraceStore(300);
  const rt = { options: {}, store, redactor } as unknown as Runtime;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    store.add(queries("A", 1, undefined, { startedAt: 1 }), { rawHeaders: { authorization: "Bearer real-secret" } });
    store.add(queries("B", 50, undefined, { startedAt: 2 }), { rawHeaders: {} });
    server = http.createServer((req, res) => {
      handleUi(rt, req, res).catch((err) => sendJson(res, 500, { error: String(err) }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__hoplens`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test("returns the diff and pins both traces", async () => {
    const res = await fetch(`${base}/api/compare?a=A&b=B`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as any;
    expect(body.a.id).toBe("A");
    expect(body.b.id).toBe("B");
    expect(body.sameRoute).toBe(true);
    expect(body.summary.sentence).toContain("x1 -> x50");
    expect(JSON.stringify(body)).not.toContain("real-secret");
    expect(store.pinned()).toEqual(["A", "B"]);
    const other = { route: "/api/other", path: "/api/other", url: "/api/other" };
    for (let i = 0; i < 300; i++) store.add(makeTrace([], { id: `n${i}`, ...other }), { rawHeaders: {} });
    expect((await fetch(`${base}/api/compare?a=A&b=B`)).status).toBe(200);
  });

  test("400 without both ids, 404 names the missing side", async () => {
    expect((await fetch(`${base}/api/compare?a=A`)).status).toBe(400);
    const res = await fetch(`${base}/api/compare?a=A&b=nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).missing).toEqual(["b"]);
  });

  test("baselines and unpin", async () => {
    const res = await fetch(`${base}/api/compare/baselines?b=B`);
    expect(res.status).toBe(200);
    // No epochs in these fixtures: previous same URL and the route median, both A.
    expect(((await res.json()) as any).baselines.map((x: { kind: string; id: string }) => [x.kind, x.id])).toEqual([
      ["previous-url", "A"],
      ["route-median", "A"],
    ]);
    expect((await fetch(`${base}/api/compare/baselines`)).status).toBe(400);
    const del = await fetch(`${base}/api/compare/pins/A`, { method: "DELETE" });
    expect((await del.json()) as unknown).toEqual({ unpinned: true });
    expect(store.isPinned("A")).toBe(false);
  });

  test("pin one trace, list pins, 404 for an unknown id", async () => {
    const res = await fetch(`${base}/api/compare/pins/A`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).pinned).toBe(true);
    expect(store.isPinned("A")).toBe(true);
    const list = (await (await fetch(`${base}/api/compare/pins`)).json()) as any;
    expect(list.pinned).toContain("A");
    expect(list.manual).toEqual(["A"]);
    expect((await fetch(`${base}/api/compare/pins/nope`, { method: "POST" })).status).toBe(404);
  });
});

describe("summaryDirection (aligned with the UI tones: max(20%, 5ms))", () => {
  test("under 5ms is the same, however large in percent", () => {
    expect(summaryDirection(2, 6.9)).toBe("same");
    expect(summaryDirection(2, 7)).toBe("slower");
  });
  test("under 20% of A is the same, however large in ms", () => {
    expect(summaryDirection(1000, 1199)).toBe("same");
    expect(summaryDirection(1000, 1200)).toBe("slower");
    expect(summaryDirection(1000, 800)).toBe("faster");
    expect(summaryDirection(1000, 801)).toBe("same");
  });
  test("A = 0 falls back to the 5ms floor", () => {
    expect(summaryDirection(0, 4)).toBe("same");
    expect(summaryDirection(0, 5)).toBe("slower");
  });
});
