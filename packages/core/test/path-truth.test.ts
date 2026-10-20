// Request path P2 truth model on real V8 block coverage: each PLAN.json probe case as a fixture
// (test/fixtures/path/*.cjs, required natively after precise coverage started), joined to the
// control-flow model @hoplens/transform/cfg builds, with the exact verdict pinned.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { buildCfg } from "../../transform/src/cfg";
import { loadTypeScript } from "../../transform/src/ts";
import { analyzePayload, requestVerdict } from "../src/path/analyze";
import type { PathFn, PathPayload } from "../src/path/capture";
import type { CfgFile } from "../src/path/cfg-model";
import { type FnAnalysis, type PathNode, joinCfg, pathTruth } from "../src/path/truth";
import { FIXTURES, type FnCoverage, analyze, arms, capture, cfgOf, load, rangesOf, startCoverage } from "./path-cov";

const F = (n: string) => path.join(FIXTURES, n);
const BRANCHY = F("branchy.cjs");
const REPORT = F("report.cjs");
const FLOW = F("flow.cjs");
const THROWS = F("throws.cjs");

let b: any;
let r: any;
let f: any;
let t: any;
beforeAll(() => {
  startCoverage();
  b = load(BRANCHY);
  r = load(REPORT);
  f = load(FLOW);
  t = load(THROWS);
});

const items = [
  { sku: "a", qty: 2 },
  { sku: "b", qty: 0 },
  { sku: "c", qty: 3 },
];
const caseA = () => b.checkout({ id: "1", items, coupon: "x", status: "new" }, { vip: false });
const caseB = () => b.checkout({ id: "2", items: items.slice(0, 1), status: "paid" }, { vip: true });
const caseC = () => b.checkout({ id: "3", items, status: "new" }, null);

const decision = (a: FnAnalysis, line: number) => {
  const d = a.decisions.find((x) => x.line === line);
  if (!d) throw new Error(`no decision at L${line}: ${a.decisions.map((x) => x.line)}`);
  return d;
};

/** Every graph node, depth first. */
function nodes(n: PathNode | undefined, out: PathNode[] = []): PathNode[] {
  if (!n) return out;
  out.push(n);
  for (const c of n.body ?? []) nodes(c, out);
  for (const a of n.arms ?? []) for (const c of a.body ?? []) nodes(c, out);
  return out;
}
const stmt = (a: FnAnalysis, line: number) => nodes(a.graph).find((n) => n.line === line && n.k !== "block");

describe("probe ux/run.mjs on branchy (checkout)", () => {
  test("case C (early return at L4): the switch is NOT reached, though V8's innermost range there reads 1", async () => {
    const cov = await capture(BRANCHY, caseC);
    // The probe's bug, reproduced: naive innermost-range reach at the switch is 1.
    const ranges = rangesOf(cov, "checkout");
    const text = fs.readFileSync(BRANCHY, "utf8");
    const at = text.indexOf("switch (order.status)");
    const innermost = ranges
      .filter((x) => x.start <= at && at < x.end)
      .sort((x, y) => x.end - x.start - (y.end - y.start))[0]!;
    expect(innermost.count).toBe(1);

    const a = analyze(BRANCHY, cov, "checkout");
    expect(arms(a)).toEqual({
      "L3 !user": "then=1 else=0",
      "L8 item.qty <= 0": "then=0 else=0",
      "L11 user.vip": "true=0 false=0",
      "L12 order.coupon &&": "right=0 short-circuit=0",
      "L13 order.status": 'case "new"=0 case "paid"=0 default=0',
      "L22 try": "no throw=0 catch=0",
    });
    const sw = decision(a, 13);
    expect(sw.reach).toBe(0);
    expect(sw.verdict).toBe("unreached");
    expect(sw.summary).toBe("not reached");
    expect(decision(a, 3)).toMatchObject({ verdict: "one", summary: "then", reach: 1 });
    expect(a.loops).toEqual([
      {
        nodeId: expect.any(Number),
        line: 7,
        label: "for (const item of order.items)",
        kind: "for-of",
        entries: 0,
        passes: 0,
      },
    ]);
    expect(a.exits).toEqual([
      {
        nodeId: expect.any(Number),
        kind: "return",
        line: 4,
        count: 1,
        via: { decision: "if#0", label: "if !user", arm: "then", line: 3 },
      },
    ]);
    // Nothing after the early return is drawn as run.
    for (const n of nodes(a.graph)) if (n.line > 5) expect(n.n).toBe(0);
    expect(a).toMatchObject({ calls: 1, blended: false, status: "ok" });
  });

  test("case A: a split inside one call is split-loop (then 1/3 . else 2/3)", async () => {
    const a = analyze(BRANCHY, await capture(BRANCHY, caseA), "checkout");
    expect(decision(a, 8)).toMatchObject({
      verdict: "split-loop",
      summary: "then 1/3 . else 2/3",
      reach: 3,
      inLoop: true,
    });
    expect(decision(a, 11)).toMatchObject({ verdict: "one", summary: "false" });
    expect(decision(a, 12)).toMatchObject({ kind: "logical", verdict: "one", summary: "right" });
    expect(decision(a, 13)).toMatchObject({ verdict: "one", summary: 'case "new"' });
    expect(decision(a, 22)).toMatchObject({ kind: "try", verdict: "one", summary: "no throw" });
    expect(a.loops[0]).toMatchObject({ entries: 1, passes: 3 });
    expect(a.exits.map((e) => [e.kind, e.line, e.count])).toEqual([["return", 29, 1]]);
  });

  test("case B: return inside a switch case, the try after it not reached", async () => {
    const a = analyze(BRANCHY, await capture(BRANCHY, caseB), "checkout");
    expect(decision(a, 13).summary).toBe('case "paid"');
    expect(decision(a, 22)).toMatchObject({ reach: 0, verdict: "unreached" });
    expect(a.exits).toEqual([
      expect.objectContaining({
        kind: "return",
        line: 18,
        count: 1,
        via: { decision: "switch#0", label: "switch (order.status)", arm: 'case "paid"', line: 13 },
      }),
    ]);
  });

  test("case M (A then B, blended): counts are totals and splits are split-calls", async () => {
    const a = analyze(
      BRANCHY,
      await capture(BRANCHY, async () => {
        await caseA();
        await caseB();
      }),
      "checkout",
    );
    expect(a).toMatchObject({ calls: 2, blended: true });
    expect(decision(a, 11)).toMatchObject({ verdict: "split-calls", summary: "true 1/2 . false 1/2" });
    expect(decision(a, 8)).toMatchObject({ verdict: "split-calls", summary: "then 1/4 . else 3/4" });
    expect(decision(a, 13).summary).toBe('case "new" 1/2 . case "paid" 1/2');
    expect(a.loops[0]).toMatchObject({ entries: 2, passes: 4 });
    expect(a.exits.map((e) => [e.kind, e.line, e.count])).toEqual([
      ["return", 18, 1],
      ["return", 29, 1],
    ]);
  });
});

test("report: nested loops 16 / 9600 (600 per entry)", async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ qty: i, price_cents: 3 }));
  const a = analyze(REPORT, await capture(REPORT, () => r.report(rows)), "report");
  expect(a.loops.map((l) => [l.line, l.label, l.entries, l.passes])).toEqual([
    [4, "for (let copy = 0; copy < 16; copy++)", 1, 16],
    [5, "for (const r of rows)", 16, 9600],
  ]);
  expect(a.decisions).toEqual([]);
});

describe("flow shapes", () => {
  test("switch fall-through: case 0 matched, case 1 only fallen into (0 matched)", async () => {
    const a = analyze(FLOW, await capture(FLOW, () => f.grade(0)), "grade");
    expect(arms(a)).toEqual({ "L4 n": "case 0=1 case 1=0 case 5, case 6=0 default=0" });
    expect(decision(a, 4).summary).toBe("case 0");
    // case 1 still ran (fell through): its body counts 1.
    expect(stmt(a, 8)).toMatchObject({ n: 1, label: 'out += "small";' });
    const sw = nodes(a.graph).find((n) => n.k === "switch")!;
    // Fall-through is structural; the last clause has nothing to fall into.
    expect(sw.arms!.map((x) => [x.label, !!x.fallsThrough, x.n])).toEqual([
      ["case 0", true, 1],
      ["case 1", false, 0],
      ["case 5", true, 0],
      ["case 6", false, 0],
      ["default", false, 0],
    ]);
  });

  test("switch: empty clauses share an arm; three calls split", async () => {
    const a = analyze(FLOW, await capture(FLOW, () => [f.grade(5), f.grade(6), f.grade(9)]), "grade");
    expect(decision(a, 4)).toMatchObject({ verdict: "split-calls", summary: "case 5, case 6 2/3 . default 1/3" });
  });

  test("labeled break leaves both loops", async () => {
    const grid = [
      [1, 2],
      [3, 4],
    ];
    const a = analyze(FLOW, await capture(FLOW, () => f.find(grid, 3)), "find");
    expect(decision(a, 25)).toMatchObject({ verdict: "split-loop", summary: "then 1/3 . else 2/3" });
    expect(a.loops.map((l) => [l.line, l.entries, l.passes])).toEqual([
      [22, 1, 2],
      [23, 2, 3],
    ]);
    expect(a.exits.map((e) => [e.kind, e.line, e.count])).toEqual([["return", 28, 1]]);
  });

  test("ternary and &&: decisions; a pure ?? inside an expression is not one", async () => {
    const a = analyze(FLOW, await capture(FLOW, () => f.pick({ vip: true, name: "a" }, [])), "pick");
    expect(arms(a)).toEqual({
      "L32 user.vip": "true=1 false=0",
      "L33 user.name &&": "right=1 short-circuit=0",
      "L34 note": "true=1 false=0",
    });
    expect(a.decisions.map((d) => d.kind)).toEqual(["ternary", "logical", "ternary"]);
  });

  test("?? as a return value is a decision", async () => {
    const a = analyze(FLOW, await capture(FLOW, () => [f.first([]), f.first([1])]), "first");
    expect(arms(a)).toEqual({ "L51 rows[0] ??": "right=1 short-circuit=1" });
    expect(decision(a, 51).verdict).toBe("split-calls");
  });

  test("try / catch / finally: the catch ran, the finally ran once", async () => {
    const boom = () => {
      throw new Error("x");
    };
    const a = analyze(FLOW, await capture(FLOW, () => f.guarded(boom)), "guarded");
    expect(arms(a)).toEqual({ "L39 try": "no throw=0 catch=1" });
    const tryNode = nodes(a.graph).find((n) => n.k === "try")!;
    expect(tryNode.arms!.map((x) => [x.label, x.n])).toEqual([
      ["try", 1],
      ["catch", 1],
      ["finally", 1],
    ]);
    expect(a.exits.map((e) => [e.kind, e.line, e.count])).toEqual([["return", 46, 1]]);
  });
});

/** As capture.ts records them: per distinct stack, the innermost frame inside the function. */
function linesIn(stacks: string[], abs: string, from: number, to: number): number[] {
  const out: number[] = [];
  for (const st of new Set(stacks))
    for (const l of st.split("\n")) {
      const m = /\((.*):(\d+):\d+\)\s*$/.exec(l) ?? /at (.*):(\d+):\d+\s*$/.exec(l);
      if (!m || path.resolve(m[1]!) !== abs) continue;
      const line = Number(m[2]);
      if (line >= from && line <= to) {
        out.push(line);
        break;
      }
    }
  return out;
}

describe("exceptions", () => {
  test("a sync throw in a callee: the statements after it are UNKNOWN after-throw, not run", async () => {
    let stack = "";
    const cov = await capture(THROWS, () => {
      try {
        t.caller(true);
      } catch (err) {
        stack = (err as Error).stack!;
      }
    });
    // V8 alone says `a = 2` ran (no counter between the call and it).
    const text = fs.readFileSync(THROWS, "utf8");
    const at = text.indexOf("a = 2;");
    const rs = rangesOf(cov, "caller").filter((x) => x.start <= at && at < x.end);
    expect(Math.min(...rs.map((x) => x.count))).toBe(1);

    const a = analyze(THROWS, cov, "caller", { threw: 1, throwLines: linesIn([stack], THROWS, 8, 14) });
    expect(stmt(a, 9)).toMatchObject({ n: 1 });
    expect(stmt(a, 10)).toMatchObject({ n: 1, calls: ["boom"] });
    expect(stmt(a, 11)).toMatchObject({ n: null, why: "after-throw" });
    expect(stmt(a, 12)).toMatchObject({ n: null, why: "after-throw" });
    // The return after it is unknown on its own, but the one call is the exception: it is 0.
    expect(a.exits).toEqual([{ kind: "exception", line: 10, count: 1 }]);
  });

  test("...and a decision after it: its counted arm stays exact (0), the implied else is UNKNOWN", async () => {
    let stack = "";
    const cov = await capture(THROWS, () => {
      try {
        t.branchAfter(true, true);
      } catch (err) {
        stack = (err as Error).stack!;
      }
    });
    const a = analyze(THROWS, cov, "branchAfter", { threw: 1, throwLines: linesIn([stack], THROWS, 16, 23) });
    expect(arms(a)).toEqual({ "L19 y": "then=0 else=?after-throw" });
    expect(decision(a, 19).verdict).toBe("unknown");
  });

  test("without the hop's error the throw is placed from the catch count alone", async () => {
    const a = analyze(THROWS, await capture(THROWS, () => t.catches(true)), "catches");
    expect(arms(a)).toEqual({ "L30 a": "then=0 else=?after-throw", "L27 try": "no throw=0 catch=1" });
    expect(stmt(a, 29)).toMatchObject({ n: null, why: "after-throw" });
    expect(a.exits.map((e) => [e.kind, e.line, e.count])).toEqual([["return", 34, 1]]);
  });

  test("an awaited rejection stays exact: the statement after the await 0, the catch 1", async () => {
    const cov = await capture(THROWS, () => t.viaCallee(true));
    const a = analyze(THROWS, cov, "viaCallee", { throwLines: linesIn(t.recorded, THROWS, 60, 69) });
    expect(arms(a)).toEqual({ "L62 try": "no throw=0 catch=1" });
    expect(stmt(a, 63)).toMatchObject({ n: 1 });
    expect(stmt(a, 64)).toMatchObject({ n: 0 });
    expect(stmt(a, 66)).toMatchObject({ n: 1 });
    expect(a.exits.map((e) => [e.kind, e.line, e.count])).toEqual([["return", 68, 1]]);
    // The resolved case for contrast.
    const ok = analyze(THROWS, await capture(THROWS, () => t.viaCallee(false)), "viaCallee");
    expect(arms(ok)).toEqual({ "L62 try": "no throw=1 catch=0" });
    expect(stmt(ok, 64)).toMatchObject({ n: 1 });
  });

  test("the first statement of an arm keeps its count inside an unplaced throw's region", async () => {
    const a = analyze(THROWS, await capture(THROWS, () => t.anchored(true, true)), "anchored", { threw: 1 });
    expect(stmt(a, 75)).toMatchObject({ n: 1, label: "a = 1;" });
    expect(stmt(a, 77)).toMatchObject({ n: null, why: "after-throw" });
    expect(arms(a)).toEqual({ "L74 y": "then=1 else=?after-throw" });
  });

  test("a recorded throw line does not narrow past a throw nobody recorded", async () => {
    t.recorded.length = 0;
    const cov = await capture(THROWS, () => t.twoThrows([1, 2]));
    const lines = linesIn(t.recorded, THROWS, 95, 107);
    expect(lines).toEqual([100]);
    const a = analyze(THROWS, cov, "twoThrows", { throwLines: lines });
    // Pass 1 threw in bare() before the if; pass 2 took then. The else never ran: it must not
    // read as taken, though the recorded throw (pass 2) comes after the if.
    expect(arms(a)["L99 x === 2"]).toBe("then=1 else=?after-throw");
    expect(arms(a)["L97 try"]).toBe("no throw=0 catch=2");
  });

  test("an exception a finally replaced leaves no count: what the finally's throw skipped is UNKNOWN", async () => {
    const cov = await capture(THROWS, () => t.replaced(true));
    // One hop error (the finally's), one counted rejection that never reached the hop.
    const a = analyze(THROWS, cov, "replaced", { threw: 1 });
    expect(arms(a)["L121 a > 5"]).toBe("then=0 else=?after-throw");
  });

  test("...and one raised in a catch body, replaced by a counted throw in the finally", async () => {
    t.recorded.length = 0;
    const cov = await capture(THROWS, () => t.replacedInCatch(true));
    const lines = linesIn(t.recorded, THROWS, 129, 147);
    expect(lines).toEqual([138]);
    const a = analyze(THROWS, cov, "replacedInCatch", { threw: 0, throwLines: lines });
    expect(arms(a)["L136 a > 5"]).toBe("then=0 else=?after-throw");
  });

  test("an inline rejection nobody recorded: the counters still give the catch, the region stays UNKNOWN", async () => {
    const a = analyze(THROWS, await capture(THROWS, () => t.awaited(true)), "awaited");
    expect(arms(a)).toEqual({ "L40 fail": "true=1 false=0", "L39 try": "no throw=?after-throw catch=1" });
  });
});

describe("guards", () => {
  test("counts that cannot hold (an arm past its decision) are UNKNOWN arms-inconsistent, never taken", async () => {
    const cov = await capture(BRANCHY, caseA);
    const ranges = rangesOf(cov, "checkout");
    const text = fs.readFileSync(BRANCHY, "utf8");
    const paid = text.indexOf('case "paid"');
    // A shifted map: the "paid" case range claims 2 runs in a call that reached the switch once.
    const bad = ranges.map((x) => (x.start === paid ? { ...x, count: 2 } : x));
    expect(bad).not.toEqual(ranges);
    const j = joinCfg({ cfg: cfgOf(BRANCHY), ranges: bad, capturedHash: "h", currentHash: "h" });
    if ("why" in j) throw new Error(j.why);
    const a = pathTruth({ fn: j.fn, ranges: bad, threw: 0 });
    const sw = decision(a, 13);
    expect(sw).toMatchObject({ reach: null, why: "arms-inconsistent", verdict: "unknown" });
    for (const arm of sw.arms) expect(arm).toMatchObject({ taken: "unknown", why: "arms-inconsistent" });
    // Everything after it in the function too.
    for (const d of a.decisions) if (d.line > 13) expect(d.arms.every((x) => x.taken === "unknown")).toBe(true);
    // Before it the counts stand.
    expect(decision(a, 11).summary).toBe("false");
  });

  test("an if whose arms ran more often than it was reached is arms-inconsistent", async () => {
    const cov = await capture(BRANCHY, caseA);
    const ranges = rangesOf(cov, "checkout");
    const text = fs.readFileSync(BRANCHY, "utf8");
    const then = text.indexOf('{\n    return { ok: false, reason: "anon" }');
    const bad = ranges.map((x) => (x.start === then ? { ...x, count: 2 } : x));
    expect(bad).not.toEqual(ranges);
    const j = joinCfg({ cfg: cfgOf(BRANCHY), ranges: bad, capturedHash: "h", currentHash: "h" });
    if ("why" in j) throw new Error(j.why);
    const a = pathTruth({ fn: j.fn, ranges: bad, threw: 0 });
    expect(decision(a, 3)).toMatchObject({ why: "arms-inconsistent", verdict: "unknown" });
    expect(a.decisions.every((d) => d.arms.every((x) => x.taken === "unknown"))).toBe(true);
  });

  test("join validation: a function whose end moved (same start, same text) is no-function, not an edit", async () => {
    const cov = await capture(BRANCHY, caseA);
    const ranges = rangesOf(cov, "checkout");
    const grown = fs
      .readFileSync(BRANCHY, "utf8")
      .replace("  return { ok: true, total };", "  return { ok: true, total, extra: 1 };");
    expect(joinCfg({ cfg: cfgOf(BRANCHY, grown), ranges, capturedHash: "a", currentHash: "a" })).toEqual({
      why: "no-function",
    });
  });

  test("join validation: a changed hash or an edit after start is source-moved; a shifted function no-function", async () => {
    const cov = await capture(BRANCHY, caseA);
    const ranges = rangesOf(cov, "checkout");
    const cfg = cfgOf(BRANCHY);
    expect(joinCfg({ cfg, ranges, capturedHash: "a", currentHash: "b" })).toEqual({ why: "source-moved" });
    expect(joinCfg({ cfg, ranges, capturedHash: "a", currentHash: "a", stale: true })).toEqual({ why: "source-moved" });
    // The same file with a line added above the function: the AST start no longer is V8's. With
    // the hash and mtime unchanged that is no edit: the model has no function there.
    const moved = cfgOf(BRANCHY, `// a new first line\n${fs.readFileSync(BRANCHY, "utf8")}`);
    expect(joinCfg({ cfg: moved, ranges, capturedHash: "a", currentHash: "a" })).toEqual({ why: "no-function" });
    expect(joinCfg({ cfg: moved, ranges, capturedHash: "a", currentHash: "a", typescript: true })).toEqual({
      why: "compiled",
    });
    expect(joinCfg({ cfg: undefined, ranges, capturedHash: "a", currentHash: "a" })).toEqual({ why: "no-analyzer" });
    expect("fn" in joinCfg({ cfg, ranges, capturedHash: "a", currentHash: "a" })).toBe(true);
  });
});

/* -------------------------------------------------------- payload analysis */

const ts = loadTypeScript(process.cwd());
// Generous parse budget: the production 250ms is wall time and folds under a loaded test run.
const analyzer = {
  cfg: (file: string, text: string) => buildCfg(ts, text, file, { maxMs: 10_000 }) as unknown as CfgFile,
};
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** A one-lane payload for `fn` of a fixture, the way capture.ts builds it. */
function payloadOf(abs: string, cov: FnCoverage[], fnName: string, extra: Partial<PathFn> = {}): PathPayload {
  const text = fs.readFileSync(abs, "utf8");
  const ranges = rangesOf(cov, fnName);
  const lineAt = (o: number) => text.slice(0, o).split("\n").length;
  const file = path.relative(FIXTURES, abs).replace(/\\/g, "/");
  const key = `${file}:${lineAt(ranges[0]!.start)}:${fnName}`;
  const fn: PathFn = {
    key,
    name: fnName,
    file,
    line: lineAt(ranges[0]!.start),
    mapping: "identity",
    sourceHash: sha(text),
    calls: { hops: ranges[0]!.count, coverage: ranges[0]!.count, checked: true },
    truth: { t: "taken", n: ranges[0]!.count },
    blocks: true,
    ranges: ranges.map((x) => ({ ...x, line: lineAt(x.start), endLine: lineAt(x.end - 1) })),
    ...extra,
  };
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
    lanes: [{ spanId: "s1", kind: "handler", name: "GET /checkout", depth: 0, calls: 1, truth: fn.truth, fnKey: key }],
    functions: { [key]: fn },
  };
}

describe("analyzePayload (lazy, cached on the payload)", () => {
  test("case C: the verdict line names the early return and the arm that led to it", async () => {
    const p = payloadOf(BRANCHY, await capture(BRANCHY, caseC), "checkout");
    const out = analyzePayload(p, { analyzer, root: FIXTURES });
    expect(out.text).toBe("Exited: return at GET /checkout L4 via if !user -> then");
    expect(out.exit).toMatchObject({ kind: "return", line: 4, via: { arm: "then" } });
    const fn = Object.values(p.functions)[0]!;
    expect(fn.analysis!.decisions.find((d) => d.line === 13)!.verdict).toBe("unreached");
    // Cached: a second call returns the same object and does not rebuild.
    expect(analyzePayload(p, { analyzer: undefined, root: FIXTURES })).toBe(out);
    expect(requestVerdict(p).text).toBe(out.text);
  });

  test("an edit after the capture makes every decision source-moved (never counted)", async () => {
    const p = payloadOf(BRANCHY, await capture(BRANCHY, caseA), "checkout");
    const edited = fs.readFileSync(BRANCHY, "utf8").replace("let total = 0;", "let total = 1;");
    analyzePayload(p, { analyzer, root: FIXTURES, readSource: () => edited });
    const a = Object.values(p.functions)[0]!.analysis!;
    expect(a).toMatchObject({ status: "unknown", why: "source-moved", decisions: [] });
    expect(p.analysis!.text).toBe("Exit: UNKNOWN (source-moved)");
  });

  test("contaminated, no analyzer, stale: UNKNOWN with the reason", async () => {
    const cov = await capture(BRANCHY, caseA);
    const c = payloadOf(BRANCHY, cov, "checkout", { truth: { t: "unknown", why: "contaminated" } });
    analyzePayload(c, { analyzer, root: FIXTURES });
    expect(Object.values(c.functions)[0]!.analysis).toMatchObject({ status: "unknown", why: "contaminated" });
    const n = payloadOf(BRANCHY, cov, "checkout");
    analyzePayload(n, { root: FIXTURES });
    expect(Object.values(n.functions)[0]!.analysis).toMatchObject({ status: "unknown", why: "no-analyzer" });
    const s = payloadOf(BRANCHY, cov, "checkout", { stale: true });
    analyzePayload(s, { analyzer, root: FIXTURES });
    expect(Object.values(s.functions)[0]!.analysis!.why).toBe("source-moved");
  });

  test("an analyzer that throws is an UNKNOWN function, not a failed request", async () => {
    const p = payloadOf(BRANCHY, await capture(BRANCHY, caseA), "checkout");
    const broken = {
      cfg: (): CfgFile => {
        throw new Error("parse");
      },
    };
    const out = analyzePayload(p, { analyzer: broken, root: FIXTURES });
    expect(Object.values(p.functions)[0]!.analysis!.status).toBe("unknown");
    expect(out.text).toBe("Exit: UNKNOWN (no-analyzer)");
  });

  test("the analysis of a report-sized payload stays well under 20ms once TypeScript is loaded", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ qty: i, price_cents: 3 }));
    const cov = await capture(REPORT, () => r.report(rows));
    analyzePayload(payloadOf(REPORT, cov, "report"), { analyzer, root: FIXTURES }); // warm
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      // A different text each time (same offsets): no CFG cache hit.
      const text = `${fs.readFileSync(REPORT, "utf8")}\n// ${i}\n`;
      const p = payloadOf(REPORT, cov, "report", { sourceHash: sha(text) });
      const out = analyzePayload(p, { analyzer, root: FIXTURES, readSource: () => text });
      expect(Object.values(p.functions)[0]!.analysis!.status).toBe("ok");
      times.push(out.ms);
    }
    expect(Math.min(...times)).toBeLessThan(20);
  });
});
