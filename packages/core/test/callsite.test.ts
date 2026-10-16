import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { context, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, test } from "vitest";
import { callSiteOf, captureCallSite, setRecordCallSite, shouldCapture } from "../src/callsite";
import { als, installOtel, makeWrap } from "../src/capture";
import { computeFacts } from "../src/facts";
import { analyze } from "../src/insights";
import type { Runtime } from "../src/runtime";
import { makeRedactor } from "../src/serialize";
import type { SpanRecord, TraceRecord } from "../src/types";
import { fetchSpan, makeTrace, skeleton, span } from "./helpers";

const root = path.resolve(__dirname, "..");
const self = "test/callsite.test.ts";
/** The 1-based line of this file holding `marker` (so the tests don't hard-code line numbers). */
const lineOf = (marker: string) =>
  readFileSync(__filename, "utf8")
    .split("\n")
    .findIndex((l) => l.includes(marker) && !l.includes("lineOf(")) + 1;

describe("captureCallSite / callSiteOf", () => {
  test("resolves the line that called the function, not its body", () => {
    function callee() {
      return captureCallSite(callee);
    }
    const holder = callee(); // MARK-DIRECT
    const rec = {};
    setRecordCallSite(rec, holder!, root);
    expect(callSiteOf(rec)).toMatchObject({ file: self, line: lineOf("MARK-DIRECT") });
  });

  test("no frames captured -> undefined; resolved once and cached", () => {
    expect(callSiteOf({})).toBeUndefined();
    expect(callSiteOf(undefined)).toBeUndefined();
    let reads = 0;
    const holder = {
      get stack() {
        reads++;
        return "Error\n    at x (/elsewhere/not-in-root.js:1:1)";
      },
    };
    const rec = {};
    setRecordCallSite(rec, holder, root);
    expect(callSiteOf(rec)).toBeUndefined();
    expect(callSiteOf(rec)).toBeUndefined();
    expect(reads).toBe(1);
  });

  test("shouldCapture: only the 2nd call of a function under one parent", () => {
    const a = {};
    const b = {};
    const f = () => {};
    const g = () => {};
    expect([1, 2, 3, 4].map(() => shouldCapture(a, f))).toEqual([false, true, false, false]);
    expect(shouldCapture(a, g)).toBe(false);
    expect(shouldCapture(b, f)).toBe(false);
    expect(shouldCapture(b, f)).toBe(true);
  });

  test("restores Error.stackTraceLimit", () => {
    const before = Error.stackTraceLimit;
    function f() {
      return captureCallSite(f);
    }
    f();
    expect(Error.stackTraceLimit).toBe(before);
  });
});

describe("n-plus-1 through a wrapped function points at the loop line", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  test("real wrap + OTel processor: finding location is the caller of the outermost wrapper", async () => {
    const rt = { root, redactor: makeRedactor([]), store: { get: () => undefined } } as unknown as Runtime;
    expect(installOtel(rt)).toBe("own");
    const wrap = makeWrap(rt);
    const tracer = trace.getTracer("t");
    // The per-item I/O: a fetch-shaped span opened inside the wrapped function.
    const getUser = wrap(
      async (id: number) =>
        tracer.startActiveSpan(
          "fetch GET",
          { attributes: { "hoplens.kind": "fetch", "url.full": `https://api.example.com/users/${id}` } },
          (s) => s.end(),
        ),
      { name: "getUser", file: "src/users.ts", line: 3 },
    );
    const t = makeTrace([], { duration: 100 });
    await als.run({ trace: t, t0: performance.timeOrigin }, async () => {
      await tracer.startActiveSpan("buildFeed", { attributes: { "hoplens.kind": "function" } }, async (outer) => {
        for (let i = 0; i < 6; i++) {
          await getUser(i); // MARK-LOOP
        }
        outer.end();
      });
    });
    const fns = t.spans.filter((s) => s.name === "getUser");
    expect(fns).toHaveLength(6);
    const n1 = analyze(t, computeFacts(t)).filter((f) => f.rule === "n-plus-1");
    expect(n1).toHaveLength(1);
    expect(n1[0]!.title).toContain("via getUser()");
    expect(n1[0]!.location).toMatchObject({ file: self, line: lineOf("MARK-LOOP"), via: "call-site" });
  });

  test("without a captured call site the old fallback (query line, then owner) still applies", () => {
    const { root: r, handler, fn } = skeleton(400);
    const spans: SpanRecord[] = [r, handler, fn];
    for (let i = 0; i < 6; i++) {
      const w = span({ kind: "function", name: "getUser", parentId: fn.id, start: 10 + i * 30, end: 35 + i * 30 });
      spans.push(w, fetchSpan(w.id, w.start + 1, w.end - 1, `https://x.test/users/${i}`));
    }
    const t: TraceRecord = makeTrace(spans, { duration: 400 });
    const n1 = analyze(t, computeFacts(t)).filter((f) => f.rule === "n-plus-1");
    expect(n1[0]!.location).toEqual({ file: "src/lib/store.ts", line: 42 });
  });

  test("capture cost: 100 wrapped calls under 10 parents (10 captures) < 0.3ms", () => {
    function hop(parent: object) {
      return shouldCapture(parent, hop) ? captureCallSite(hop) : undefined;
    }
    for (let i = 0; i < 2000; i++) hop({});
    const runs: number[] = [];
    for (let b = 0; b < 5; b++) {
      const parents = Array.from({ length: 10 }, () => ({}));
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) hop(parents[i % 10]!);
      runs.push(performance.now() - t0);
    }
    const best = Math.min(...runs);
    expect(best, `100 calls took ${best.toFixed(3)}ms`).toBeLessThan(0.3);
  });
});
