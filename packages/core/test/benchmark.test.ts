// Overhead budget (AGENTS.md: < 2 ms per request). Kept out of `pnpm test` (see package.json) so a
// parallel test runner competing for the CPU can't fail it; run it alone with `pnpm bench`.
import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import { serverTimingValue } from "../src/capture";
import { computeFacts } from "../src/facts";
import { analyze } from "../src/insights";
import { QueryStatsStore } from "../src/queries";
import { RouteStatsStore } from "../src/stats";
import type { SpanRecord, TraceRecord } from "../src/types";
import { db, fetchSpan, makeTrace, skeleton, span } from "./helpers";

describe("perf budget", () => {
  test("computeFacts + analyze on a 200-span trace average < 2ms", () => {
    const build = (): TraceRecord => {
      const { root, handler, fn } = skeleton(1000);
      const spans: SpanRecord[] = [root, handler, fn];
      for (let i = 0; i < 49; i++) {
        const f = span({ kind: "function", name: `fn${i % 7}`, parentId: fn.id, start: 5 + i * 19, end: 22 + i * 19 });
        spans.push(
          f,
          db(f.id, f.start + 1, f.start + 5, `SELECT * FROM t${i % 5} WHERE id = ${i}`),
          fetchSpan(f.id, f.start + 6, f.start + 12, `https://api.example.com/items/${i}`, {
            "hoplens.fetch.cache": "no-store",
          }),
          db(f.id, f.start + 12, f.start + 16, "GET k", {
            attrs: { "db.system": "redis", "db.statement": `GET k${i}` },
          }),
        );
      }
      spans.push(span({ kind: "response", parentId: root.id, start: 999, end: 1000 }));
      return makeTrace(spans, { duration: 1000, logs: [{ t: 1, level: "warn", text: "w" }] });
    };
    expect(build().spans.length).toBe(200);
    for (let i = 0; i < 50; i++) {
      const t = build();
      analyze(t, computeFacts(t)); // warm up the JIT
    }
    // Fresh traces each iteration so per-span memoization can't make later iterations free. Best of 5
    // batch averages: this measures our cost, not a parallel test runner hogging the CPU.
    const batches: number[] = [];
    for (let b = 0; b < 5; b++) {
      const traces = Array.from({ length: 40 }, build);
      const t0 = performance.now();
      for (const t of traces) analyze(t, computeFacts(t));
      batches.push((performance.now() - t0) / traces.length);
    }
    const avg = Math.min(...batches);
    expect(avg, `avg ${avg.toFixed(3)}ms (batches ${batches.map((x) => x.toFixed(2)).join(", ")})`).toBeLessThan(2);
  });

  // Everything Hoplens does per request: Server-Timing on the response path, then (after the response
  // finished) facts, findings, and the Phase 2 route + query aggregates.
  test("whole per-request pipeline on a 200-span trace average < 2ms; Server-Timing alone < 0.5ms", () => {
    const build = (): TraceRecord => {
      const { root, handler, fn } = skeleton(1000);
      const spans: SpanRecord[] = [root, handler, fn];
      for (let i = 0; i < 49; i++) {
        const f = span({ kind: "function", name: `fn${i % 7}`, parentId: fn.id, start: 5 + i * 19, end: 22 + i * 19 });
        spans.push(
          f,
          db(f.id, f.start + 1, f.start + 5, `SELECT * FROM t${i % 5} WHERE id = ${i}`),
          fetchSpan(f.id, f.start + 6, f.start + 12, `https://api.example.com/items/${i}`, {
            "hoplens.fetch.cache": "no-store",
          }),
          db(f.id, f.start + 12, f.start + 16, "GET k", {
            attrs: { "db.system": "redis", "db.statement": `GET k${i}`, "hoplens.redis.hit": i % 2 === 0 },
          }),
        );
      }
      spans.push(span({ kind: "response", parentId: root.id, start: 999, end: 1000 }));
      return makeTrace(spans, { duration: 1000, logs: [{ t: 1, level: "warn", text: "w" }] });
    };
    const stats = new RouteStatsStore();
    const queries = new QueryStatsStore();
    const once = (t: TraceRecord) => {
      serverTimingValue(t.spans, 990);
      const facts = computeFacts(t);
      t.facts = facts;
      t.findings = analyze(t, facts);
      stats.add(t);
      queries.add(t);
    };
    for (let i = 0; i < 50; i++) once(build());
    const total: number[] = [];
    const timing: number[] = [];
    for (let b = 0; b < 5; b++) {
      const traces = Array.from({ length: 40 }, build);
      let t0 = performance.now();
      for (const t of traces) serverTimingValue(t.spans, 990);
      timing.push((performance.now() - t0) / traces.length);
      const fresh = Array.from({ length: 40 }, build);
      t0 = performance.now();
      for (const t of fresh) once(t);
      total.push((performance.now() - t0) / fresh.length);
    }
    const avg = Math.min(...total);
    const st = Math.min(...timing);
    expect(avg, `pipeline avg ${avg.toFixed(3)}ms (batches ${total.map((x) => x.toFixed(2)).join(", ")})`).toBeLessThan(
      2,
    );
    expect(st, `Server-Timing avg ${st.toFixed(3)}ms`).toBeLessThan(0.5);
  });
});
