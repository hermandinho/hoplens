// Request path, layer 3e: carry a function's model from the generated text V8 ran over to the raw
// file on disk (plan P5). Pure: no fs, no TypeScript.
//
// The truth model never reads mapped offsets. It runs on the generated text's own model (identity,
// exactly as for plain JavaScript: V8's ranges are shaped by that text). What this file decides is
// whether that model IS the raw function's, node for node, so the result can be shown on the raw
// file. It is when, recursively:
//
//   - the two trees have the same shape: the same node kinds in the same order, the same arm, case,
//     catch / finally, label, exit-kind and loop-kind structure, the same expression decisions
//     (kind, operator, arms, guarded), the same await count and the same number of nested functions;
//   - every executable generated node (not a block: its statements) holds at least one source-map
//     anchor (srcmap.ts mapSpan), all of them this file's, and all of them land inside the paired raw
//     node. Raw siblings are disjoint and in source order, so this also keeps the anchors monotonic
//     from node to node (inside one node they may go back: see contained());
//   - the same holds for the function itself, and the raw function is the innermost one containing
//     the generated function's anchors.
//
// A loader that drops, adds or reorders code (an enum inlined into a dead `if (false)` the compiler
// removed, a statement it folded away) breaks the shape: the function is UNKNOWN 'unmapped', never
// guessed. On success the HYBRID function is returned: the generated model's offsets (what the
// truth model compares with V8's ranges) with the raw model's ids, lines, labels, callee names and
// nested-function ids (what the payload shows and links).

import type {
  CfgArm,
  CfgBlock,
  CfgCase,
  CfgExpr,
  CfgExprArm,
  CfgFile,
  CfgFunction,
  CfgLoop,
  CfgNode,
  CfgSwitch,
  CfgTry,
} from "./cfg-model";
import type { ReverseIndex } from "./srcmap";

export interface MapFail {
  why: "unmapped";
  /** What did not hold, for the payload's warnings. */
  detail: string;
}

class Mismatch extends Error {}

const fail = (detail: string): never => {
  throw new Mismatch(detail);
};

interface Ctx {
  index: ReverseIndex;
}

const spanWhy = (why: string) =>
  why === "no-anchor"
    ? "no source-map anchor"
    : why === "foreign"
      ? "an anchor of another source"
      : "anchors go backwards";

/**
 * The anchors of generated [start, end) must all land inside raw [start, end). `need`: at least one.
 * Not monotonic inside one node (esbuild's `__name(f, "f")` after a nested function maps back to
 * `f`); across nodes order holds anyway: siblings land in disjoint raw nodes, in source order.
 */
function contained(
  c: Ctx,
  what: string,
  g: { start: number; end: number },
  r: { start: number; end: number },
  need: boolean,
  /**
   * Anchors on the indentation before a node are its own (esbuild maps a pretty-printed statement
   * there). Not for an arm or a case: esbuild maps the indentation before a `case` to the token
   * before it (the switch's `{`, the previous case's last statement). Either way the indentation
   * before `g.end` is not the node's: an arm or case span ends where the next one starts.
   */
  lead = true,
) {
  const start = lead ? c.index.leadingTrivia(g.start) : g.start;
  const m = c.index.mapSpan(start, Math.max(start, c.index.leadingTrivia(g.end)), { monotonic: false });
  if ("why" in m) {
    if (m.why === "no-anchor" && !need) return;
    fail(`${what} at raw offset ${r.start}: ${spanWhy(m.why)}`);
    return;
  }
  if (m.min < r.start || m.max >= r.end) fail(`${what} at raw offset ${r.start}: its anchors land outside it`);
}

function sameLabels(a?: readonly string[], b?: readonly string[]) {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function exprs(c: Ctx, g: readonly CfgExpr[], r: readonly CfgExpr[], what: string): CfgExpr[] {
  if (g.length !== r.length)
    fail(`${what}: ${r.length} expression decision(s) in the file, ${g.length} in the generated code`);
  return r.map((re, i) => {
    const ge = g[i]!;
    if (ge.k !== re.k || ge.op !== re.op || ge.arms.length !== re.arms.length || !!ge.guarded !== !!re.guarded)
      fail(`${what}: expression decision ${re.label} differs in the generated code`);
    contained(c, `decision ${re.label}`, ge, re, true);
    const arms = re.arms.map((ra, j): CfgExprArm => {
      const ga = ge.arms[j]!;
      // Each arm, up to the next one (or the expression's end), must land inside the PAIRED raw arm,
      // with at least one anchor: a minifier that inverts a ternary (`!(a > 0) ? f1() : f2()` ->
      // `a>0?f2():f1()`) keeps the shape, and only this tells its swapped arms apart.
      contained(c, `arm ${ra.label} of ${re.label}`, armSpan(ge, j), armSpan(re, j), true, false);
      return { ...ra, start: ga.start, exprs: exprs(c, ga.exprs, ra.exprs, what) };
    });
    return { ...re, start: ge.start, end: ge.end, arms };
  });
}

/** Arm `j` of `e`: from its counter position to the next arm's (or the expression's end). */
const armSpan = (e: CfgExpr, j: number) => ({ start: e.arms[j]!.start, end: e.arms[j + 1]?.start ?? e.end });

/** Case `j` of `s`: from its `case` to the next case's (or the switch's end). */
const caseSpan = (s: CfgSwitch, j: number) => ({ start: s.cases[j]!.start, end: s.cases[j + 1]?.start ?? s.end });

function head(g: { awaits: number; fns: number[] }, r: { awaits: number; fns: number[] }, what: string) {
  if (g.awaits !== r.awaits) fail(`${what}: ${r.awaits} await(s) in the file, ${g.awaits} in the generated code`);
  if (g.fns.length !== r.fns.length) fail(`${what}: nested functions differ in the generated code`);
}

/**
 * A block is its statements: its own braces are not checked (a compiler maps a `{` loosely: esbuild
 * maps a finally block's brace to the `finally` keyword), the construct around it and every statement
 * in it are.
 */
function block(c: Ctx, g: CfgBlock, r: CfgBlock): CfgBlock {
  if (!sameLabels(g.labels, r.labels)) fail(`block at line ${r.line}: labels differ`);
  if (g.body.length !== r.body.length)
    fail(`block at line ${r.line}: ${r.body.length} statement(s) in the file, ${g.body.length} in the generated code`);
  return { ...r, start: g.start, end: g.end, body: r.body.map((n, i) => node(c, g.body[i]!, n)) };
}

function node(c: Ctx, g: CfgNode, r: CfgNode): CfgNode {
  const what = `${r.k} at line ${r.line}`;
  if (g.k !== r.k) fail(`${what}: the generated code has a ${g.k} there`);
  if (!sameLabels(g.labels, r.labels)) fail(`${what}: labels differ`);
  const at = { start: g.start, end: g.end };
  switch (r.k) {
    case "block":
      return block(c, g as CfgBlock, r);
    case "fold":
      return fail(`${what}: folded (too large to compare)`);
    case "stmt": {
      const gs = g as typeof r;
      contained(c, what, gs, r, true);
      head(gs, r, what);
      return { ...r, ...at, exprs: exprs(c, gs.exprs, r.exprs, what) };
    }
    case "exit": {
      const gs = g as typeof r;
      if (gs.kind !== r.kind || gs.target !== r.target) fail(`${what}: a different exit in the generated code`);
      // A bare break / continue is one keyword: esbuild maps none in its plain output. Its place is
      // fixed by the shape (kind, target, position among anchored siblings); any anchor it has must still land in it.
      contained(c, what, gs, r, r.kind !== "break" && r.kind !== "continue");
      head(gs, r, what);
      return { ...r, ...at, exprs: exprs(c, gs.exprs, r.exprs, what) };
    }
    case "if": {
      const gs = g as typeof r;
      if (gs.arms.length !== r.arms.length || gs.hasElse !== r.hasElse)
        fail(`${what}: the generated code has other arms`);
      // The test: the if's own span minus its arms holds the condition; checked through the head.
      contained(c, what, gs, r, true);
      head(gs, r, what);
      const arms = r.arms.map((ra, i): CfgArm => {
        const ga = gs.arms[i]!;
        if (!!ga.testExprs !== !!ra.testExprs || !!ga.test !== !!ra.test) fail(`${what}: arm ${ra.label} differs`);
        const body = node(c, ga.body, ra.body);
        const out: CfgArm = { ...ra, start: ga.start, body };
        if (ra.testExprs) out.testExprs = exprs(c, ga.testExprs!, ra.testExprs, what);
        return out;
      });
      return { ...r, ...at, exprs: exprs(c, gs.exprs, r.exprs, what), arms };
    }
    case "switch": {
      const gs = g as CfgSwitch;
      if (gs.cases.length !== r.cases.length) fail(`${what}: the generated code has other cases`);
      contained(c, what, gs, r, true);
      head(gs, r, what);
      const cases = r.cases.map((rc, i): CfgCase => {
        const gc = gs.cases[i]!;
        if (gc.isDefault !== rc.isDefault || gc.body.length !== rc.body.length)
          fail(`${what}: case ${rc.label} differs in the generated code`);
        // Inside the PAIRED raw case, so cases (empty fall-through ones too) cannot be reordered
        // unseen; a `case x:` has its test to anchor, a `default:` may have no anchor at all.
        contained(c, `case ${rc.label}`, caseSpan(gs, i), caseSpan(r, i), !rc.isDefault, false);
        return {
          ...rc,
          start: gc.start,
          exprs: exprs(c, gc.exprs, rc.exprs, what),
          body: rc.body.map((n, j) => node(c, gc.body[j]!, n)),
        };
      });
      return { ...r, ...at, exprs: exprs(c, gs.exprs, r.exprs, what), cases };
    }
    case "loop": {
      const gs = g as CfgLoop;
      if (gs.loop !== r.loop) fail(`${what}: a ${gs.loop} loop in the generated code`);
      contained(c, what, gs, r, true);
      head(gs, r, what);
      return {
        ...r,
        ...at,
        bodyStart: gs.bodyStart,
        exprs: exprs(c, gs.exprs, r.exprs, what),
        body: node(c, gs.body, r.body),
      };
    }
    case "try": {
      const gs = g as CfgTry;
      if (!!gs.catch !== !!r.catch || !!gs.finally !== !!r.finally)
        fail(`${what}: other clauses in the generated code`);
      contained(c, what, gs, r, true);
      const out: CfgTry = { ...r, ...at, block: block(c, gs.block, r.block) };
      if (r.catch) out.catch = { ...r.catch, start: gs.catch!.start, body: block(c, gs.catch!.body, r.catch.body) };
      if (r.finally)
        out.finally = { ...r.finally, start: gs.finally!.start, body: block(c, gs.finally!.body, r.finally.body) };
      return out;
    }
  }
  return fail(`${what}: unknown node`);
}

/**
 * The raw function `gen` (a function of the generated model) is, and the hybrid model to run the
 * truth model on; or why the correspondence is not certain.
 */
export function mapFunction(
  gen: CfgFunction,
  raw: CfgFile,
  index: ReverseIndex,
): { fn: CfgFunction; raw: CfgFunction } | MapFail {
  const c: Ctx = { index };
  try {
    const span = index.mapSpan(gen.start, gen.end, { monotonic: false });
    if ("why" in span) fail(`the function: ${spanWhy(span.why)}`);
    const m = span as Exclude<typeof span, { why: unknown }>;
    let best: CfgFunction | undefined;
    for (const f of raw.functions)
      if (f.start <= m.min && m.max < f.end && (!best || f.end - f.start < best.end - best.start)) best = f;
    if (!best) return fail("no function of the file holds its anchors");
    const r = best;
    if (
      r.kind !== gen.kind ||
      r.async !== gen.async ||
      r.generator !== gen.generator ||
      !!r.paramInit !== !!gen.paramInit
    )
      fail(
        `the generated function is not a ${r.async ? "async " : ""}${r.kind} like ${r.name || "the anonymous function"} at line ${r.line}`,
      );
    if (r.truncated || gen.truncated) fail("folded (too large to compare)");
    if (r.nested.length !== gen.nested.length) fail("nested functions differ in the generated code");
    const body = block(c, gen.body, r.body);
    const fn: CfgFunction = { ...r, start: gen.start, end: gen.end, starts: gen.starts.slice(), body };
    return { fn, raw: r };
  } catch (err) {
    if (err instanceof Mismatch) return { why: "unmapped", detail: err.message };
    throw err;
  }
}
