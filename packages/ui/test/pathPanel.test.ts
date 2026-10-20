import { describe, expect, test } from "vitest";
import type { PathPayload } from "../src/api/types";
import {
  FLOW_MAX_NODES,
  type PanelState,
  SOURCE_FOLD_MIN,
  crumbs,
  evidenceText,
  flowUnavailable,
  fnCalls,
  gutterRows,
  panelReduce,
  sourceBlocks,
  sourceMoved,
  viewFor,
} from "../src/state/pathPanel";
import graphs from "./fixtures/path-graphs.json";

/*
 * Request path function panel (plan P4): the panel stack (breadcrumb, Backspace, callee links), the
 * Flow / Source default, the evidence footer and the Source view's gutter model (mockup D).
 */

type Fx = { payload: PathPayload; source: Record<string, { start: number; lines: string[] }> };
const FX = graphs as unknown as Record<"checkout" | "early" | "big" | "throws", Fx>;
const fnOf = (fx: Fx, name: string) => Object.values(fx.payload.functions).find((f) => f.name === name)!;
const rowsOf = (fx: Fx, name: string) => {
  const fn = fnOf(fx, name);
  return gutterRows(fx.payload, fn, fx.source[fn.key]!);
};

describe("panel stack (keyboard model: Enter on a lane, a callee link, Backspace, breadcrumb, Esc)", () => {
  const open = panelReduce(null, { t: "open", traceId: "t1", fnKey: "h", line: 21 })!;
  test("opening from the trail starts a stack with the line the chip pointed at", () => {
    expect(open).toEqual({ traceId: "t1", stack: ["h"], view: null, line: 21 });
  });
  test("a callee link pushes; Backspace pops back to the caller, then closes", () => {
    const deep = panelReduce(open, { t: "push", fnKey: "find" })!;
    expect(deep.stack).toEqual(["h", "find"]);
    expect(deep.line).toBeUndefined();
    // Following the same function again is no new level (recursion).
    expect(panelReduce(deep, { t: "push", fnKey: "find" })).toBe(deep);
    const back = panelReduce(deep, { t: "back" })!;
    expect(back.stack).toEqual(["h"]);
    expect(panelReduce(back, { t: "back" })).toBeNull();
  });
  test("breadcrumb: a crumb cuts the stack there, 'Trail' closes; Esc closes", () => {
    let s: PanelState | null = open;
    for (const k of ["a", "b", "c"]) s = panelReduce(s, { t: "push", fnKey: k });
    expect(panelReduce(s, { t: "crumb", depth: 1 })!.stack).toEqual(["h", "a"]);
    expect(panelReduce(s, { t: "crumb", depth: -1 })).toBeNull();
    expect(panelReduce(s, { t: "close" })).toBeNull();
  });
  test("v sticks for the trace (re-opening keeps it), a new trace starts at the default", () => {
    const v = panelReduce(open, { t: "view", view: "source" })!;
    expect(panelReduce(v, { t: "open", traceId: "t1", fnKey: "x" })!.view).toBe("source");
    expect(panelReduce(v, { t: "open", traceId: "t2", fnKey: "x" })!.view).toBeNull();
  });
  test("crumbs name the handler by its lane, callees by function name", () => {
    const p = FX.checkout.payload;
    expect(crumbs(p, [fnOf(FX.checkout, "checkout").key, fnOf(FX.checkout, "save").key])).toEqual([
      "Trail",
      "POST /checkout",
      "save",
    ]);
  });
});

describe("Flow / Source default", () => {
  const p = FX.checkout.payload;
  const fn = fnOf(FX.checkout, "checkout");
  test("Flow on desktop for a small function, Source on phones", () => {
    expect(viewFor({ view: null }, p, fn, false)).toBe("flow");
    expect(viewFor({ view: null }, p, fn, true)).toBe("source");
    expect(viewFor({ view: "flow" }, p, fn, true)).toBe("flow");
  });
  test(`Source first above ${FLOW_MAX_NODES} graph nodes (the 200-statement handler)`, () => {
    const big = fnOf(FX.big, "big");
    expect(big.analysis!.nodeCount).toBeGreaterThan(FLOW_MAX_NODES);
    expect(viewFor({ view: null }, FX.big.payload, big, false)).toBe("source");
    expect(viewFor({ view: "flow" }, FX.big.payload, big, false)).toBe("flow");
  });
  test("no flowchart (UNKNOWN, graphs dropped): Source only, with the reason", () => {
    const unknown = { ...fn, analysis: { ...fn.analysis!, status: "unknown" as const, why: "compiled" as const } };
    expect(flowUnavailable(p, unknown)).toMatch(/^UNKNOWN: the app runs compiled output/);
    expect(viewFor({ view: "flow" }, p, unknown, false)).toBe("source");
    const dropped = { ...fn, analysis: { ...fn.analysis!, graph: undefined } };
    const pd = { ...p, analysis: { ...p.analysis!, graphsDropped: true } };
    expect(flowUnavailable(pd, dropped)).toMatch(/left out/);
    expect(flowUnavailable(p, fn)).toBeNull();
  });
  test("evidence footer", () => {
    expect(evidenceText(p, fn)).toBe("block coverage . identity map . quiet window . EXACT");
    const blended = { ...fn, analysis: { ...fn.analysis!, calls: 3, blended: true } };
    const tainted = { ...p, quality: "contaminated" as const, window: { ...p.window, taint: ["GET /x"] } };
    expect(evidenceText(tainted, blended)).toBe(
      "block coverage . identity map . window tainted . 3 calls: totals . CONTAMINATED",
    );
  });
});

describe("source gutter model (mockup D)", () => {
  const rows = rowsOf(FX.checkout, "checkout");
  const row = (line: number) => rows.find((r) => r.line === line)!;
  test("counts per line from the server graph: x1, 0, x3, with header and closing lines kept", () => {
    expect(rows[0]!.line).toBe(2);
    expect([3, 4, 5, 6].map((l) => row(l).count)).toEqual(["x1", "0", "x1", "x1"]);
    expect(row(4).tone).toBe("not");
    // `if (item.qty <= 0) continue;` reads the if's reach (3), not the continue's (1).
    expect(row(8).count).toBe("x3");
    expect(row(9).count).toBe("x2");
    expect(row(10).count).toBe("x1"); // the loop statement's closing line: its own count
    expect([17, 18, 19, 20].map((l) => row(l).count)).toEqual(["0", "0", "0", "0"]);
    expect(row(21).count).toBe("x1");
    expect([24, 25, 26, 27, 28].map((l) => row(l).count)).toEqual(["0", "0", "x1", "x1", "x1"]);
  });
  test("decision lines carry the arm taken, loops their passes, exits their mark", () => {
    expect(row(3).notes.map((n) => [n.text, n.tone])).toEqual([["-> else", "taken"]]);
    expect(row(8).notes.map((n) => [n.text, n.tone])).toEqual([["then 1/3 . else 2/3", "split"]]);
    expect(row(7).notes.map((n) => n.text)).toEqual(["x3"]);
    expect(row(11).notes.map((n) => n.text)).toEqual(["user.vip ? -> false"]);
    expect(row(13).notes.map((n) => n.text)).toEqual(['-> case "new"']);
    expect(row(29).exit).toBe("request");
    expect(row(29).notes.map((n) => n.text)).toEqual(["return (the request's exit)"]);
    // A not-run return is no exit mark.
    expect(row(18).exit).toBeUndefined();
  });
  test("case C: everything after the early return reads 0, the return is the request's exit", () => {
    const c = rowsOf(FX.early, "checkout");
    const at = (l: number) => c.find((r) => r.line === l)!;
    expect(at(4).count).toBe("x1");
    expect(at(4).exit).toBe("request");
    for (let l = 6; l <= 29; l++) if (at(l).text.trim()) expect([l, at(l).count]).toEqual([l, "0"]);
    expect(at(13).notes.map((n) => [n.text, n.tone])).toEqual([["not reached", "not"]]);
  });
  test("UNKNOWN lines are '?' with the reason, never a count", () => {
    const t = rowsOf(FX.throws, "caller");
    const at = (l: number) => t.find((r) => r.line === l)!;
    expect(at(10).count).toBe("x1");
    for (const l of [11, 12, 13]) {
      expect(at(l).count).toBe("?");
      expect(at(l).tone).toBe("unknown");
      expect(at(l).why).toBe("after-throw");
    }
  });
  test("a function with no graph: every code line '?' with the function's reason", () => {
    const fn = fnOf(FX.checkout, "checkout");
    const unknown = { ...fn, analysis: { ...fn.analysis!, status: "unknown" as const, why: "source-moved" as const } };
    const r = gutterRows(FX.checkout.payload, unknown, FX.checkout.source[fn.key]!);
    expect(r.filter((x) => x.text.trim()).every((x) => x.count === "?" && x.why === "source-moved")).toBe(true);
    expect(r.every((x) => !x.notes.length)).toBe(true);
  });
  test(`not-run regions of ${SOURCE_FOLD_MIN}+ lines fold ('> N lines not run'); single lines stay, dimmed`, () => {
    const blocks = sourceBlocks(rows, new Set());
    const folds = blocks.filter((b) => b.t === "fold");
    expect(folds.map((f) => (f.t === "fold" ? [f.from, f.to, f.lines, f.open] : []))).toEqual([
      [17, 20, 4, false],
      [24, 25, 2, false],
    ]);
    // L4 alone is not folded.
    expect(blocks.some((b) => b.t === "row" && b.row.line === 4 && b.row.tone === "not")).toBe(true);
    const opened = sourceBlocks(rows, new Set(["s17"]));
    const f = opened.find((b) => b.t === "fold" && b.from === 17);
    expect(f && f.t === "fold" && f.open).toBe(true);
    expect(f && f.t === "fold" && f.rows.map((r) => r.line)).toEqual([17, 18, 19, 20]);
  });
});

describe("review fixes", () => {
  test("Backspace from a followed callee returns to the chip it was opened from", () => {
    const open = panelReduce(null, { t: "open", traceId: "t1", fnKey: "h", line: 21 })!;
    const deep = panelReduce(open, { t: "push", fnKey: "find", from: { key: "n22c16", line: 22 } })!;
    expect(deep.focus).toBeUndefined();
    const back = panelReduce(deep, { t: "back" })!;
    expect(back.stack).toEqual(["h"]);
    expect(back.focus).toBe("n22c16");
    expect(back.line).toBe(22);
    // A breadcrumb back to the caller lands on the chip too.
    const two = panelReduce(deep, { t: "push", fnKey: "deeper", from: { key: "n5c2", line: 5 } })!;
    const crumb = panelReduce(two, { t: "crumb", depth: 0 })!;
    expect(crumb.stack).toEqual(["h"]);
    expect(crumb.focus).toBe("n22c16");
  });

  test("the header count reads the server's coverage, else its hop count, never a stand-in 0", () => {
    const fn = fnOf(FX.checkout, "checkout");
    const noJoin = {
      ...fn,
      calls: { hops: 1, coverage: null, checked: false },
      analysis: { ...fn.analysis!, status: "unknown" as const, calls: 0 },
    };
    expect(fnCalls(noJoin)).toBe(1);
    expect(fnCalls({ ...fn, calls: { hops: 1, coverage: 3, checked: true } })).toBe(3);
  });

  test("a file edited since the trace: every line '?' (source-moved), no notes, flagged", () => {
    const fn = { ...fnOf(FX.checkout, "checkout"), sourceHash: "aaaaaaaaaaaa" };
    const src = FX.checkout.source[fn.key]!;
    const moved = gutterRows(FX.checkout.payload, fn, { ...src, hash: "bbbbbbbbbbbb" });
    expect(moved.filter((x) => x.text.trim()).every((x) => x.count === "?" && x.why === "source-moved")).toBe(true);
    expect(moved.every((x) => !x.notes.length && !x.exit)).toBe(true);
    expect(sourceMoved(fn, { ...src, hash: "bbbbbbbbbbbb" })).toBe(true);
    // Same hash, or no hash to compare: the counts stand.
    const same = gutterRows(FX.checkout.payload, fn, { ...src, hash: "aaaaaaaaaaaa" });
    expect(same.some((x) => x.count.startsWith("x"))).toBe(true);
    expect(sourceMoved(fn, src)).toBe(false);
  });
});
