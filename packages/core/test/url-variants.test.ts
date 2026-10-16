import { describe, expect, test } from "vitest";
import { computeFacts, preHandlerMs } from "../src/facts";
import { RouteStatsStore, urlVariantKey } from "../src/stats";
import type { TraceFacts, TraceRecord } from "../src/types";
import { makeTrace, skeleton, span } from "./helpers";

// WP2: per-URL-variant baselines in RouteStatsStore and facts.preHandlerMs.

function facts(over: Partial<TraceFacts> = {}): TraceFacts {
  return {
    time: { db: 0, cache: 0, ext: 0, fn: 10, framework: 0, compile: 0, idle: 0 },
    reqBytes: 0,
    resBytes: 0,
    counts: { spans: 1, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 },
    cold: false,
    compileMs: 0,
    droppedSpans: 0,
    epoch: 0,
    ...over,
  };
}

let seq = 0;
function req(url: string, duration: number, f: Partial<TraceFacts> = {}): TraceRecord {
  const path = url.split("?")[0]!;
  return makeTrace([], {
    id: `v${++seq}`,
    startedAt: 1000 + seq,
    duration,
    url,
    path,
    route: path,
    facts: facts(f),
  });
}

describe("urlVariantKey", () => {
  test("sorts params by key then value and drops the fragment", () => {
    expect(urlVariantKey("/api/feed?fast=1")).toBe("/api/feed?fast=1");
    expect(urlVariantKey("/api/x?b=2&a=1#frag")).toBe("/api/x?a=1&b=2");
    expect(urlVariantKey("/api/x?a=2&a=1")).toBe("/api/x?a=1&a=2");
    expect(urlVariantKey("/api/x?")).toBe("/api/x");
    expect(urlVariantKey("/api/x")).toBe("/api/x");
  });

  test("caps very long keys", () => {
    expect(urlVariantKey(`/api/x?q=${"a".repeat(500)}`).length).toBe(200);
  });
});

describe("RouteStatsStore url variants", () => {
  test("?fast=1 is not part of the ?fast=0 baseline", () => {
    const s = new RouteStatsStore();
    for (const d of [300, 310, 320]) s.add(req("/api/feed?fast=0", d));
    for (const d of [600, 610]) s.add(req("/api/feed?fast=1", d));
    const r = s.snapshot().routes[0]!;
    expect(r.key).toBe("GET /api/feed");
    expect(r.current.count).toBe(5);
    const v0 = r.current.variants?.find((v) => v.url === "/api/feed?fast=0");
    const v1 = r.current.variants?.find((v) => v.url === "/api/feed?fast=1");
    expect(v0?.count).toBe(3);
    expect(v0?.p50).toBeGreaterThanOrEqual(300);
    expect(v0?.p50).toBeLessThanOrEqual(320);
    expect(v1?.count).toBe(2);
    expect(v1?.p50).toBeGreaterThanOrEqual(600);
    // Most requests first.
    expect(r.current.variants?.[0]?.url).toBe("/api/feed?fast=0");
  });

  test("cold requests count but stay out of the variant quantiles", () => {
    const s = new RouteStatsStore();
    s.add(req("/api/feed", 2000, { cold: true }));
    s.add(req("/api/feed", 100));
    const v = s.snapshot().routes[0]!.current.variants![0]!;
    expect(v).toMatchObject({ url: "/api/feed", count: 2, warm: 1, p50: 100 });
  });

  test("caps distinct variants per route-epoch", () => {
    const s = new RouteStatsStore({ maxUrlVariants: 3 });
    for (let i = 0; i < 10; i++) s.add(req(`/api/p?id=${i}`, 10 + i));
    const r = s.snapshot().routes[0]!;
    expect(r.current.count).toBe(10);
    expect(r.current.variants).toHaveLength(3);
    expect(r.all.variants).toHaveLength(3);
  });

  test("variants are kept per epoch and merged into `all`", () => {
    const s = new RouteStatsStore();
    s.add(req("/api/feed?fast=0", 200, { epoch: 1 }));
    s.add(req("/api/feed?fast=0", 400, { epoch: 2 }));
    const r = s.snapshot().routes[0]!;
    expect(r.epochs.map((e) => e.variants?.[0]?.p50)).toEqual([400, 200]);
    expect(r.all.variants?.[0]).toMatchObject({ url: "/api/feed?fast=0", count: 2, warm: 2 });
  });
});

describe("facts.preHandlerMs", () => {
  test("is the start of the first handler span", () => {
    const root = span({ kind: "request", name: "GET /api/feed", start: 0, end: 2400 });
    const compile = span({ kind: "compile", parentId: root.id, start: 5, end: 2000 });
    const handler = span({ kind: "handler", parentId: root.id, start: 2040, end: 2370 });
    expect(preHandlerMs([root, compile, handler])).toBe(2040);
    const f = computeFacts(makeTrace([root, compile, handler], { duration: 2400 }));
    expect(f.preHandlerMs).toBe(2040);
  });

  test("is absent without a handler span", () => {
    const root = span({ kind: "request", start: 0, end: 50 });
    expect(preHandlerMs([root])).toBeUndefined();
    expect(computeFacts(makeTrace([root], { duration: 50 })).preHandlerMs).toBeUndefined();
  });

  test("a warm request waits ~nothing", () => {
    const { root, handler, fn } = skeleton(100);
    expect(computeFacts(makeTrace([root, handler, fn])).preHandlerMs).toBe(1);
  });
});
