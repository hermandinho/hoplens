import { describe, expect, test } from "vitest";
import type { Finding, SpanRecord, StatsResponse, TraceFacts, TraceRecord, TraceSummary } from "../src/api/types";
import {
  findingSentence,
  firstAppFrame,
  lookGroups,
  traceBaselines,
  urlVariantKey,
  verdictFor,
  verdictLine,
} from "../src/state/verdict";

/*
 * Verdict grammar (plan 3.7), one block per rule, plus "where to look" grouping and baselines.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/verdict.test.ts (vitest is a root devDependency).
 */

let seq = 0;
function span(p: Partial<SpanRecord> & Pick<SpanRecord, "kind">): SpanRecord {
  return { id: `s${++seq}`, name: p.kind, start: 0, end: 0, attrs: {}, ...p };
}

function facts(over: Partial<TraceFacts> = {}): TraceFacts {
  return {
    time: { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 },
    reqBytes: 0,
    resBytes: 0,
    counts: { spans: 0, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 },
    cold: false,
    compileMs: 0,
    droppedSpans: 0,
    epoch: 0,
    ...over,
  };
}

function trace(over: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: `t${++seq}`,
    startedAt: 0,
    duration: 100,
    done: true,
    method: "GET",
    url: "/api/feed?fast=0",
    path: "/api/feed",
    route: "/api/feed",
    kind: "route",
    status: 200,
    request: { headers: {} },
    response: { headers: {} },
    spans: [],
    logs: [],
    ...over,
  };
}

/** /api/feed: the handler loops getUser() over 10 posts, each one fetch. */
function feedTrace() {
  const root = span({ kind: "request", name: "GET /api/feed", start: 0, end: 323 });
  const handler = span({ kind: "handler", name: "GET /api/feed", parentId: root.id, start: 2, end: 320 });
  const spans: SpanRecord[] = [root, handler];
  const fetchIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const w = span({ kind: "function", name: "getUser", parentId: handler.id, start: 40 + i * 25, end: 64 + i * 25 });
    const f = span({
      kind: "fetch",
      name: "fetch GET https://jsonplaceholder.typicode.com/users/1",
      parentId: w.id,
      start: 41 + i * 25,
      end: 63 + i * 25,
      attrs: { "url.full": `https://jsonplaceholder.typicode.com/users/${i + 1}`, "http.method": "GET" },
      location: { file: "src/lib/external.ts", line: 63 },
    });
    spans.push(w, f);
    fetchIds.push(f.id);
  }
  const finding: Finding = {
    rule: "n-plus-1",
    severity: "warn",
    title: "route handler fetched GET jsonplaceholder.typicode.com/users/:id x10 via getUser() (N+1)",
    fingerprint: "fp1",
    spanIds: fetchIds,
    fn: "route handler",
    location: { file: "src/lib/external.ts", line: 63 },
    count: 10,
    estSavedMs: 173,
  };
  return trace({
    duration: 323,
    spans,
    findings: [finding],
    facts: facts({ time: { db: 0, cache: 0, ext: 253, fn: 40, framework: 20, compile: 0, idle: 10 } }),
  });
}

describe("verdict rule 2: swallowed error", () => {
  test("a thrown error caught behind a 200 is the verdict, ahead of any performance finding", () => {
    const fetchSpan = span({ kind: "fetch", name: "fetch GET https://inventory.test/stock", start: 5, end: 60 });
    const swallowed: Finding = {
      rule: "swallowed-error",
      severity: "warn",
      title: "fetchInventory failed (UpstreamError: inventory timed out) but the response was 200",
      fingerprint: "fp-sw",
      spanIds: [fetchSpan.id],
      fn: "fetchInventory",
      location: { file: "src/lib/external.ts", line: 206 },
      count: 1,
    };
    const slow: Finding = { ...feedTrace().findings![0]!, estSavedMs: 80 };
    const v = verdictFor(trace({ duration: 120, spans: [fetchSpan], findings: [slow, swallowed], facts: facts() }));
    expect(v.rule).toBe("swallowed");
    expect(v.tone).toBe("fail");
    expect(v.text).toBe(
      "Failed silently: fetchInventory() threw UpstreamError: inventory timed out but responded 200 at external.ts:206.",
    );
    expect(v.spanIds).toEqual([fetchSpan.id]);
    expect(v.location?.line).toBe(206);
  });

  test("an error typed by a numeric DOMException code is quoted by its message", () => {
    const sw: Finding = {
      rule: "swallowed-error",
      severity: "warn",
      title:
        "fetch GET https://x.test/a failed (23: The operation was aborted due to timeout) but the response was 200",
      fingerprint: "fp-23",
      spanIds: [],
      fn: "fetchInventory",
      count: 1,
    };
    expect(verdictFor(trace({ duration: 900, findings: [sw], facts: facts() })).text).toBe(
      'Failed silently: fetchInventory() threw "The operation was aborted due to timeout" but responded 200.',
    );
  });

  test("an HTTP-status-only fetch failure (info) does not take the verdict", () => {
    const sw: Finding = {
      rule: "swallowed-error",
      severity: "info",
      title: "fetch GET https://x.test/a failed (FetchError: HTTP 404) but the response was 200",
      fingerprint: "fp-404",
      spanIds: [],
      count: 1,
    };
    expect(verdictFor(trace({ duration: 20, findings: [sw], facts: facts() })).rule).toBe("fast");
  });
});

describe("verdict rule 1: cold wait", () => {
  test("names the wait and the handler time when the wait is > 40%", () => {
    const root = span({ kind: "request", start: 0, end: 2370 });
    const handler = span({ kind: "handler", parentId: root.id, start: 2040, end: 2370 });
    const t = trace({
      duration: 2370,
      spans: [root, handler],
      facts: facts({ cold: true, preHandlerMs: 2040 }),
      findings: [{ ...feedTrace().findings![0]!, estSavedMs: 500 }],
    });
    const v = verdictFor(t);
    expect(v.rule).toBe("cold");
    expect(v.text).toBe("Waited 2.04s before the handler (cold: likely dev compile). Handler itself took 330ms.");
    expect(v.zoom).toBe("handler");
    expect(v.spanIds).toEqual([handler.id]);
  });

  test("derives the wait from spans when facts lack preHandlerMs", () => {
    const handler = span({ kind: "handler", start: 900, end: 1000 });
    const v = verdictFor(trace({ duration: 1000, spans: [handler], facts: facts({ cold: true }) }));
    expect(v.rule).toBe("cold");
    expect(v.text).toContain("Waited 900ms");
  });

  test("a warm request never gets the cold verdict", () => {
    const handler = span({ kind: "handler", start: 900, end: 1000 });
    const v = verdictFor(trace({ duration: 1000, spans: [handler], facts: facts({ cold: false, preHandlerMs: 900 }) }));
    expect(v.rule).not.toBe("cold");
  });

  test("a short wait (<= 40%) is not the verdict", () => {
    const handler = span({ kind: "handler", start: 30, end: 100 });
    const v = verdictFor(trace({ duration: 100, spans: [handler], facts: facts({ cold: true, preHandlerMs: 30 }) }));
    expect(v.rule).not.toBe("cold");
  });
});

describe("verdict rule 2: top finding", () => {
  test("/api/feed names getUser, the count and the location", () => {
    const v = verdictFor(feedTrace());
    expect(v.rule).toBe("finding");
    expect(v.tone).toBe("slow");
    expect(v.text).toBe("Slow because getUser() ran 10 fetches in a loop (N+1).");
    expect(verdictLine(v)).toBe(
      "Slow because getUser() ran 10 fetches in a loop (N+1). · ~173ms saveable · src/lib/external.ts:63",
    );
    expect(v.repeat).toBe(10);
    expect(v.perCallMs).toBeCloseTo(22);
    // The 10 fetches plus the 10 getUser() calls they ran in, so the folded "x10 getUser" row lights up.
    expect(v.spanIds).toHaveLength(20);
    expect(v.callee).toBe("getUser");
  });

  test("picks the finding with the largest saving, not the first", () => {
    const t = feedTrace();
    const small: Finding = {
      rule: "slow-fn",
      severity: "error",
      title: "render spent 12ms in its own code (4% of the request)",
      fingerprint: "fp0",
      spanIds: [],
      estSavedMs: 12,
    };
    t.findings = [small, ...t.findings!];
    expect(verdictFor(t).finding?.fingerprint).toBe("fp1");
  });

  test("says Failed on a 5xx", () => {
    const t = feedTrace();
    t.status = 500;
    expect(verdictFor(t).text.startsWith("Failed because getUser()")).toBe(true);
    expect(verdictFor(t).tone).toBe("fail");
  });

  test("a saving under 10ms is not the verdict", () => {
    const t = feedTrace();
    t.findings![0]!.estSavedMs = 9;
    expect(verdictFor(t).rule).not.toBe("finding");
  });

  test("finds the per-item wrapper from the spans when the title has no 'via'", () => {
    const t = feedTrace();
    t.findings![0]!.title = "route handler fetched GET jsonplaceholder.typicode.com/users/:id x10 (N+1)";
    expect(verdictFor(t).text).toBe("Slow because getUser() ran 10 fetches in a loop (N+1).");
  });

  test("each rule has a sentence", () => {
    const s = (f: Pick<Finding, "rule" | "title" | "fn" | "count">) => findingSentence(f);
    expect(
      s({
        rule: "n-plus-1",
        title: "listProducts ran SELECT * FROM r WHERE id = ? x12 (N+1)",
        fn: "listProducts",
        count: 12,
      }),
    ).toBe("listProducts() ran 12 queries in a loop (N+1)");
    expect(s({ rule: "n-plus-1", title: "request ran SELECT 1 x5 (N+1)", count: 5 })).toBe(
      "the request ran 5 queries in a loop (N+1)",
    );
    expect(s({ rule: "duplicate", title: "GET api.x.com/a ran x3 with identical url", count: 3 })).toBe(
      "GET api.x.com/a ran 3 times with the same url",
    );
    expect(s({ rule: "parallelizable", title: "loadPage: 3 sequential calls could run in parallel", count: 3 })).toBe(
      "loadPage() made 3 calls one after another that could run in parallel",
    );
    expect(s({ rule: "fetch-uncached", title: "fetch api.x.com/a not cached (no-store) x4", count: 4 })).toBe(
      "fetch api.x.com/a skips Next's data cache (4 calls)",
    );
    expect(s({ rule: "large-payload", title: "Response body is 3.2MB" })).toBe("the Response body is 3.2MB");
    expect(
      s({
        rule: "swallowed-error",
        title: "fetch GET httpbin.org failed (TypeError: fetch failed) but the response was 200",
      }),
    ).toBe("fetch GET httpbin.org failed (TypeError: fetch failed) and the error was swallowed");
    expect(s({ rule: "slow-fn", title: "computeTotals spent 140ms in its own code (60% of the request)" })).toBe(
      "computeTotals() spent 140ms in its own code (60%)",
    );
    expect(s({ rule: "cold-compile", title: "Compiled for 1.2s" })).toBe(
      "the dev compile ran first (compiled for 1.2s)",
    );
    expect(s({ rule: "logs-on-success", title: "2 logs on a 200: hello" })).toBe("2 logs on a 200: hello");
  });
});

describe("verdict rule 3: failed request", () => {
  test("names status, message and the first app frame", () => {
    const t = trace({
      status: 500,
      duration: 80,
      error: {
        type: "Error",
        message: "boom",
        stack:
          "Error: boom\n    at x (node_modules/next/dist/a.js:1:1)\n    at fetchFlaky (src/lib/flaky.ts:12:9)\n    at y (src/z.ts:1:1)",
      },
    });
    const v = verdictFor(t);
    expect(v.rule).toBe("error");
    expect(v.text).toBe("Failed with 500: Error: boom at flaky.ts:12.");
    expect(v.location).toMatchObject({ file: "src/lib/flaky.ts", line: 12 });
  });

  test("a 503 with no error object", () => {
    expect(verdictFor(trace({ status: 503 })).text).toBe("Failed with 503.");
  });

  test("a handled error on a 200 is not a failure", () => {
    const v = verdictFor(trace({ status: 200, duration: 20, error: { type: "E", message: "m", stack: "" } }));
    expect(v.rule).toBe("fast");
  });

  test("firstAppFrame skips framework-tagged frames", () => {
    expect(firstAppFrame("at a (src/a.ts:1:2) [framework]\nat b (src/b.ts:3:4)")).toEqual({
      file: "src/b.ts",
      line: 3,
      column: 4,
    });
  });
});

describe("verdict rule 4: largest bucket / fast", () => {
  test("fast below 50ms", () => {
    expect(verdictFor(trace({ duration: 8.5 })).text).toBe("Fast: 8.5ms, nothing to fix.");
  });

  test("mostly the largest bucket with its count", () => {
    const t = trace({
      duration: 130,
      facts: facts({
        time: { db: 94, cache: 0, ext: 0, fn: 20, framework: 10, compile: 0, idle: 6 },
        counts: { spans: 14, db: 12, fetch: 0, cache: 0, fn: 1, warn: 0, error: 0 },
      }),
    });
    expect(verdictFor(t).text).toBe("Mostly database: 12 queries, 72%.");
  });

  test("a running request is pending", () => {
    expect(verdictFor(trace({ done: false, duration: undefined })).rule).toBe("pending");
  });
});

describe("where to look", () => {
  test("12 identical queries are one grouped row", () => {
    const root = span({ kind: "request", start: 0, end: 130 });
    const handler = span({ kind: "handler", parentId: root.id, start: 1, end: 129 });
    const spans = [root, handler];
    for (let i = 0; i < 12; i++)
      spans.push(
        span({
          kind: "db",
          name: "pg.query",
          parentId: handler.id,
          start: 5 + i * 10,
          end: 13 + i * 10,
          attrs: { "db.statement": `SELECT * FROM ratings WHERE product_id = ${i}` },
          location: { file: "src/lib/db.ts", line: 213 },
        }),
      );
    const rows = lookGroups(trace({ duration: 130, spans }));
    expect(rows[0]).toMatchObject({ count: 12, label: "pg.query", location: { file: "src/lib/db.ts", line: 213 } });
    expect(rows[0]!.detail).toBe("SELECT * FROM ratings WHERE product_id = ?");
    expect(rows[0]!.ms).toBe(96);
    expect(rows.filter((r) => r.label === "pg.query")).toHaveLength(1);
  });

  test("/api/feed: one 10x fetch row tagged with its finding", () => {
    const rows = lookGroups(feedTrace());
    const f = rows.find((r) => r.kind === "fetch");
    expect(f).toMatchObject({ count: 10, label: "fetch", rule: "n-plus-1" });
    expect(f!.detail).toBe("GET jsonplaceholder.typicode.com/users/:id");
    expect(rows[0]!.kind).toBe("fetch");
  });
});

describe("baselines", () => {
  const stats = (variants: { url: string; p50: number; warm: number }[], epochs = [0]): StatsResponse => ({
    routes: [
      {
        key: "GET /api/feed",
        method: "GET",
        route: "/api/feed",
        kind: "route",
        lastSeen: 0,
        current: { epoch: 0, count: 5, errors: 0, cold: 0, warm: 5, p50: 400, findings: [], firstSeen: 0, lastSeen: 0 },
        all: { epoch: -1, count: 5, errors: 0, cold: 0, warm: 5, p50: 400, findings: [], firstSeen: 0, lastSeen: 0 },
        epochs: epochs.map((e) => ({
          epoch: e,
          count: 5,
          errors: 0,
          cold: 0,
          warm: 5,
          p50: 400,
          findings: [],
          firstSeen: 0,
          lastSeen: 0,
          variants: variants.map((v) => ({
            ...v,
            count: v.warm,
            p50: v.p50 + (epochs.length > 1 && e === 0 ? -71 : 0),
          })),
        })),
      },
    ],
    totals: { requests: 5, errors: 0, cold: 0, routes: 1, droppedSpans: 0 },
    epoch: Math.max(...epochs),
    since: 0,
  });

  test("?fast=1 is not part of the ?fast=0 baseline", () => {
    const t = trace({ duration: 323, url: "/api/feed?fast=0", facts: facts() });
    const b = traceBaselines(
      t,
      stats([
        { url: "/api/feed?fast=0", p50: 310, warm: 3 },
        { url: "/api/feed?fast=1", p50: 611, warm: 2 },
      ]),
    );
    expect(b[0]).toMatchObject({ kind: "url", p50: 310, n: 3, deltaMs: 13, small: true });
    expect(b[1]).toMatchObject({ kind: "route", p50: 400 });
  });

  test("before edit uses the same URL in the previous epoch", () => {
    const t = trace({ duration: 323, url: "/api/feed?fast=0", facts: facts({ epoch: 7 }) });
    const b = traceBaselines(t, stats([{ url: "/api/feed?fast=0", p50: 310, warm: 3 }], [7, 0]));
    expect(b.map((x) => x.kind)).toEqual(["url", "edit"]);
    expect(b[1]).toMatchObject({ p50: 239, deltaMs: 84, epoch: 0 });
  });

  test("falls back to this tab's traces for the same URL", () => {
    const t = trace({ duration: 300, url: "/api/feed?fast=0" });
    const sum = (url: string, duration: number): TraceSummary => ({
      id: `x${++seq}`,
      startedAt: 0,
      duration,
      done: true,
      method: "GET",
      path: "/api/feed",
      url,
      route: "/api/feed",
      kind: "route",
      status: 200,
      hops: 1,
      facts: facts(),
    });
    const b = traceBaselines(t, null, [sum("/api/feed?fast=0", 200), sum("/api/feed?fast=1", 900)]);
    expect(b[0]).toMatchObject({ kind: "url", p50: 200, n: 1, source: "client" });
    expect(b[1]).toMatchObject({ kind: "route" });
  });

  test("a warm subject is not part of its own same-URL baseline when this tab has the other samples", () => {
    const t = trace({ id: "self", duration: 400, url: "/api/feed?fast=0", facts: facts({ epoch: 0 }) });
    const sum = (id: string, duration: number): TraceSummary => ({
      id,
      startedAt: 0,
      duration,
      done: true,
      method: "GET",
      path: "/api/feed",
      url: "/api/feed?fast=0",
      route: "/api/feed",
      kind: "route",
      status: 200,
      hops: 1,
      facts: facts({ epoch: 0 }),
    });
    const local = [sum("self", 400), sum("a", 100), sum("b", 200)];
    // Server: 3 warm samples, the subject among them.
    const b = traceBaselines(t, stats([{ url: "/api/feed?fast=0", p50: 200, warm: 3 }]), local);
    expect(b[0]).toMatchObject({ kind: "url", p50: 150, n: 2, source: "client" });
    expect(b[0]?.includesSelf).toBeUndefined();
    // Without the other samples in this tab, the server number stays and says it includes this one.
    const c = traceBaselines(t, stats([{ url: "/api/feed?fast=0", p50: 200, warm: 3 }]), []);
    expect(c[0]).toMatchObject({ kind: "url", p50: 200, n: 3, source: "server", includesSelf: true });
  });

  test("urlVariantKey matches core's", () => {
    expect(urlVariantKey("/api/x?b=2&a=1#f")).toBe("/api/x?a=1&b=2");
  });
});
