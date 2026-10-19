import { describe, expect, test } from "vitest";
import type { PathDecision, PathFn, PathNode, PathPayload } from "../src/api/types";
import {
  FLOW,
  type FlowLayout,
  type FlowNode,
  RUN_MIN,
  allFolds,
  flowEnter,
  flowNav,
  flowStart,
  joinTone,
  layoutFlow,
  toneOf,
} from "../src/state/pathFlow";
import graphs from "./fixtures/path-graphs.json";

/*
 * Request path flowchart (plan P4): the series-parallel layout (sizes, positions, folding), the
 * truth rendering (edge and node tones only from the server's counts) and the keyboard model.
 */

type Fx = { payload: PathPayload; source: Record<string, { start: number; lines: string[] }> };
const FX = graphs as unknown as Record<"checkout" | "early" | "big" | "throws", Fx>;
const fnOf = (fx: Fx, name: string) => Object.values(fx.payload.functions).find((f) => f.name === name)!;

/* ------------------------------------------------------- synthetic graphs */

let ids = 100;
const stmt = (line: number, n: number | null, label = `s${line}()`, extra: Partial<PathNode> = {}): PathNode => ({
  id: ids++,
  k: "stmt",
  line,
  endLine: line,
  n,
  label,
  ...extra,
});
const ret = (line: number, n: number | null): PathNode => ({
  id: ids++,
  k: "exit",
  exit: "return",
  line,
  endLine: line,
  n,
  label: "return x;",
});

function fnWith(body: PathNode[], decisions: PathDecision[] = [], extra: Partial<PathFn> = {}): PathFn {
  const graph: PathNode = { id: 0, k: "block", line: 1, endLine: 99, n: 1, body };
  return {
    key: "a.js:1:f",
    name: "f",
    file: "a.js",
    line: 1,
    startLine: 1,
    endLine: 99,
    mapping: "identity",
    calls: { hops: 1, coverage: 1, checked: true },
    truth: { t: "taken", n: 1 },
    blocks: true,
    analysis: {
      status: "ok",
      calls: 1,
      blended: false,
      decisions,
      loops: [],
      exits: [{ kind: "end", line: 99, count: 1 }],
      graph,
      nodeCount: 10,
    },
    ...extra,
  };
}

function payloadWith(fn: PathFn, more: PathFn[] = []): PathPayload {
  return {
    v: 2,
    traceId: "t",
    replayOf: "s",
    quality: "exact",
    contamination: [],
    warnings: [],
    window: { quietMs: 0, settleMs: 0, taint: [], retries: 0 },
    lanes: [{ spanId: "1", kind: "handler", name: "GET /", depth: 0, calls: 1, truth: fn.truth, fnKey: fn.key }],
    functions: Object.fromEntries([fn, ...more].map((f) => [f.key, f])),
  };
}

const layout = (fn: PathFn, open?: Set<string>, more: PathFn[] = []) =>
  layoutFlow(payloadWith(fn, more), fn, { open })!;

const byKind = (l: FlowLayout, kind: FlowNode["kind"]) => l.nodes.filter((n) => n.kind === kind);
const at = (l: FlowLayout, line: number) => l.nodes.find((n) => n.line === line && n.kind !== "callee")!;
const cx = (n: FlowNode) => n.x + n.w / 2;
const overlap = (a: FlowNode, b: FlowNode) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function noOverlaps(l: FlowLayout) {
  for (let i = 0; i < l.nodes.length; i++)
    for (let j = i + 1; j < l.nodes.length; j++)
      expect(overlap(l.nodes[i]!, l.nodes[j]!), `${l.nodes[i]!.key} vs ${l.nodes[j]!.key}`).toBe(false);
  for (const n of l.nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x + n.w).toBeLessThanOrEqual(l.w);
    expect(n.y + n.h).toBeLessThanOrEqual(l.h);
  }
}

const ifNode = (line: number, n: number | null, arms: PathNode["arms"], label = "c"): PathNode => ({
  id: ids++,
  k: "if",
  line,
  endLine: line + 4,
  n,
  label,
  arms,
});

/* ------------------------------------------------------------------ tones */

describe("truth tones", () => {
  test("a count's tone: > 0 taken, 0 not run, null UNKNOWN", () => {
    expect(toneOf(3)).toBe("taken");
    expect(toneOf(0)).toBe("not");
    expect(toneOf(null)).toBe("unknown");
    expect(toneOf(undefined)).toBe("unknown");
  });
  test("an edge is taken only when every end is: 0 wins, then UNKNOWN", () => {
    expect(joinTone("taken", "taken")).toBe("taken");
    expect(joinTone("taken", "unknown")).toBe("unknown");
    expect(joinTone("unknown", "not")).toBe("not");
    expect(joinTone("taken", "not")).toBe("not");
  });
});

/* ----------------------------------------------------------------- layout */

describe("series-parallel layout", () => {
  test("if / else: the diamond sits centred over two side-by-side arms, then left of else", () => {
    const f = fnWith([
      ifNode(2, 1, [
        { label: "then", line: 2, n: 1, body: [stmt(3, 1, "aaaaaaaaaaaaaaaa();")] },
        { label: "else", line: 4, n: 0, body: [stmt(5, 0)] },
      ]),
      stmt(7, 1),
    ]);
    // Open the else so both arms are in the row.
    const elseFirst = (f.analysis!.graph!.body![0]!.arms![1]!.body![0] as PathNode).id;
    const l = layout(f, new Set([`f${elseFirst}`]));
    const d = byKind(l, "decision")[0]!;
    const a = at(l, 3);
    const b = at(l, 5);
    expect(cx(a)).toBeLessThan(cx(d));
    expect(cx(b)).toBeGreaterThan(cx(d));
    expect(a.y).toBe(b.y);
    expect(a.y).toBe(d.y + FLOW.DIA_H + FLOW.FORK_GAP);
    // The join is centred again: the statement after the if sits under the diamond.
    expect(cx(at(l, 7))).toBeCloseTo(cx(d), 5);
    expect(at(l, 7).y).toBe(a.y + FLOW.BOX_H + FLOW.JOIN_GAP + FLOW.GAP_Y);
    noOverlaps(l);
  });

  test("an empty (implied) else routes from the diamond straight to the join, labelled with its count", () => {
    const f = fnWith([
      ifNode(2, 1, [
        { label: "then", line: 2, n: 1, body: [stmt(3, 1)] },
        { label: "else", line: 6, n: 0, implied: true },
      ]),
      stmt(7, 1),
    ]);
    const l = layout(f);
    const d = byKind(l, "decision")[0]!;
    const next = at(l, 7);
    const e = l.edges.find((x) => x.label?.text === "else 0")!;
    expect(e).toBeDefined();
    const end = e.pts[e.pts.length - 1]!;
    expect(end[0]).toBeCloseTo(cx(d), 5);
    expect(end[1]).toBe(next.y - FLOW.GAP_Y);
    expect(e.tone).toBe("not");
    noOverlaps(l);
  });

  test("a not-run if arm is a dashed stub beside the diamond, folded, and opens in place", () => {
    const thenBody = [stmt(3, 0), stmt(4, 0)];
    const f = fnWith([
      ifNode(2, 1, [
        { label: "then", line: 2, n: 0, body: thenBody },
        { label: "else", line: 6, n: 1, implied: true },
      ]),
    ]);
    const l = layout(f);
    const d = byKind(l, "decision")[0]!;
    const stub = byKind(l, "fold")[0]!;
    expect(stub.text).toBe("> 2 lines not run");
    // Beside the diamond, under its own label.
    expect(stub.y).toBeGreaterThan(d.y - FLOW.BOX_H);
    expect(stub.y).toBeLessThan(d.y + FLOW.DIA_H);
    expect(l.edges.find((e) => e.label?.text === "then 0")!.label!.y).toBeLessThan(stub.y);
    expect(stub.x).toBeGreaterThan(d.x + d.w);
    expect(l.edges.find((e) => e.label?.text === "then 0")!.tone).toBe("not");
    // Opening it puts the arm in the row, its statements dashed (not run).
    const open = layout(f, new Set([stub.toggle!]));
    expect(byKind(open, "fold")).toHaveLength(0);
    expect(at(open, 3).tone).toBe("not");
    expect(at(open, 3).y).toBeGreaterThan(d.y + FLOW.DIA_H);
  });

  test("nested loops: each adds its diamond, gap and pad; back edges carry the passes", () => {
    const inner: PathNode = {
      id: ids++,
      k: "loop",
      line: 3,
      endLine: 5,
      n: 2,
      passes: 6,
      label: "for (j)",
      body: [stmt(4, 6)],
    };
    const outer: PathNode = {
      id: ids++,
      k: "loop",
      line: 2,
      endLine: 6,
      n: 1,
      passes: 2,
      label: "for (i)",
      body: [inner],
    };
    const l = layout(fnWith([outer]));
    const [o, i] = byKind(l, "loop");
    expect(o!.line).toBe(2);
    expect(i!.y).toBe(o!.y + FLOW.DIA_H + FLOW.FORK_GAP);
    expect(at(l, 4).y).toBe(i!.y + FLOW.DIA_H + FLOW.FORK_GAP);
    const backs = l.edges.filter((e) => e.back);
    expect(backs.map((e) => e.label?.text).sort()).toEqual(["x2", "x6"]);
    expect(backs.every((e) => e.tone === "taken")).toBe(true);
    // The outer loop's box spans the inner one plus its pads on both sides.
    const end = byKind(l, "end")[0]!;
    expect(end.y).toBe(i!.y + (FLOW.DIA_H + FLOW.FORK_GAP + FLOW.BOX_H + FLOW.LOOP_PAD) + FLOW.LOOP_PAD + FLOW.GAP_Y);
    noOverlaps(l);
  });

  test("switch: a fan-out with one column per case, an implied 'no match' arm without default", () => {
    const sw: PathNode = {
      id: ids++,
      k: "switch",
      line: 2,
      endLine: 9,
      n: 1,
      label: "s",
      decisions: ["switch#0"],
      arms: [
        {
          label: 'case "a"',
          line: 3,
          n: 1,
          body: [stmt(4, 1), { id: ids++, k: "exit", exit: "break", line: 5, endLine: 5, n: 1, label: "break;" }],
        },
        { label: 'case "b"', line: 6, n: 0, body: [ret(7, 0)] },
      ],
    };
    const d: PathDecision = {
      id: "switch#0",
      nodeId: sw.id,
      kind: "switch",
      line: 2,
      label: "s",
      reach: 1,
      arms: [
        { label: 'case "a"', count: 1, taken: "taken" },
        { label: 'case "b"', count: 0, taken: "not-taken" },
        { label: "no match", count: 0, taken: "not-taken", implied: true },
      ],
      verdict: "one",
      summary: 'case "a"',
      inLoop: false,
    };
    const l = layout(fnWith([sw, stmt(10, 1)], [d]));
    const labels = l.edges.filter((e) => e.label).map((e) => e.label!.text);
    expect(labels).toEqual(['case "a" 1', 'case "b" 0', "no match 0"]);
    // break joins the code after the switch (solid), the not-run case is a fold.
    const brk = at(l, 5);
    expect(l.edges.some((e) => e.pts[0]![1] === brk.y + brk.h && e.tone === "taken")).toBe(true);
    expect(byKind(l, "fold")[0]!.line).toBe(7);
    expect(byKind(l, "decision")[0]!.aria).toBe(
      'decision switch (s): case "a" taken 1 time, case "b" not taken, no match not taken',
    );
    noOverlaps(l);
  });

  test("try / catch / finally: one frame holding every part, finally after the join", () => {
    const tr: PathNode = {
      id: ids++,
      k: "try",
      line: 2,
      endLine: 8,
      n: 1,
      arms: [
        { label: "try", line: 2, n: 1, body: [stmt(3, 1)] },
        { label: "catch", line: 4, n: 0, body: [stmt(5, 0)] },
        { label: "finally", line: 6, n: 1, body: [stmt(7, 1)] },
      ],
    };
    const l = layout(fnWith([tr, stmt(9, 1)]));
    const fr = l.frames[0]!;
    expect(fr.label).toBe("try");
    for (const line of [3, 5, 7]) {
      const n = at(l, line);
      expect(n.x).toBeGreaterThanOrEqual(fr.x);
      expect(n.x + n.w).toBeLessThanOrEqual(fr.x + fr.w);
      expect(n.y).toBeGreaterThanOrEqual(fr.y + FLOW.FRAME_HEAD);
      expect(n.y + n.h).toBeLessThanOrEqual(fr.y + fr.h);
    }
    expect(at(l, 7).y).toBeGreaterThan(at(l, 3).y);
    expect(at(l, 5).tone).toBe("not");
    expect(l.edges.find((e) => e.label?.text === "finally 1")!.tone).toBe("taken");
    expect(at(l, 9).y).toBe(fr.y + fr.h + FLOW.GAP_Y);
    noOverlaps(l);
  });

  test("early exit: a taken return arm draws no edge to the join; the code after it folds", () => {
    const l = layoutFlow(FX.early.payload, fnOf(FX.early, "checkout"))!;
    const exit = l.nodes.find((n) => n.kind === "exit" && n.line === 4)!;
    expect(exit.tone).toBe("taken");
    expect(exit.exitMark).toBe(true);
    expect(exit.aria).toContain("The request's exit");
    expect(l.edges.some((e) => e.pts[0]![1] === exit.y + exit.h)).toBe(false);
    const folds = byKind(l, "fold");
    expect(folds).toHaveLength(1);
    expect(folds[0]!.text).toMatch(/^> \d+ lines not run$/);
    expect(folds[0]!.line).toBe(6);
    // Nothing the server counted 0 is drawn as taken.
    for (const n of l.nodes) if (n.kind !== "entry" && n.line! > 5) expect(n.tone).not.toBe("taken");
  });

  test(`folding thresholds: ${RUN_MIN}+ plain statements with one count are one box; fewer stay apart`, () => {
    const run = fnWith([stmt(2, 1), stmt(3, 1), stmt(4, 1), stmt(5, 2), stmt(6, 2)]);
    const l = layout(run);
    const runs = byKind(l, "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe("L2-4: 3 statements");
    expect(runs[0]!.count).toBe("x1");
    expect(byKind(l, "stmt").map((n) => n.line)).toEqual([5, 6]);
    // Open: each statement again.
    expect(byKind(layout(run, new Set([runs[0]!.toggle!])), "stmt")).toHaveLength(5);
    // A statement with a linked callee never folds into a run (its link stays reachable).
    const linked = fnWith([
      stmt(2, 1),
      stmt(3, 1, "g();", { calls: ["g"], callees: [{ name: "g", fnKey: "a.js:9:g" }] }),
      stmt(4, 1),
    ]);
    expect(byKind(layout(linked), "run")).toHaveLength(0);
  });

  test("checkout (mockup C): entry, guards, loop xN, switch fan-out, try frame, callee link, exit", () => {
    const fx = FX.checkout;
    const fn = fnOf(fx, "checkout");
    const l = layoutFlow(fx.payload, fn)!;
    expect(l.nodes[0]!.kind).toBe("entry");
    expect(l.nodes[0]!.count).toBe("x1");
    expect(byKind(l, "decision").map((d) => d.line)).toEqual([3, 8, 13]);
    expect(byKind(l, "loop")[0]!.count).toBe("x3");
    expect(l.edges.find((e) => e.back)!.label!.text).toBe("x3");
    expect(l.frames.map((f) => f.label)).toEqual(["try"]);
    const callee = byKind(l, "callee")[0]!;
    expect(callee.fnKey).toBe(fnOf(fx, "save").key);
    expect(callee.text).toBe("-> save()");
    const exit = l.nodes.find((n) => n.kind === "exit" && n.line === 29)!;
    expect(exit.exitMark).toBe(true);
    // The ternary and the && are tags on their statements, as the server summarises them.
    expect(at(l, 11).tags!.map((t) => [t.text, t.tone])).toEqual([["user.vip ? -> false", "taken"]]);
    expect(at(l, 12).tags!.map((t) => [t.text, t.tone])).toEqual([["order.coupon && -> right", "taken"]]);
    // then 1/3 . else 2/3 inside the loop: both arms solid, the continue ends its arm.
    expect(l.edges.find((e) => e.label?.text === "then 1")!.tone).toBe("taken");
    expect(l.edges.find((e) => e.label?.text === "else 2")!.tone).toBe("taken");
    noOverlaps(l);
  });

  test("a 200-statement handler folded stays under ~1500px tall and lays out fast", () => {
    const fx = FX.big;
    const fn = fnOf(fx, "big");
    expect(fn.analysis!.nodeCount).toBeGreaterThan(200);
    const t0 = performance.now();
    const l = layoutFlow(fx.payload, fn)!;
    expect(performance.now() - t0).toBeLessThan(50);
    expect(l.h).toBeLessThan(1500);
    expect(byKind(l, "run").length).toBeGreaterThanOrEqual(10);
    expect(byKind(l, "fold")).toHaveLength(10);
    noOverlaps(l);
  });

  test("no graph (UNKNOWN function, graphs dropped): no layout", () => {
    const f = fnWith([stmt(2, 1)]);
    f.analysis = { ...f.analysis!, status: "unknown", why: "compiled", graph: undefined };
    expect(layoutFlow(payloadWith(f), f)).toBeNull();
  });
});

/* -------------------------------------------------------- truth rendering */

describe("truth rendering", () => {
  test("arm edges take their arm's truth: never solid for UNKNOWN or not taken", () => {
    const f = fnWith([
      ifNode(2, 1, [
        { label: "then", line: 2, n: null, why: "after-throw", body: [stmt(3, null, "a();", { why: "after-throw" })] },
        { label: "else", line: 4, n: 0, implied: true },
      ]),
      stmt(7, null, "b();", { why: "after-throw" }),
    ]);
    const l = layout(f);
    const then = l.edges.find((e) => e.label?.text === "then ?")!;
    expect(then.tone).toBe("unknown");
    expect(l.edges.find((e) => e.label?.text === "else 0")!.tone).toBe("not");
    expect(at(l, 3).tone).toBe("unknown");
    expect(at(l, 3).count).toBe("?");
    expect(at(l, 3).aria).toContain("UNKNOWN: an exception was thrown before this point");
    // Every edge into or out of an UNKNOWN / not-run node is not solid.
    const weak = l.nodes.filter((n) => n.tone !== "taken");
    for (const e of l.edges) {
      const [x1, y1] = e.pts[e.pts.length - 1]!;
      const into = weak.find((n) => Math.abs(n.y - y1) < 0.5 && x1 >= n.x && x1 <= n.x + n.w);
      if (into) expect(e.tone).not.toBe("taken");
    }
  });

  test("after-throw fixture: the statements after the throwing call are hatched, none solid", () => {
    const l = layoutFlow(FX.throws.payload, fnOf(FX.throws, "caller"))!;
    expect(at(l, 10).tone).toBe("taken");
    for (const line of [11, 12])
      expect(at(l, line).tone === "unknown" || byKind(l, "run")[0]?.tone === "unknown").toBe(true);
    const into = l.edges.filter((e) => e.pts[e.pts.length - 1]![1] > at(l, 10).y + FLOW.BOX_H);
    expect(into.length).toBeGreaterThan(0);
    for (const e of into) expect(e.tone).toBe("unknown");
  });

  test("a callee in a decision's test links from beside the diamond; a call that did not run links grey", () => {
    // GET /api/products/:id on a miss: `if (!(await findProduct(id)))` then a not-run second call.
    const callee = [{ name: "findProduct", fnKey: "s.js:9:findProduct" }];
    const f = fnWith([
      {
        ...ifNode(19, 1, [
          { label: "then", line: 19, n: 1, body: [ret(21, 1)] },
          { label: "else", line: 22, n: 0, implied: true },
        ]),
        label: "!(await findProduct(id))",
        calls: ["findProduct"],
        callees: callee,
      },
      stmt(23, 0, "const product = await findProduct(id);", { calls: ["findProduct"], callees: callee }),
    ]);
    const f2 = { ...fnWith([]), key: "s.js:9:findProduct", name: "findProduct" };
    const open = byKind(layout(f, undefined, [f2]), "decision")[0]!;
    const l = layout(f, undefined, [f2]);
    const chips = byKind(l, "callee");
    const d = byKind(l, "decision")[0]!;
    expect(open.fnKey).toBe("s.js:9:findProduct");
    expect(chips[0]!.x + chips[0]!.w).toBeLessThanOrEqual(d.x);
    expect(chips[0]!.tone).toBe("taken");
    // The second call never ran (it is folded away until opened): its chip is not taken.
    const opened = layout(f, new Set([`f${f.analysis!.graph!.body![1]!.id}`]), [f2]);
    const late = byKind(opened, "callee").find((c) => c.line === 23)!;
    expect(late.tone).toBe("not");
    noOverlaps(l);
  });
});

/* --------------------------------------------------------------- keyboard */

describe("keyboard model", () => {
  const l = layoutFlow(FX.checkout.payload, fnOf(FX.checkout, "checkout"))!;
  test("Down / Up walk the nodes in reading order and stop at the ends", () => {
    const first = l.nodes[0]!.key;
    expect(flowNav(l.nodes, first, "ArrowUp")).toBe(first);
    expect(flowNav(l.nodes, first, "ArrowDown")).toBe(l.nodes[1]!.key);
    const last = l.nodes[l.nodes.length - 1]!.key;
    expect(flowNav(l.nodes, last, "ArrowDown")).toBe(last);
    expect(flowNav(l.nodes, null, "ArrowDown")).toBe(first);
    expect(flowNav(l.nodes, first, "End")).toBe(last);
  });
  test("Right / Left move to the nearest node on that side (the save() link from its statement)", () => {
    const s = l.nodes.find((n) => n.kind === "stmt" && n.line === 23)!;
    const chip = l.nodes.find((n) => n.kind === "callee")!;
    // The chip sits under its statement: Down reaches it, Enter follows it.
    expect(flowNav(l.nodes, s.key, "ArrowDown")).toBe(chip.key);
    expect(flowEnter(chip)).toEqual({ t: "open", fnKey: fnOf(FX.checkout, "save").key });
    expect(flowEnter(s)).toEqual({ t: "open", fnKey: chip.fnKey });
    const d = l.nodes.find((n) => n.kind === "decision" && n.line === 3)!;
    const stub = l.nodes.find((n) => n.kind === "fold" && n.line === 4)!;
    expect(flowNav(l.nodes, d.key, "ArrowRight")).toBe(stub.key);
    expect(flowNav(l.nodes, stub.key, "ArrowLeft")).toBe(d.key);
    expect(flowEnter(stub)).toEqual({ t: "toggle", key: stub.toggle });
    expect(flowEnter(d)).toBeNull();
  });
  test("the first focus is the node at the chip's line, else the entry", () => {
    expect(flowStart(l, 13)).toBe(l.nodes.find((n) => n.kind === "decision" && n.line === 13)!.key);
    expect(flowStart(l)).toBe("entry");
  });
  test("aria labels per node name the decision and each arm's truth", () => {
    const f = fnWith(
      [
        {
          ...ifNode(2, 1, [
            { label: "then", line: 2, n: 0, body: [stmt(3, 0)] },
            { label: "else", line: 4, n: 1, implied: true },
          ]),
          label: "user.vip",
          decisions: ["if#0"],
        },
      ],
      [],
    );
    const node = f.analysis!.graph!.body![0]!;
    f.analysis!.decisions = [
      {
        id: "if#0",
        nodeId: node.id,
        kind: "if",
        line: 2,
        label: "user.vip",
        reach: 1,
        arms: [
          { label: "then", count: 0, taken: "not-taken" },
          { label: "else", count: 1, taken: "taken", implied: true },
        ],
        verdict: "one",
        summary: "else",
        inLoop: false,
      },
    ];
    const d = byKind(layout(f), "decision")[0]!;
    expect(d.aria).toBe("decision if user.vip: then not taken, else taken 1 time");
  });
});

/* -------------------------------------------------------- review fixes */

const brk = (line: number, n: number | null): PathNode => ({
  id: ids++,
  k: "exit",
  exit: "break",
  line,
  endLine: line,
  n,
  label: "break;",
});
const outOf = (l: FlowLayout, n: FlowNode) =>
  l.edges.filter((e) => Math.abs(e.pts[0]![1] - (n.y + n.h)) < 0.5 && e.pts[0]![0] >= n.x && e.pts[0]![0] <= n.x + n.w);

describe("truth of edges out of an arm", () => {
  test("try body ending in an UNKNOWN (after-throw) node: its edge to the join is not solid", () => {
    const tr: PathNode = {
      id: ids++,
      k: "try",
      line: 40,
      endLine: 50,
      n: 1,
      arms: [
        {
          label: "try",
          line: 40,
          n: 1,
          body: [stmt(45, 1, "risky();"), stmt(46, null, "log.push(r);", { why: "after-throw" })],
        },
        { label: "catch", line: 47, n: 1, body: [stmt(48, 1, "log.push(e);")] },
      ],
    };
    const l = layout(fnWith([tr, stmt(51, 1)]));
    const after = outOf(l, at(l, 46));
    expect(after.length).toBeGreaterThan(0);
    for (const e of after) expect(e.tone).toBe("unknown");
    // The catch arm ran to its end: that edge stays solid.
    expect(outOf(l, at(l, 48)).every((e) => e.tone === "taken")).toBe(true);
  });

  test("a loop back edge from an UNKNOWN last node is not solid", () => {
    const loop: PathNode = {
      id: ids++,
      k: "loop",
      line: 2,
      endLine: 5,
      n: 1,
      passes: 3,
      label: "for (x of xs)",
      body: [stmt(3, 3), stmt(4, null, "b();", { why: "after-throw" })],
    };
    const l = layout(fnWith([loop]));
    const back = l.edges.find((e) => e.back)!;
    expect(back.tone).toBe("unknown");
  });
});

describe("switch fallthrough and nested breaks", () => {
  const sw = (arms: PathNode["arms"]): PathNode => ({
    id: ids++,
    k: "switch",
    line: 2,
    endLine: 12,
    n: 1,
    label: "x",
    arms,
  });

  test("a clause that falls through draws its edge into the next clause, not to the join", () => {
    const s = sw([
      { label: "case 1", line: 3, n: 1, fallsThrough: true, body: [stmt(4, 1, "a();")] },
      { label: "case 2", line: 5, n: 0, body: [stmt(6, 1, "b();"), brk(7, 1)] },
      { label: "default", line: 8, n: 0, body: [stmt(9, 0, "c();"), brk(10, 0)] },
    ]);
    const l = layout(fnWith([s, stmt(13, 1)]));
    const a = at(l, 4);
    const b = at(l, 6);
    const [e, ...more] = outOf(l, a);
    expect(more).toHaveLength(0);
    const end = e!.pts[e!.pts.length - 1]!;
    // Ends at clause 2's first box (from its left), never at the switch join (under the diamond).
    expect(end[0]).toBeCloseTo(b.x, 5);
    expect(end[1]).toBeGreaterThan(b.y);
    expect(end[1]).toBeLessThan(b.y + b.h);
    expect(e!.tone).toBe("taken");
  });

  test("an empty clause sharing the next one's body routes into that clause, not to the join", () => {
    const s = sw([
      { label: "case 1", line: 3, n: 1, fallsThrough: true, sharedArm: "case 2", body: [] },
      { label: "case 2", line: 4, n: 1, sharedArm: "case 2", body: [stmt(5, 1, "b();"), brk(6, 1)] },
      { label: "default", line: 7, n: 0, body: [] },
    ]);
    const l = layout(fnWith([s, stmt(13, 1)]));
    const e = l.edges.find((x) => x.label?.text.startsWith("case 1"))!;
    const end = e.pts[e.pts.length - 1]!;
    const b = at(l, 5);
    expect(end[0]).toBeCloseTo(b.x, 5);
    expect(end[1]).toBeGreaterThan(b.y);
    expect(end[1]).toBeLessThan(b.y + b.h);
    expect(e.tone).toBe("taken");
  });

  test("a break inside an if under a case still ends the clause into the code after the switch", () => {
    const inner = ifNode(4, 1, [
      { label: "then", line: 4, n: 1, body: [stmt(5, 1, "x();"), brk(6, 1)] },
      { label: "else", line: 7, n: 0, body: [stmt(8, 0, "y();"), brk(9, 0)] },
    ]);
    const s = sw([
      { label: "case 1", line: 3, n: 1, body: [inner] },
      { label: "default", line: 10, n: 1, body: [ret(11, 1)] },
    ]);
    const l = layout(fnWith([s, stmt(13, 1, "after();")]));
    const after = at(l, 13);
    // The code after the switch is wired (an edge ends on it) and the end pill is drawn.
    expect(l.edges.some((e) => Math.abs(e.pts[e.pts.length - 1]![1] - after.y) < 0.5)).toBe(true);
    expect(byKind(l, "end")).toHaveLength(1);
    // The break that ran does not flow on into code inside the clause.
    expect(outOf(l, at(l, 6))).toHaveLength(0);
  });
});

describe("stubs, diamonds, chips", () => {
  test("each not-run stub carries its own label above its own box", () => {
    const f = fnWith([
      ifNode(2, 1, [
        { label: "then", line: 2, n: 0, body: [stmt(3, 0)] },
        { label: "else if n === 0", line: 4, n: 0, body: [stmt(5, 0)] },
        { label: "else if n < 5", line: 6, n: 0, body: [stmt(7, 0)] },
        { label: "else", line: 8, n: 1, body: [stmt(9, 1)] },
      ]),
    ]);
    const l = layout(f);
    const folds = byKind(l, "fold");
    expect(folds).toHaveLength(3);
    const labs = ["then 0", "else if n === 0 0", "else if n < 5 0"].map(
      (t) => l.edges.find((e) => e.label?.text === t)!.label!,
    );
    expect(new Set(labs.map((x) => x.y)).size).toBe(3);
    labs.forEach((lab, i) => {
      expect(lab.y).toBeLessThanOrEqual(folds[i]!.y);
      expect(lab.y).toBeGreaterThan(i ? folds[i - 1]!.y + folds[i - 1]!.h : 0);
      expect(lab.x).toBeCloseTo(folds[i]!.x, 5);
      expect(lab.x + lab.text.length * FLOW.TAG_CH).toBeLessThanOrEqual(l.w);
    });
    noOverlaps(l);
  });

  test("stubs taller than the diamond: the spine still runs into and out of it", () => {
    const f = fnWith([
      stmt(1, 1),
      ifNode(2, 1, [
        { label: "then", line: 2, n: 0, body: [stmt(3, 0)] },
        { label: "else if a", line: 4, n: 0, body: [stmt(5, 0)] },
        { label: "else", line: 6, n: 1, body: [stmt(7, 1)] },
      ]),
    ]);
    const l = layout(f);
    const d = byKind(l, "decision")[0]!;
    const ends = (y: number) =>
      l.edges.some((e) => e.pts.some(([x, py]) => Math.abs(py - y) < 0.5 && Math.abs(x - cx(d)) < 0.5));
    expect(d.y).toBeGreaterThan(at(l, 1).y + FLOW.BOX_H + FLOW.GAP_Y);
    expect(ends(d.y)).toBe(true);
    expect(ends(d.y + FLOW.DIA_H)).toBe(true);
  });

  test("a short condition fits its diamond uncut", () => {
    const f = fnWith([ifNode(2, 1, [{ label: "then", line: 2, n: 1, body: [stmt(3, 1)] }], "(n === 0)")]);
    expect(byKind(layout(f), "decision")[0]!.text).toBe("if (n === 0)");
  });

  test("no blank strip left of a fork whose stubs sit on its right", () => {
    const f = fnWith([
      ifNode(2, 1, [
        { label: "then", line: 2, n: 0, body: [stmt(3, 0), stmt(4, 0)] },
        { label: "else", line: 5, n: 1, implied: true },
      ]),
      stmt(7, 1),
    ]);
    const l = layout(f);
    const minX = Math.min(...l.nodes.map((n) => n.x));
    const maxX = Math.max(...l.nodes.map((n) => n.x + n.w));
    expect(minX).toBeLessThanOrEqual(FLOW.MARGIN + 1);
    expect(l.w - maxX).toBeLessThanOrEqual(FLOW.MARGIN + 1);
    noOverlaps(l);
  });

  test("a diamond that links its callee says so in its label", () => {
    const callee = [{ name: "findProduct", fnKey: "s.js:9:findProduct" }];
    const f = fnWith([
      {
        ...ifNode(19, 1, [
          { label: "then", line: 19, n: 1, body: [ret(21, 1)] },
          { label: "else", line: 22, n: 0, implied: true },
        ]),
        label: "!(await findProduct(id))",
        calls: ["findProduct"],
        callees: callee,
      },
    ]);
    const d = byKind(layout(f), "decision")[0]!;
    expect(d.fnKey).toBe("s.js:9:findProduct");
    expect(d.aria).toContain("Calls findProduct, Enter opens it");
  });

  test("only calls the server marks ambiguous get the 'not linked' tag", () => {
    const g: PathFn = { ...fnWith([]), key: "b.js:1:g", name: "g" };
    const plainCall = layout(fnWith([stmt(2, 1, "g();", { calls: ["g"] })]), undefined, [g]);
    expect(at(plainCall, 2).tags).toBeUndefined();
    const amb = layout(fnWith([stmt(2, 1, "g();", { calls: ["g"], ambiguous: ["g"] })]), undefined, [g]);
    expect(at(amb, 2).tags![0]!.text).toBe("g()");
    expect(at(amb, 2).tags![0]!.title).toMatch(/more than one/);
  });
});

describe("unfold everything (u) and focus keys", () => {
  test("allFolds opens every fold, run and stub, nested ones included", () => {
    const big = Object.values(FX.big.payload.functions).find((f) => f.analysis?.graph)!;
    const l = layoutFlow(FX.big.payload, big, { open: allFolds(FX.big.payload, big) })!;
    expect(l.nodes.filter((n) => n.toggle)).toHaveLength(0);
    const nested = fnWith([
      ifNode(2, 1, [
        {
          label: "then",
          line: 2,
          n: 0,
          body: [ifNode(3, 0, [{ label: "then", line: 3, n: 0, body: [stmt(4, 0)] }])],
        },
        { label: "else", line: 6, n: 1, implied: true },
      ]),
    ]);
    const nl = layout(nested, allFolds(payloadWith(nested), nested));
    expect(nl.nodes.filter((n) => n.toggle)).toHaveLength(0);
    expect(at(nl, 4)).toBeDefined();
  });

  test("flowStart prefers the node key it is given (back from a followed callee)", () => {
    const l = layoutFlow(FX.checkout.payload, fnOf(FX.checkout, "checkout"))!;
    const chip = byKind(l, "callee")[0]!;
    expect(flowStart(l, undefined, chip.key)).toBe(chip.key);
    expect(flowStart(l, undefined, "nope")).toBe(l.nodes[0]!.key);
  });
});
