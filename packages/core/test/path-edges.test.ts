// Request path P2 review fixes, on real V8 block coverage (test/fixtures/path/edges.cjs): code that
// may be skipped (optional chains, destructuring defaults), logical assignment, what runs between a
// function's counter and its body, suspension, exits that did not complete, and the graph's switch
// and loop views. Ground truth: the fixture's T("k") counters.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { buildCfg } from "../../transform/src/cfg";
import { loadTypeScript } from "../../transform/src/ts";
import { analyzePayload } from "../src/path/analyze";
import type { PathFn, PathPayload } from "../src/path/capture";
import type { CfgFile } from "../src/path/cfg-model";
import { type FnAnalysis, type PathNode, joinCfg, pathTruth } from "../src/path/truth";
import { FIXTURES, type FnCoverage, analyze, arms, capture, load, rangesOf, startCoverage } from "./path-cov";

const EDGES = path.join(FIXTURES, "edges.cjs");
let m: any;
beforeAll(() => {
  startCoverage();
  m = load(EDGES);
});

function nodes(n: PathNode | undefined, out: PathNode[] = []): PathNode[] {
  if (!n) return out;
  out.push(n);
  for (const c of n.body ?? []) nodes(c, out);
  for (const a of n.arms ?? []) for (const c of a.body ?? []) nodes(c, out);
  return out;
}

/** Run `go` with the counters reset; the coverage and the T("k") ground truth. */
async function run(go: () => unknown) {
  for (const k of Object.keys(m.G)) delete m.G[k];
  const cov = await capture(EDGES, go);
  return { cov, truth: { ...m.G } as Record<string, number> };
}

/** Statements that start with a marker and claim a count the marker contradicts. */
function lies(a: FnAnalysis, truth: Record<string, number>): string[] {
  const out: string[] = [];
  for (const n of nodes(a.graph)) {
    const k = n.k === "stmt" ? /^T\("([\w-]+)"\);$/.exec(n.label ?? "")?.[1] : undefined;
    if (k && n.n !== null && n.n !== (truth[k] ?? 0)) out.push(`L${n.line} ${k}: n=${n.n} truth=${truth[k] ?? 0}`);
  }
  return out;
}
const stmtAt = (a: FnAnalysis, line: number) => nodes(a.graph).find((n) => n.line === line && n.k !== "block");
const exits = (a: FnAnalysis) => a.exits.map((e) => [e.kind, e.line, e.count, e.why ?? ""]);
const swallow = (f: () => unknown) => () => {
  try {
    return f();
  } catch {
    /* counted */
  }
};

describe("code that may be skipped is not an exception", () => {
  test("an optional call's arguments, short-circuited: no fake exception, the statements after it ran", async () => {
    const { cov, truth } = await run(() => m.optc(null, 1));
    const a = analyze(EDGES, cov, "optc", { threw: 0 });
    expect(lies(a, truth)).toEqual([]);
    expect(stmtAt(a, 11)).toMatchObject({ n: 1 });
    expect(stmtAt(a, 13)).toMatchObject({ n: 1 });
    expect(arms(a)).toEqual({ "L10 c": "true=0 false=0", "L12 c &&": "right=0 short-circuit=?no-counter" });
    expect(exits(a)).toEqual([["end", 14, 1, ""]]);
  });

  test("...and evaluated: the arms keep their own counters", async () => {
    const { cov, truth } = await run(() => m.optc({ f() {} }, 1));
    const a = analyze(EDGES, cov, "optc", { threw: 0 });
    expect(lies(a, truth)).toEqual([]);
    expect(arms(a)).toEqual({ "L10 c": "true=1 false=0", "L12 c &&": "right=1 short-circuit=?no-counter" });
  });

  test("destructuring defaults the value supplied: never evaluated, never an exception", async () => {
    const { cov, truth } = await run(() => m.destr({ a: 1, b: 2 }, 1));
    const a = analyze(EDGES, cov, "destr", { threw: 0 });
    expect(lies(a, truth)).toEqual([]);
    expect(arms(a)).toEqual({ "L18 c": "true=0 false=0", "L20 c &&": "right=0 short-circuit=?no-counter" });
    expect(a.decisions.find((d) => d.line === 20)!.verdict).toBe("unknown");
    expect(exits(a)).toEqual([["return", 22, 1, ""]]);
    const used = await run(() => m.destr({}, 1));
    const b = analyze(EDGES, used.cov, "destr", { threw: 0 });
    expect(lies(b, used.truth)).toEqual([]);
    expect(arms(b)).toEqual({ "L18 c": "true=1 false=0", "L20 c &&": "right=1 short-circuit=?no-counter" });
  });

  test("an optional call in an if test, an array default, an assignment-pattern default", async () => {
    const oi = await run(() => m.optif(null, 1));
    const a = analyze(EDGES, oi.cov, "optif", { threw: 0 });
    expect(lies(a, oi.truth)).toEqual([]);
    expect(arms(a)).toEqual({ "L27 c": "true=0 false=0", "L27 o?.f(c ? 1 : 2)": "then=0 else=1" });
    expect(exits(a)).toEqual([["end", 31, 1, ""]]);

    const ar = await run(() => m.arrDestr([5], 1));
    const b = analyze(EDGES, ar.cov, "arrDestr", { threw: 0 });
    expect(lies(b, ar.truth)).toEqual([]);
    expect(exits(b)).toEqual([["return", 37, 1, ""]]);

    const ad = await run(() => m.assignDestr({ a: 1 }, 1));
    const c = analyze(EDGES, ad.cov, "assignDestr", { threw: 0 });
    expect(arms(c)).toEqual({ "L43 c &&": "right=0 short-circuit=?no-counter" });
  });

  test("a for-of binding default runs per pass, not per entry", async () => {
    const un = await run(() => m.forofdef([{ a: 1 }, { a: 2 }], 1));
    const a = analyze(EDGES, un.cov, "forofdef", { threw: 0 });
    expect(arms(a)).toEqual({ "L50 c": "true=0 false=0" });
    expect(a.loops).toEqual([expect.objectContaining({ line: 50, entries: 1, passes: 2 })]);
    expect(exits(a)).toEqual([["end", 54, 1, ""]]);
    const used = await run(() => m.forofdef([{}, {}], 1));
    const b = analyze(EDGES, used.cov, "forofdef", { threw: 0 });
    expect(arms(b)).toEqual({ "L50 c": "true=2 false=0" });
    expect(lies(b, used.truth)).toEqual([]);
  });

  test("a logical assignment after an early return: its enclosing count is no arm count (not inconsistent)", async () => {
    const { cov, truth } = await run(() => m.laAfterReturn(null, 5));
    // V8 keeps a 0 range after the early return here; probe case C showed it may clip it away, so
    // the code after reads the call count: drop it, as there.
    const text = fs.readFileSync(EDGES, "utf8");
    const after = text.indexOf('\n  x ||= T("lar")');
    const ranges = rangesOf(cov, "laAfterReturn");
    const clipped = ranges.filter((r) => r.start !== after);
    expect(clipped.length).toBe(ranges.length - 1);
    const j = joinCfg({ cfg: analyzer.cfg(EDGES, text), ranges: clipped, capturedHash: "h", currentHash: "h" });
    if ("why" in j) throw new Error(j.why);
    const a = pathTruth({ fn: j.fn, ranges: clipped, threw: 0 });
    expect(lies(a, truth)).toEqual([]);
    expect(stmtAt(a, 175)).toMatchObject({ n: 0 });
    expect(nodes(a.graph).filter((n) => n.why)).toEqual([]);
  });

  test("logical assignment has no counter for its right side: not a decision", async () => {
    const { cov, truth } = await run(() => m.logassign(1, 0, 5));
    expect(truth).toEqual({ la0: 1, la1: 1 });
    const a = analyze(EDGES, cov, "logassign", { threw: 0 });
    expect(arms(a)).toEqual({});
    expect(lies(a, truth)).toEqual([]);
    expect(exits(a)).toEqual([["return", 63, 1, ""]]);
  });
});

describe("between the function's counter and its body", () => {
  test("a parameter default that throws: the body never ran, its first statement is not counted", async () => {
    const { cov, truth } = await run(swallow(() => m.dparam()));
    expect(truth).toEqual({});
    for (const throwLines of [undefined, [67]]) {
      const a = analyze(EDGES, cov, "dparam", { threw: 1, throwLines });
      expect(lies(a, truth)).toEqual([]);
      expect(stmtAt(a, 68)).toMatchObject({ n: null, why: "after-throw" });
      expect(exits(a)).toEqual([["exception", throwLines ? 67 : null, 1, ""]]);
    }
  });

  test("a generator called and never iterated: its body did not run", async () => {
    const { cov, truth } = await run(() => m.gen(1));
    expect(truth).toEqual({});
    const a = analyze(EDGES, cov, "gen", { threw: 0 });
    expect(lies(a, truth)).toEqual([]);
    expect(stmtAt(a, 76)).toMatchObject({ n: null, why: "suspended" });
    expect(a.decisions[0]!.arms.find((x) => x.label === "then")!.taken).not.toBe("taken");
    expect(a.exits.every((e) => e.count === null || e.count === 0)).toBe(true);
  });

  test("a generator run to the end keeps the counts its counters give", async () => {
    const { cov, truth } = await run(() => [...m.gen(1)]);
    const a = analyze(EDGES, cov, "gen", { threw: 0 });
    expect(lies(a, truth)).toEqual([]);
    expect(arms(a)["L77 x"]).toMatch(/^then=1 /);
  });
});

describe("suspension is not an exception", () => {
  test("an await still pending at capture, no hop error: the exit is UNKNOWN 'suspended', not Threw", async () => {
    const { cov, truth } = await run(() => {
      m.hang(1);
    });
    expect(truth).toEqual({ h0: 1 });
    const a = analyze(EDGES, cov, "hang", { threw: 0 });
    expect(lies(a, truth)).toEqual([]);
    expect(exits(a)).toEqual([["exception", null, null, "suspended"]]);
  });

  test("a generator suspended at its yield", async () => {
    const { cov } = await run(() => m.gen(0).next());
    const a = analyze(EDGES, cov, "gen", { threw: 0 });
    expect(a.exits.filter((e) => e.kind === "exception")).toEqual([
      expect.objectContaining({ count: null, why: "suspended" }),
    ]);
  });
});

describe("exits are completions", () => {
  test("`return boom()` that threw is not a return: the one call is the exception", async () => {
    const { cov } = await run(swallow(() => m.retboom()));
    expect(exits(analyze(EDGES, cov, "retboom", { threw: 1, throwLines: [92] }))).toEqual([["exception", 92, 1, ""]]);
    expect(exits(analyze(EDGES, cov, "retboom", { threw: 1 }))).toEqual([["exception", null, 1, ""]]);
  });

  test("a return whose value threw into the catch: only the catch's return happened", async () => {
    const { cov, truth } = await run(() => m.retcatch());
    expect(truth).toEqual({ rccatch: 1 });
    for (const throwLines of [undefined, [97]])
      expect(exits(analyze(EDGES, cov, "retcatch", { threw: 0, throwLines }))).toEqual([["return", 99, 1, ""]]);
  });

  test("a return whose value threw (seen at its own ternary) did not complete", async () => {
    const { cov } = await run(swallow(() => m.retTernBoom(1)));
    const a = analyze(EDGES, cov, "retTernBoom", { threw: 1 });
    expect(a.exits.map((e) => [e.kind, e.count])).toEqual([["exception", 1]]);
    // The shape where the deficit shows inside the return (its arms 0 + 0 under a reach of 1).
    const text = "function r(c) {\n  return f(c) ? 1 : 2;\n}\n";
    const f = analyzer.cfg("r.js", text)!.functions[0]!;
    const one = text.indexOf("1;");
    const two = text.indexOf("2;");
    const ranges = [
      { start: f.start, end: f.end, count: 1 },
      { start: one, end: one + 1, count: 0 },
      { start: two, end: two + 1, count: 0 },
    ];
    expect(pathTruth({ fn: f, ranges, threw: 1 }).exits.map((e) => [e.kind, e.count])).toEqual([["exception", 1]]);
  });

  test("a return a finally replaced is no exit, even right after its arm's counter", async () => {
    const one = await run(() => m.finRet(1, 1));
    const a = analyze(EDGES, one.cov, "finRet", { threw: 0 });
    expect(a.exits.map((e) => [e.kind, e.line, e.count])).toEqual([["return", 187, 1]]);
    // Two calls: the finally replaced one completion, but which (the return or the normal one) no
    // counter says: the return is unknown, never 0.
    const two = await run(() => [m.finRet(1, 0), m.finRet(0, 1)]);
    const b = analyze(EDGES, two.cov, "finRet", { threw: 0 });
    expect(b.exits.find((e) => e.line === 183)).toMatchObject({ count: null });
  });

  test("a throw its own catch took is no exit of the function", async () => {
    const { cov } = await run(() => m.caughtThrow(1));
    expect(exits(analyze(EDGES, cov, "caughtThrow", { threw: 0 }))).toEqual([["return", 111, 1, ""]]);
  });

  test("counted exits that add up to the calls settle the unknown ones at 0 (live /u/c)", async () => {
    const { cov } = await run(swallow(() => m.uc("c")));
    const a = analyze(EDGES, cov, "uc", { threw: 1, throwLines: [122] });
    expect(stmtAt(a, 123)).toMatchObject({ n: null, why: "after-throw" });
    expect(exits(a)).toEqual([["exception", 122, 1, ""]]);
  });

  test("the exception's line is the escaping error's, not a caught one's", async () => {
    const { cov } = await run(() => {
      swallow(() => m.uc("a"))();
      swallow(() => m.uc("c"))();
    });
    const a = analyze(EDGES, cov, "uc", { threw: 1, throwLines: [118, 122] });
    const e = a.exits.find((x) => x.kind === "exception")!;
    expect(e).toMatchObject({ line: 122, count: 1 });
    // The other call fell off the end, but that count leans on the after-throw region: it stays
    // unknown (never "what is left" of the calls).
    expect(exits(a)).toEqual([
      ["end", 124, null, "after-throw"],
      ["exception", 122, 1, ""],
    ]);
  });
});

describe("the graph agrees with the decisions and loops", () => {
  test("switch arms carry the matched counts; fall-through is structural; the last clause never falls", async () => {
    const { cov } = await run(() => m.swc(1));
    const a = analyze(EDGES, cov, "swc", { threw: 0 });
    const sw = nodes(a.graph).find((n) => n.k === "switch")!;
    expect(sw.arms!.map((x) => [x.label, x.n, !!x.fallsThrough, x.sharedArm ?? ""])).toEqual([
      ["case 1", 1, false, ""],
      ["case 2", 0, true, "case 2, case 3"],
      ["case 3", 0, false, "case 2, case 3"],
      ["default", 0, false, ""],
    ]);
    expect(sw.arms!.every((x) => x.n !== null || x.why)).toBe(true);
  });

  test("loop passes read the same in loops[] and in the graph", async () => {
    const { cov } = await run(() => m.loopTry(7, 1));
    const a = analyze(EDGES, cov, "loopTry", { threw: 0 });
    const g = nodes(a.graph).find((n) => n.k === "loop")!;
    expect(a.loops).toHaveLength(1);
    expect(g.passes).toBe(a.loops[0]!.passes);
    expect(g.n).toBe(a.loops[0]!.entries);
  });
});

/* -------------------------------------------------------- payload verdicts */

const ts = loadTypeScript(process.cwd());
// Generous parse budget: the production 250ms is wall time and folds under a loaded test run.
const analyzer = {
  cfg: (file: string, text: string) => buildCfg(ts, text, file, { maxMs: 10_000 }) as unknown as CfgFile,
};

function payloadOf(cov: FnCoverage[], fnName: string, errors?: PathFn["errors"]): PathPayload {
  const text = fs.readFileSync(EDGES, "utf8");
  const ranges = rangesOf(cov, fnName);
  const lineAt = (o: number) => text.slice(0, o).split("\n").length;
  const key = `edges.cjs:${lineAt(ranges[0]!.start)}:${fnName}`;
  const fn: PathFn = {
    key,
    name: fnName,
    file: "edges.cjs",
    line: lineAt(ranges[0]!.start),
    mapping: "identity",
    sourceHash: createHash("sha1").update(text).digest("hex").slice(0, 12),
    calls: { hops: ranges[0]!.count, coverage: ranges[0]!.count, checked: true },
    truth: { t: "taken", n: ranges[0]!.count },
    blocks: true,
    ranges: ranges.map((x) => ({ ...x, line: lineAt(x.start), endLine: lineAt(x.end - 1) })),
  };
  if (errors) fn.errors = errors;
  return {
    v: 2,
    traceId: "tr_new",
    replayOf: "tr_src",
    quality: "exact",
    contamination: [],
    warnings: [],
    window: {
      quietMs: 0,
      settleMs: 0,
      taint: [],
      retries: 0,
      attempts: [],
      takeMs: [0, 0],
      scripts: 1,
      totalScripts: 1,
    },
    lanes: [{ spanId: "s1", kind: "handler", name: "GET /x", depth: 0, calls: 1, truth: fn.truth, fnKey: key }],
    functions: { [key]: fn },
  };
}

describe("graph links", () => {
  test("a callback created at a node links by its AST start; a call links only to a recorded hop", async () => {
    const { cov } = await run(() => m.cbHost([1, 2]));
    const host = payloadOf(cov, "cbHost");
    const fnOf = (name: string) => Object.values(payloadOf(cov, name).functions)[0]!;
    const each = fnOf("each");
    const helper = fnOf("helper");
    host.functions[each.key] = each;
    host.functions[helper.key] = helper;
    host.lanes.push({
      spanId: "s2",
      kind: "function",
      name: "helper",
      depth: 1,
      calls: 3,
      truth: helper.truth,
      fnKey: helper.key,
    });
    analyzePayload(host, { analyzer, root: FIXTURES });
    const g = Object.values(host.functions)[0]!.analysis!.graph;
    const map = nodes(g).find((n) => n.label?.startsWith("const out"))!;
    expect(map.fns).toEqual([{ id: expect.any(Number), name: "each", line: map.line, fnKey: each.key }]);
    expect(map.callees).toBeUndefined();
    const call = nodes(g).find((n) => n.label === "helper(0);")!;
    expect(call.callees).toEqual([{ name: "helper", fnKey: helper.key }]);
    // Not a hop under this function: no link (each calls helper, but no lane says so).
    const inner = nodes(each.analysis!.graph).find((n) => n.k === "exit")!;
    expect(inner.calls).toEqual(["helper"]);
    expect(inner.callees).toBeUndefined();
    expect(inner.ambiguous).toBeUndefined();
  });

  test("a call two recorded hops could be is left unlinked and marked ambiguous", async () => {
    const { cov } = await run(() => m.cbHost([1, 2]));
    const host = payloadOf(cov, "cbHost");
    const helper = Object.values(payloadOf(cov, "helper").functions)[0]!;
    const twin = { ...helper, key: `${helper.key}#twin` };
    for (const f of [helper, twin]) {
      host.functions[f.key] = f;
      host.lanes.push({
        spanId: f.key,
        kind: "function",
        name: "helper",
        depth: 1,
        calls: 1,
        truth: f.truth,
        fnKey: f.key,
      });
    }
    analyzePayload(host, { analyzer, root: FIXTURES });
    const call = nodes(Object.values(host.functions)[0]!.analysis!.graph).find((n) => n.label === "helper(0);")!;
    expect(call.callees).toBeUndefined();
    expect(call.ambiguous).toEqual(["helper"]);
  });
});

describe("verdict line", () => {
  test("an uncaught callee throw after the try: Threw at the escaping line, not UNKNOWN", async () => {
    const { cov } = await run(swallow(() => m.uc("c")));
    const p = payloadOf(cov, "uc", { hops: 1, lines: [122] });
    expect(analyzePayload(p, { analyzer, root: FIXTURES }).text).toBe("Threw: exception in GET /x L122");
  });

  test("an exception with no located line says so instead of naming the function's line", async () => {
    const { cov } = await run(swallow(() => m.retboom()));
    const p = payloadOf(cov, "retboom", { hops: 1, lines: [] });
    expect(analyzePayload(p, { analyzer, root: FIXTURES }).text).toBe("Threw: exception in GET /x (line unknown)");
  });

  test("a pending await is UNKNOWN (suspended), not Threw", async () => {
    const { cov } = await run(() => {
      m.hang(1);
    });
    const p = payloadOf(cov, "hang");
    expect(analyzePayload(p, { analyzer, root: FIXTURES }).text).toBe("Exit: UNKNOWN (suspended)");
  });
});
