import { afterEach, describe, expect, test } from "vitest";
import type { Baseline, BucketDelta, CompareRow, CountDelta, JsonDiffOp } from "../src/api/types";
import {
  baselines,
  bucketView,
  chordUndo,
  countChanges,
  countText,
  defaultBaseline,
  fmtDelta,
  fmtDeltaPct,
  initCompare,
  opText,
  pickState,
  previousBuild,
  resolvePick,
  rowMark,
  toneOf,
  visibleRows,
} from "../src/state/compare";
import { activeScopes, usableBindings } from "../src/state/keymap";
import { route } from "../src/state/router";

/* WP8 UI compare: the pure view helpers and the keys' guards.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/compare.test.ts */

const base = (kind: Baseline["kind"], id: string, extra: Partial<Baseline> = {}): Baseline => ({
  kind,
  id,
  duration: 40,
  startedAt: 1,
  url: "/api/products",
  ...extra,
});

const side = (count: number, wallMs: number) => ({
  count,
  wallMs,
  totalMs: wallMs,
  spanIds: ["s"],
  start: 0,
  errors: 0,
});

function row(
  key: string,
  parentKey: string | undefined,
  status: CompareRow["status"],
  extra: Partial<CompareRow> = {},
): CompareRow {
  return {
    key,
    parentKey,
    depth: parentKey ? parentKey.split(">").length : 0,
    kind: "function",
    label: key,
    bucket: "fn",
    a: side(1, 10),
    b: side(1, 10),
    deltaMs: 0,
    countDelta: 0,
    status,
    ...extra,
  };
}

describe("baselines", () => {
  const list = [base("previous-build", "p", { epoch: 6 }), base("previous-url", "u"), base("route-median", "m")];
  test("c opens the first baseline; d the previous build", () => {
    expect(defaultBaseline(list, "b")?.id).toBe("p");
    expect(previousBuild(list, "b")?.id).toBe("p");
  });
  test("without a previous build, c falls back to the same URL and d has nothing", () => {
    expect(defaultBaseline(list.slice(1), "b")?.id).toBe("u");
    expect(previousBuild(list.slice(1), "b")).toBeUndefined();
  });
  test("B itself is never its own baseline; none known = undefined", () => {
    expect(defaultBaseline([base("route-median", "b")], "b")).toBeUndefined();
    expect(defaultBaseline(undefined, "b")).toBeUndefined();
  });
});

describe("c c: picking A from the list", () => {
  test("opening another request while picking lands on the compare, keeping the since scope", () => {
    expect(resolvePick({ b: "B" }, { view: "trace", traceId: "X", since: "7" })).toEqual({
      view: "compare",
      a: "X",
      b: "B",
      since: "7",
    });
  });
  test("reopening B, another view, or not picking resolves nothing", () => {
    expect(resolvePick({ b: "B" }, { view: "trace", traceId: "B" })).toBeNull();
    expect(resolvePick({ b: "B" }, { view: "compare", a: "A", b: "B" })).toBeNull();
    expect(resolvePick(null, { view: "trace", traceId: "X" })).toBeNull();
  });
  test("c c from a request: the compare the first c opened is undone, so Esc lands back on the request", () => {
    const from = { view: "trace", traceId: "B" } as const;
    const to = { view: "compare", a: "A", b: "B" } as const;
    const last = { from, to, at: 1000 };
    expect(chordUndo(last, to, 1500)).toEqual(from);
    expect(chordUndo(last, to, 3000)).toBeNull(); // a later c c on the compare itself: stay
    expect(chordUndo(last, { view: "compare", a: "Z", b: "B" }, 1500)).toBeNull(); // moved on
    expect(chordUndo(null, to, 1500)).toBeNull();
  });
});

describe("tones and deltas", () => {
  test("red = slower, green = faster, gray under 1ms or 10%", () => {
    expect(toneOf(9, 61)).toBe("worse");
    expect(toneOf(61, 9)).toBe("better");
    expect(toneOf(100, 105)).toBe("same");
    expect(toneOf(0.2, 0.9)).toBe("same");
    // The max(20%, 5ms) noise floor: idle 4.9 -> 5.9ms is noise, not a red bar.
    expect(toneOf(4.9, 5.9)).toBe("same");
    expect(toneOf(100, 115)).toBe("same");
    expect(toneOf(100, 130)).toBe("worse");
    expect(toneOf(2, 8)).toBe("worse");
  });
  test("signed deltas", () => {
    expect(fmtDelta(52)).toBe("+52ms");
    expect(fmtDelta(-3)).toBe("−3.0ms");
    expect(fmtDelta(0.01)).toBe("=");
    expect(fmtDeltaPct(41, 96)).toBe("+134%");
    expect(fmtDeltaPct(0, 96)).toBeUndefined();
  });
});

describe("span rows", () => {
  test("N+1 vs batched reads x10 -> x1, and an equal repeat reads once", () => {
    expect(countText({ a: side(10, 170), b: side(1, 20) })).toBe("x10 → x1");
    expect(countText({ a: side(12, 30), b: side(12, 31) })).toBe("x12");
    expect(countText({ a: side(1, 3), b: side(1, 3) })).toBe("");
    expect(countText({ b: side(4, 3) })).toBe("x4");
  });
  test("only-in-A / only-in-B are marks, not tones", () => {
    expect(rowMark(row("x", undefined, "onlyB", { a: undefined }))).toBe("added");
    expect(rowMark(row("x", undefined, "onlyA", { b: undefined }))).toBe("removed");
    expect(rowMark(row("x", undefined, "changed", { a: side(1, 9), b: side(50, 61) }))).toBe("worse");
    expect(rowMark(row("x", undefined, "same"))).toBe("same");
  });
  test("changes only keeps a deep change with its ancestors, in order", () => {
    const rows = [
      row("root", undefined, "changed"),
      row("handler", "root", "same"),
      row("db", "handler", "changed"),
      row("render", "root", "same"),
      row("cache", "root", "onlyA"),
    ];
    expect(visibleRows(rows, true).map((r) => r.key)).toEqual(["root", "handler", "db", "cache"]);
    expect(visibleRows(rows, false)).toHaveLength(5);
  });
});

describe("buckets", () => {
  const b: BucketDelta[] = [
    { bucket: "fn", a: 24, b: 26, delta: 2 },
    { bucket: "db", a: 9, b: 61, delta: 52 },
    { bucket: "ext", a: 0, b: 0, delta: 0 },
  ];
  test("ms: empty buckets dropped, largest change first, bar relative to it", () => {
    const v = bucketView(b, "abs");
    expect(v.map((x) => x.bucket)).toEqual(["db", "fn"]);
    expect(v[0]).toMatchObject({ tone: "worse", bar: 1, label: "db" });
    expect(v[1]?.tone).toBe("same");
    expect(v[1]?.bar).toBeCloseTo(2 / 52);
  });
  test("share: each side as percent of its own total", () => {
    const v = bucketView(b, "share");
    const db = v.find((x) => x.bucket === "db");
    expect(db?.a).toBeCloseTo((9 / 33) * 100);
    expect(db?.b).toBeCloseTo((61 / 87) * 100);
    expect(db?.tone).toBe("worse");
  });
});

describe("counts and payload ops", () => {
  test("changed counts read 'db queries 1 → 50', spans last", () => {
    const c: CountDelta[] = [
      { name: "spans", a: 5, b: 54, delta: 49 },
      { name: "db", a: 1, b: 50, delta: 49 },
      { name: "fetch", a: 10, b: 1, delta: -9 },
      { name: "cache", a: 0, b: 0, delta: 0 },
    ];
    expect(countChanges(c)).toEqual([
      { text: "db queries 1 → 50", tone: "worse" },
      { text: "fetches 10 → 1", tone: "better" },
      { text: "spans 5 → 54", tone: "same" },
    ]);
  });
  test("JSON ops read as sentences, type changes name both types", () => {
    const ops: JsonDiffOp[] = [
      { op: "add", path: "/items/3", b: { id: 4 } },
      { op: "remove", path: "/x", a: 1 },
      { op: "type", path: "/price", a: 10, b: "10", aType: "number", bType: "string" },
      { op: "replace", path: "", a: "a".repeat(100), b: null },
    ];
    expect(ops.map(opText)).toEqual([
      '/items/3 added: {"id":4}',
      "/x removed: 1",
      '/price 10 → "10" (number → string)',
      `/ "${"a".repeat(58)}… → null`,
    ]);
  });
});

describe("keys: only offered when they work", () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    pickState.value = null;
    baselines.value = new Map();
  });
  const keys = () => usableBindings().map((b) => b.key);

  test("on a request: c, c c and p; d only with a previous build", () => {
    off = initCompare();
    route.value = { view: "trace", traceId: "B" };
    activeScopes.value = new Set(["list", "subject", "trace"]);
    baselines.value = new Map([["B", { status: "ready", list: [base("previous-url", "u")], at: Date.now() }]]);
    expect(keys()).toEqual(expect.arrayContaining(["c", "c c", "p"]));
    expect(keys()).not.toContain("d");
    baselines.value = new Map([
      ["B", { status: "ready", list: [base("previous-build", "p", { epoch: 6 })], at: Date.now() }],
    ]);
    expect(keys()).toContain("d");
  });

  test("on a compare: c c (pick) and, while picking, Esc to cancel; no c / d / p", () => {
    off = initCompare();
    route.value = { view: "compare", a: "A", b: "B" };
    activeScopes.value = new Set(["list", "subject"]);
    expect(keys()).toContain("c c");
    expect(keys()).not.toContain("Escape");
    pickState.value = { b: "B" };
    expect(usableBindings().find((b) => b.key === "Escape")?.label).toBe("Stop picking a baseline");
    expect(keys()).not.toEqual(expect.arrayContaining(["c"]));
  });
});
