import { afterEach, describe, expect, test, vi } from "vitest";
import { HoplensApiError, api } from "../src/api/client";
import type { PathDecision, PathPayload } from "../src/api/types";
import { modeOnOpen } from "../src/state/canvas";
import {
  canTracePath,
  decisionChip,
  enterOpensLane,
  envCommand,
  errorViewOf,
  exitChip,
  laneCursor,
  loopChip,
  methodBlock,
  offView,
  pathAnnounce,
  pathErrorView,
  pathFailure,
  pathFocus,
  pathJob,
  pathPayloads,
  pathReady,
  runTracePath,
  stampOf,
  tracePath,
  trailModel,
  trailSummary,
  verdictModel,
  whyText,
} from "../src/state/path";
import { route } from "../src/state/router";
import { followLive, selectedTraceId } from "../src/state/store";
import fixtures from "./fixtures/path-payloads.json";

/*
 * Path mode (request path, plan P3): chips, trail, verdict, states and error copy, all read from the
 * server's analysis. Fixtures are real payloads captured from examples/express-app (P2 live runs),
 * with the raw ranges and flowchart graphs stripped.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/path.test.ts
 */

const P = fixtures as unknown as Record<string, PathPayload>;

function decision(extra: Partial<PathDecision>): PathDecision {
  return {
    id: "if#0",
    nodeId: 1,
    kind: "if",
    line: 12,
    label: "vip",
    reach: 3,
    arms: [
      { label: "then", line: 12, count: 1, taken: "taken" },
      { label: "else", line: 12, count: 2, taken: "taken", implied: true },
    ],
    verdict: "split-loop",
    summary: "then 1/3 . else 2/3",
    inLoop: true,
    ...extra,
  };
}

describe("chips from the server's analysis", () => {
  test("one side: `if !(await findProduct(id)) -> then` (products/99999)", () => {
    const p = P["/api/products/99999"]!;
    const m = trailModel(p);
    const handler = m.rows[0]!;
    const texts = handler.chips.map((c) => c.text);
    expect(texts).toEqual(["if !(await findProduct(id)) -> then", "return @L21 exit"]);
    expect(handler.chips[0]!.tone).toBe("taken");
    expect(handler.chips[1]!.exit).toBe(true);
    // the server reports no other exit counted here, and the UI adds none
    expect(handler.notReached).toEqual([]);
  });

  test("other side on products/1, and the helper's `??` short-circuit", () => {
    const m = trailModel(P["/api/products/1"]!);
    expect(m.rows[0]!.chips.map((c) => c.text)).toEqual(["if !(await findProduct(id)) -> else", "end @L25 exit"]);
    const helper = m.rows[1]!;
    expect(helper.name).toBe("findProduct");
    // two consecutive hops of one function fold into one lane; its counts are totals
    expect(helper.hops).toBe(2);
    expect(helper.blended).toBe(true);
    expect(helper.chips.map((c) => c.text)).toEqual(["rows[0] ?? -> short-circuit", "return @L11 x2"]);
  });

  test("loops: `for (const r of rows) x9600` (report)", () => {
    const m = trailModel(P["/api/report"]!);
    expect(m.rows[0]!.chips.map((c) => c.text)).toEqual([
      "for (let copy = 0; copy < 16; copy++) x16",
      "for (const r of rows) x9600",
      "end @L29 exit",
    ]);
    expect(m.rows[0]!.chips[1]!.title).toContain("entered 16x");
    expect([m.functions, m.decisions, m.loops]).toEqual([1, 0, 2]);
  });

  test("split inside a loop: `then 1/3 . else 2/3`, outlined (split tone)", () => {
    const c = decisionChip(decision({}));
    expect(c.text).toBe("if vip: then 1/3 . else 2/3");
    expect(c.tone).toBe("split");
    expect(c.title).toContain("inside a loop");
    const calls = decisionChip(decision({ verdict: "split-calls", inLoop: false }));
    expect(calls.title).toContain("across calls");
  });

  test("split-loop from a live payload (branchy zz)", () => {
    const m = trailModel(P["/api/branchy/zz?n=9"]!);
    const split = m.rows[0]!.chips.filter((c) => c.tone === "split").map((c) => c.text);
    expect(split).toContain("if i % 2 === 1: then 3/7 . else 4/7");
    // unreached decisions (try, ternary after the early return) are only in 'not reached'
    expect(m.rows[0]!.notReached.map((c) => c.text)).toEqual(expect.arrayContaining(["try", "score > 5 ?"]));
    expect(m.rows[0]!.notReached.every((c) => c.tone === "not")).toBe(true);
    expect(m.rows[0]!.chips.some((c) => c.tone === "not")).toBe(false);
  });

  test("UNKNOWN is hatched with its reason, never shown as not reached", () => {
    const c = decisionChip(
      decision({
        verdict: "unknown",
        why: "after-throw",
        summary: "? (after-throw)",
        arms: [
          { label: "then", count: null, taken: "unknown", why: "after-throw" },
          { label: "else", count: null, taken: "unknown", why: "after-throw" },
        ],
      }),
    );
    expect(c.tone).toBe("unknown");
    expect(c.title).toContain("UNKNOWN");
    expect(c.title).toContain(whyText("after-throw"));
    // an exit with no count (after a throw) is unknown too, not 'not reached'
    const m = trailModel(P["/api/branchy/u/c"]!);
    const handler = m.rows[0]!;
    const end = [...handler.chips, ...handler.notReached].find((x) => x.text.startsWith("end"));
    expect(end?.tone).toBe("unknown");
    expect(handler.notReached.some((x) => x.tone === "unknown")).toBe(false);
  });

  test("the UI never upgrades: a decision's tone follows the server verdict only", () => {
    // counts say then 1 / else 0, but the server said UNKNOWN: it stays unknown
    const c = decisionChip(
      decision({
        verdict: "unknown",
        why: "arms-inconsistent",
        summary: "then ? (arms-inconsistent)",
        arms: [
          { label: "then", count: 1, taken: "taken" },
          { label: "else", count: 0, taken: "not-taken" },
        ],
      }),
    );
    expect(c.tone).toBe("unknown");
    expect(c.text).toBe("if vip: then ? (arms-inconsistent)");
    expect(decisionChip(decision({ verdict: "unreached", summary: "not reached" })).tone).toBe("not");
  });

  test("loop and exit edge cases", () => {
    expect(loopChip({ nodeId: 1, line: 3, label: "while (x)", kind: "while", entries: 0, passes: 0 }, 0).tone).toBe(
      "not",
    );
    const u = loopChip(
      { nodeId: 1, line: 3, label: "while (x)", kind: "while", entries: 1, passes: null, why: "after-throw" },
      0,
    );
    expect(u.tone).toBe("unknown");
    expect(u.text).toBe("while (x) x?");
    expect(exitChip({ kind: "throw", line: 19, count: 1 }, 0).text).toBe("threw @L19");
    expect(exitChip({ kind: "exception", line: null, count: 1 }, 0).text).toBe("threw (line unknown)");
  });

  test("a function that is UNKNOWN as a whole gets one '?' with the reason", () => {
    const p = structuredClone(P["/api/products/1"]!);
    const fn = Object.values(p.functions)[0]!;
    fn.analysis = { ...fn.analysis!, status: "unknown", why: "source-moved", decisions: [], loops: [], exits: [] };
    const row = trailModel(p).rows[0]!;
    expect(row.unknown).toBe(whyText("source-moved"));
    expect(row.chips).toEqual([]);
  });

  test("a function seen again under another caller points at its first lane", () => {
    const p = structuredClone(P["/api/products/1"]!);
    // handler, findProduct, handler-level other lane, findProduct again (not consecutive)
    p.lanes = [
      p.lanes[0]!,
      p.lanes[1]!,
      { ...p.lanes[0]!, spanId: "x", depth: 1, fnKey: undefined, name: "mw" },
      p.lanes[2]!,
    ];
    const rows = trailModel(p).rows;
    expect(rows).toHaveLength(4);
    expect(rows[3]!.seeRow).toBe(rows[1]!.key);
    expect(rows[3]!.chips).toEqual([]);
    expect(rows[2]!.unknown).toBeTruthy();
  });

  test("blended across calls: '6 calls: totals' on one folded lane (users/2/orders/3)", () => {
    const rows = trailModel(P["/api/users/2/orders/3"]!).rows;
    const ps = rows.find((r) => r.name === "productSummary")!;
    expect(ps.hops).toBe(6);
    expect(ps.blended).toBe(true);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
  });
});

/** What core's markContaminated + unknownAnalysis leave: every truth and analysis UNKNOWN, K kept. */
function contaminated(p: PathPayload): PathPayload {
  const c = structuredClone(p);
  c.quality = "contaminated";
  for (const fn of Object.values(c.functions)) {
    fn.truth = { t: "unknown", why: "contaminated" };
    const calls = fn.calls.coverage ?? 1;
    fn.analysis = {
      status: "unknown",
      why: "contaminated",
      calls,
      blended: calls > 1,
      decisions: [],
      loops: [],
      exits: [],
      nodeCount: 0,
    };
  }
  return c;
}

describe("UNKNOWN is never counted or shown as known", () => {
  test("CONTAMINATED: no 'K calls: totals' badge (K holds other requests' calls)", () => {
    const p = contaminated(P["/api/products/1"]!);
    const helper = Object.values(p.functions).find((f) => f.name === "findProduct")!;
    helper.calls.coverage = 17;
    helper.analysis!.calls = 17;
    helper.analysis!.blended = true;
    const rows = trailModel(p).rows;
    const row = rows.find((r) => r.name === "findProduct")!;
    expect(row.unknown).toBe(whyText("contaminated"));
    expect(row.blended).toBe(false);
    expect(row.coverageCalls).toBeUndefined();
  });

  test("CONTAMINATED summary says decisions are UNKNOWN, not '0 decisions reached'", () => {
    const m = trailModel(contaminated(P["/api/products/1"]!));
    expect(m.decisions).toBe(0);
    expect(m.unknownFns).toBe(m.functions);
    const s = trailSummary(m);
    expect(s).not.toContain("0 decisions reached");
    expect(s).toContain("decisions: UNKNOWN");
  });

  test("unknown decisions and loops with unknown entries are not 'reached' / 'run'", () => {
    const p = structuredClone(P["/api/report"]!);
    const fn = Object.values(p.functions)[0]!;
    const a = fn.analysis!;
    const known = { loops: a.loops.length, decisions: 0 };
    a.decisions.push(
      decision({ id: "if#9", verdict: "unknown", reach: null, why: "after-throw", summary: "? (after-throw)" }),
      decision({ id: "if#10", verdict: "one", reach: 1, summary: "then" }),
    );
    a.loops.push({
      nodeId: 99,
      line: 40,
      label: "while (x)",
      kind: "while",
      entries: null,
      passes: null,
      why: "suspended",
    });
    const m = trailModel(p);
    expect(m.decisions).toBe(known.decisions + 1);
    expect(m.loops).toBe(known.loops);
    expect(m.unknownDecisions).toBe(1);
    expect(m.unknownLoops).toBe(1);
    const s = trailSummary(m);
    expect(s).toContain("1 decision reached");
    expect(s).toContain("UNKNOWN: 1 decision, 1 loop");
  });

  test("a CFG-capped function says so and carries the analysis warnings; never 'no decisions'", () => {
    const p = structuredClone(P["/api/products/99999"]!);
    const fn = Object.values(p.functions).find((f) => f.name === "findProduct")!;
    fn.analysis = { ...fn.analysis!, decisions: [], loops: [], exits: [], truncated: true, warnings: ["w1"] };
    const row = trailModel(p).rows.find((r) => r.name === "findProduct")!;
    expect(row.truncated).toBe(true);
    expect(row.fnWarnings).toEqual(["w1"]);
  });
});

describe("Path mode keys and capture flow", () => {
  test("Enter opens a lane only from its name button, never from a chip / expander / link", () => {
    const el = (cls: string) => ({ classList: { contains: (c: string) => c === cls } });
    expect(enterOpensLane(el("path-lane-name"))).toBe(true);
    expect(enterOpensLane(el("pt-chip"))).toBe(false);
    expect(enterOpensLane(el("path-more"))).toBe(false);
    expect(enterOpensLane(null)).toBe(false);
  });

  test("the lane cursor is clamped to the rows (one lane stays tabbable)", () => {
    expect(laneCursor(4, 2)).toBe(1);
    expect(laneCursor(0, 0)).toBe(0);
    expect(laneCursor(1, 5)).toBe(1);
  });
});

describe("verdict line", () => {
  test("a known multi-exit verdict is not UNKNOWN-toned", () => {
    const p = structuredClone(P["/api/products/1"]!);
    p.analysis = { text: "Exited 2 ways in handler: return L12 x1, return L20 x2", ms: 1 };
    expect(verdictModel(p).tone).toBe("exit");
    p.analysis.text = "Exit: UNKNOWN (contaminated)";
    expect(verdictModel(p).tone).toBe("unknown");
  });

  test("from the server's text, with the exit's source", () => {
    const v = verdictModel(P["/api/products/99999"]!);
    expect(v.text).toBe("Exited: return at GET /api/products/:id L21 via if !(await findProduct(id)) -> then");
    expect(v.tone).toBe("exit");
    expect(v.at).toEqual({ file: "src/routes/products.js", line: 21 });
    expect(verdictModel(P["/api/boom"]!).tone).toBe("threw");
    const u = verdictModel(P["/api/branchy/u/c"]!);
    expect(u.tone).toBe("unknown");
    expect(u.at).toBeUndefined();
  });
});

describe("states", () => {
  const meta = (state: "off" | "on" | "disabled-c8" | "error", reason?: string) => ({
    root: "/app",
    path: { state, reason },
  });

  test("off: env var + restart, with a shell line for the app's platform", () => {
    const v = offView(meta("off", "restart with HOPLENS_PATH=1"), false)!;
    expect(v.body).toContain("HOPLENS_PATH=1");
    expect(v.body).toContain("restart");
    expect(v.command).toBe("export HOPLENS_PATH=1");
    expect(envCommand("D:\\WorkZone\\app")).toBe('$env:HOPLENS_PATH = "1"');
  });

  test("disabled-c8, error, Next, older core, on", () => {
    expect(offView(meta("disabled-c8", "NODE_V8_COVERAGE is set"), false)!.title).toContain("c8");
    expect(offView(meta("error", "inspector failed"), false)!.body).toContain("inspector failed");
    // Next has the request path too: on is on, off says how, with Next's restart wording.
    expect(offView(meta("on"), true)).toBeNull();
    expect(offView(meta("off"), true)!.body).toContain("restart next dev");
    expect(offView(meta("off"), true)!.title).not.toContain("Express only");
    expect(offView({ root: "/app" }, false)!.title).toContain("not in this Hoplens core");
    expect(offView(meta("on"), false)).toBeNull();
  });

  test("GET / HEAD only", () => {
    expect(methodBlock("GET")).toBeUndefined();
    expect(methodBlock("head")).toBeUndefined();
    expect(methodBlock("POST")).toContain("side effects");
    expect(canTracePath({ method: "POST" }, meta("on"), false)).toBe(false);
    expect(canTracePath({ method: "GET" }, meta("on"), false)).toBe(true);
    expect(canTracePath({ method: "GET", pathTrace: { quality: "exact", replayOf: "a" } }, meta("on"), false)).toBe(
      false,
    );
  });

  test("a path trace is known from the record, its summary, or a payload we hold", () => {
    const stamp = { quality: "exact" as const, replayOf: "t1" };
    expect(stampOf({ id: "a", pathTrace: stamp })).toBe(stamp);
    expect(stampOf({ id: "a" }, { pathTrace: stamp })).toBe(stamp);
    expect(stampOf({ id: "a" }, undefined, P["/api/report"])).toEqual({ quality: "exact", replayOf: "tr_jlmnz" });
    expect(stampOf({ id: "a" })).toBeUndefined();
  });

  test("a path trace opens in Path mode; leaving it restores Flame / Tree unless Path was picked by hand", () => {
    const opened = modeOnOpen({ path: false, auto: false }, true);
    expect(opened).toEqual({ path: true, auto: true });
    expect(modeOnOpen(opened, false)).toEqual({ path: false, auto: false });
    const manual = { path: true, auto: false };
    expect(modeOnOpen(manual, false)).toEqual(manual);
    expect(modeOnOpen(manual, true)).toEqual(manual);
  });
});

describe("error codes -> copy", () => {
  test("not-quiet lists what is in flight and offers Retry", () => {
    const v = pathErrorView(409, {
      code: "not-quiet",
      error: "The app never went idle",
      reason: "2 requests in flight",
      inflight: 2,
      requests: ["GET /api/feed", "GET /api/slow"],
    });
    expect(v.title).toBe("The app is busy: 2 requests in flight. Nothing was sent.");
    expect(v.list).toEqual(["GET /api/feed", "GET /api/slow"]);
    expect(v.retry).toBe(true);
  });

  test("every code has actionable text", () => {
    expect(pathErrorView(409, { code: "busy", error: "x" }).retry).toBe(true);
    expect(pathErrorView(400, { code: "method", error: "x" }).retry).toBe(false);
    expect(pathErrorView(409, { code: "path-off", error: "off" }).detail).toContain("HOPLENS_PATH=1");
    const t = pathErrorView(502, {
      code: "replay-failed",
      error: "The operation was aborted due to timeout",
      status: 0,
    });
    expect(t.title).toContain("30s time limit");
    expect(pathErrorView(502, { code: "replay-failed", error: "ECONNREFUSED", status: 502 }).title).toBe(
      "The replay failed (502)",
    );
    expect(pathErrorView(500, { code: "take-failed", error: "x" }).retry).toBe(true);
    expect(pathErrorView(404, { code: "superseded", error: "x", traceId: "t9" }).link).toEqual({
      label: "open the retry",
      traceId: "t9",
    });
    expect(pathErrorView(410, { code: "evicted", error: "x", replayOf: "t1" }).link?.traceId).toBe("t1");
    expect(pathErrorView(404, undefined).code).toBe("no-api");
  });

  test("an API error body is parsed; a network error is retryable", () => {
    const e = new HoplensApiError(409, JSON.stringify({ code: "busy", error: "running" }), "/traces/a/path");
    expect(errorViewOf(e).code).toBe("busy");
    expect(errorViewOf(new TypeError("Failed to fetch")).retry).toBe(true);
  });
});

describe("tracePath (capture flow)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pathFailure.value = null;
    pathJob.value = null;
  });

  test("success stores the NEW trace's payload and resolves to its id", async () => {
    const p = P["/api/report"]!;
    const spy = vi.spyOn(api, "tracePath").mockResolvedValue({ traceId: p.traceId, path: p });
    const src = { id: p.replayOf, method: "GET", url: "/api/report" };
    const run = tracePath(src);
    expect(pathJob.value).toEqual({ sourceId: src.id, phase: "quiet" });
    await expect(run).resolves.toBe(p.traceId);
    expect(spy).toHaveBeenCalledWith(src.id);
    expect(pathPayloads.value.get(p.traceId)).toBe(p);
    expect(pathJob.value).toBeNull();
  });

  test("runTracePath turns Follow off and opens the new trace while the user is still on the source", async () => {
    const p = P["/api/report"]!;
    vi.spyOn(api, "tracePath").mockResolvedValue({ traceId: p.traceId, path: p });
    vi.spyOn(api, "trace").mockRejectedValue(new TypeError("offline"));
    route.value = { view: "trace", traceId: p.replayOf };
    selectedTraceId.value = p.replayOf;
    followLive.value = true;
    const run = runTracePath({ id: p.replayOf, method: "GET", url: "/api/report" });
    // Off before the replay runs: its own `done` must not move the selection.
    expect(followLive.value).toBe(false);
    await run;
    expect(selectedTraceId.value).toBe(p.traceId);
    expect(pathFocus.value).toBe(p.traceId);
    expect(pathAnnounce.value).toContain("EXACT");
  });

  test("runTracePath leaves the user where they went during the capture, with a 'path ready' note", async () => {
    const p = P["/api/report"]!;
    vi.spyOn(api, "tracePath").mockResolvedValue({ traceId: p.traceId, path: p });
    route.value = { view: "trace", traceId: p.replayOf };
    selectedTraceId.value = p.replayOf;
    pathFocus.value = null;
    const run = runTracePath({ id: p.replayOf, method: "GET", url: "/api/report" });
    selectedTraceId.value = "other";
    route.value = { view: "trace", traceId: "other" };
    await run;
    expect(selectedTraceId.value).toBe("other");
    expect(pathFocus.value).toBeNull();
    expect(pathReady.value).toEqual({ sourceId: p.replayOf, traceId: p.traceId });
  });

  test("a refusal lands in pathFailure for the source; non-GET never calls the API", async () => {
    vi.spyOn(api, "tracePath").mockRejectedValue(
      new HoplensApiError(409, JSON.stringify({ code: "not-quiet", error: "x", inflight: 1 }), "/p"),
    );
    await expect(tracePath({ id: "s1", method: "GET", url: "/a" })).resolves.toBeUndefined();
    expect(pathFailure.value?.sourceId).toBe("s1");
    expect(pathFailure.value?.view.code).toBe("not-quiet");
    const spy = vi.spyOn(api, "tracePath");
    spy.mockClear();
    await tracePath({ id: "s2", method: "DELETE", url: "/a" });
    expect(spy).not.toHaveBeenCalled();
    expect(pathFailure.value?.view.code).toBe("method");
  });
});

describe("bundle reasons (P6)", () => {
  test("a file run in two bundled copies has its own copy, not the source-join one", () => {
    expect(whyText("bundle-copies")).toMatch(/bundled copy/);
    expect(whyText("bundle-copies")).not.toBe(whyText("join-ambiguous"));
    expect(whyText("bundle-copies")).not.toMatch(/^unknown \(/);
  });
});
