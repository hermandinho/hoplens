// Request path truth, property test: random structured programs (if / else-if / else, ternary,
// &&, switch with fall-through, labeled loops with break / continue, try / catch / finally, early
// return / throw, callees that throw, awaited rejections, optional-call arguments, destructuring
// defaults, logical assignment) executed with random inputs under real V8 block coverage. Each
// program counts its own arms (`__c[id]++` markers) and records which exit each call left by
// (`__last`) for the ground truth.
//
// Property: every arm the truth model marks TAKEN really ran, and no arm that ran is NOT-TAKEN
// (UNKNOWN is always allowed). Loops likewise for their passes. Every exit count the model gives is
// exact, an exception line it names is the escaping errors' line, and when no exit is unknown the
// exits account for every call. Checked with the exception locations a hop would record (stack
// lines) and without any.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { FnAnalysis } from "../src/path/truth";
import { analyze, capture, load, startCoverage } from "./path-cov";

let dir: string;
beforeAll(() => {
  startCoverage();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-path-prop-"));
});
afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------- generator */

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One generated decision: which markers count what, keyed by the line the model reports. */
interface GenDecision {
  kind: "if" | "ternary" | "logical" | "switch" | "try";
  /** Index into `lines` of the decision's first line. */
  at: number;
  reach: number;
  /** Markers of the written arms, in order. */
  arms: number[];
  /** switch: per clause, the marker counting its fall-through out (or -1: never falls through). */
  fall?: number[];
  hasDefault?: boolean;
  hasElse?: boolean;
}

interface GenLoop {
  at: number;
  pass: number;
}

/** A return / throw statement: `__last[0]` is set to `id` right before it leaves. */
interface GenExit {
  id: number;
  at: number;
  kind: "return" | "throw";
}

interface Ctx {
  loops: string[];
  /** The innermost breakable is a switch. */
  inSwitch: boolean;
  inFinally: boolean;
  vars: string[];
}

class Gen {
  lines: string[] = [];
  markers = 0;
  decisions: GenDecision[] = [];
  loops: GenLoop[] = [];
  exits: GenExit[] = [];
  labelN = 0;
  constructor(
    readonly r: () => number,
    readonly async: boolean,
  ) {}
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!;
  }
  chance(p: number) {
    return this.r() < p;
  }
  m() {
    return this.markers++;
  }
  emit(ind: number, s: string) {
    this.lines.push(`${"  ".repeat(ind + 1)}${s}`);
    return this.lines.length - 1;
  }
  cond(ctx: Ctx) {
    const v = () => this.pick(ctx.vars);
    return this.pick([
      () => `${v()} > ${Math.floor(this.r() * 3)}`,
      () => `${v()} === ${Math.floor(this.r() * 4)}`,
      () => `(${v()} + ${v()}) % 2 === 0`,
      () => `${v()} < ${v()}`,
    ])();
  }
  block(ind: number, depth: number, ctx: Ctx, allowExit = true) {
    const n = 1 + Math.floor(this.r() * 3);
    for (let i = 0; i < n; i++) this.stmt(ind, depth, ctx);
    if (allowExit && !ctx.inFinally && this.chance(0.25)) this.exit(ind, ctx);
  }
  /** `return x;` / `throw new Error('t');`, recording itself in `__last` as it leaves. */
  leave(ind: number, kind: "return" | "throw") {
    const id = this.exits.length;
    const value = kind === "return" ? "x" : "new Error('t')";
    const at = this.emit(ind, `${kind} (__last[0] = ${id}, ${value});`);
    this.exits.push({ id, at, kind });
  }
  exit(ind: number, ctx: Ctx) {
    const opts: string[] = ["return x;", "throw new Error('t');"];
    if (ctx.loops.length || ctx.inSwitch) opts.push("break;");
    if (ctx.loops.length) {
      opts.push("continue;");
      const l = this.pick(ctx.loops);
      opts.push(`break ${l};`, `continue ${l};`);
    }
    const s = this.pick(opts);
    // Guard it: an unconditional exit makes the rest of the arm dead, which is fine but dull.
    const id = this.m();
    const at = this.emit(ind, `__c[${id}]++; if (${this.cond(ctx)}) {`);
    const arm = this.m();
    this.decisions.push({ kind: "if", at, reach: id, arms: [arm], hasElse: false });
    this.emit(ind + 1, `__c[${arm}]++;`);
    if (s === "return x;") this.leave(ind + 1, "return");
    else if (s.startsWith("throw")) this.leave(ind + 1, "throw");
    else this.emit(ind + 1, s);
    this.emit(ind, "}");
  }
  stmt(ind: number, depth: number, ctx: Ctx) {
    const kinds: Array<() => void> = [
      () => this.emit(ind, `x += ${1 + Math.floor(this.r() * 5)};`),
      () => this.emit(ind, `boom(${this.cond(ctx)});`),
      () => this.ternary(ind, ctx),
      () => this.logical(ind, ctx),
      () => this.skippable(ind, ctx),
      () =>
        this.emit(ind, `x ${this.pick(["||=", "&&=", "??="])} (__c[${this.m()}]++, ${1 + Math.floor(this.r() * 3)});`),
    ];
    if (this.async) kinds.push(() => this.emit(ind, `await rej(${this.cond(ctx)});`));
    if (depth < 3)
      kinds.push(
        () => this.ifs(ind, depth, ctx),
        () => this.ifs(ind, depth, ctx),
        () => this.sw(ind, depth, ctx),
        () => this.loop(ind, depth, ctx),
        () => this.tryc(ind, depth, ctx),
      );
    this.pick(kinds)();
  }
  ternary(ind: number, ctx: Ctx) {
    const R = this.m();
    const A = this.m();
    const B = this.m();
    const at = this.emit(ind, `x += (__c[${R}]++, ${this.cond(ctx)}) ? (__c[${A}]++, 1) : (__c[${B}]++, 2);`);
    this.decisions.push({ kind: "ternary", at, reach: R, arms: [A, B] });
  }
  logical(ind: number, ctx: Ctx) {
    const R = this.m();
    const A = this.m();
    const at = this.emit(ind, `(__c[${R}]++, ${this.cond(ctx)}) && (__c[${A}]++, x++);`);
    this.decisions.push({ kind: "logical", at, reach: R, arms: [A] });
  }
  /**
   * A decision its statement may skip: the argument of an optional call on a value that may be
   * null, or a destructuring default the value may supply.
   */
  skippable(ind: number, ctx: Ctx) {
    const R = this.m();
    const A = this.m();
    const pick = `[null, O][+(${this.cond(ctx)})]`;
    if (this.chance(0.3)) {
      const at = this.emit(ind, `${pick}?.g((__c[${R}]++, ${this.cond(ctx)}) && (__c[${A}]++, x++));`);
      this.decisions.push({ kind: "logical", at, reach: R, arms: [A] });
      return;
    }
    const B = this.m();
    const arm = `(__c[${R}]++, ${this.cond(ctx)}) ? (__c[${A}]++, 1) : (__c[${B}]++, 2)`;
    const v = `v${R}`;
    const at = this.chance(0.5)
      ? this.emit(ind, `${pick}?.g(${arm});`)
      : this.emit(ind, `{ const { ${v} = ${arm} } = [{}, { ${v}: 3 }][+(${this.cond(ctx)})]; x += ${v}; }`);
    this.decisions.push({ kind: "ternary", at, reach: R, arms: [A, B] });
  }
  ifs(ind: number, depth: number, ctx: Ctx) {
    const R = this.m();
    const d: GenDecision = { kind: "if", at: -1, reach: R, arms: [], hasElse: false };
    this.decisions.push(d);
    const A = this.m();
    d.at = this.emit(ind, `__c[${R}]++; if (${this.cond(ctx)}) {`);
    d.arms.push(A);
    this.emit(ind + 1, `__c[${A}]++;`);
    this.block(ind + 1, depth + 1, ctx);
    const elifs = this.chance(0.4) ? 1 + Math.floor(this.r() * 2) : 0;
    for (let i = 0; i < elifs; i++) {
      const B = this.m();
      d.arms.push(B);
      this.emit(ind, `} else if (${this.cond(ctx)}) {`);
      this.emit(ind + 1, `__c[${B}]++;`);
      this.block(ind + 1, depth + 1, ctx);
    }
    if (this.chance(0.5)) {
      const C = this.m();
      d.arms.push(C);
      d.hasElse = true;
      this.emit(ind, "} else {");
      this.emit(ind + 1, `__c[${C}]++;`);
      this.block(ind + 1, depth + 1, ctx);
    }
    this.emit(ind, "}");
  }
  sw(ind: number, depth: number, ctx: Ctx) {
    const R = this.m();
    const d: GenDecision = { kind: "switch", at: -1, reach: R, arms: [], fall: [], hasDefault: false };
    this.decisions.push(d);
    d.at = this.emit(ind, `__c[${R}]++; switch (${this.pick(ctx.vars)} % 4) {`);
    const n = 1 + Math.floor(this.r() * 3);
    const cases = [0, 1, 2, 3].sort(() => this.r() - 0.5).slice(0, n);
    const withDefault = this.chance(0.5);
    const labels = cases.map((c) => `case ${c}:`);
    if (withDefault) labels.splice(Math.floor(this.r() * (labels.length + 1)), 0, "default:");
    d.hasDefault = withDefault;
    const inner: Ctx = { ...ctx, inSwitch: true };
    for (const label of labels) {
      const A = this.m();
      d.arms.push(A);
      this.emit(ind + 1, label);
      this.emit(ind + 2, `__c[${A}]++;`);
      this.block(ind + 2, depth + 1, inner, false);
      if (this.chance(0.5)) {
        this.emit(ind + 2, "break;");
        d.fall!.push(-1);
      } else {
        const F = this.m();
        this.emit(ind + 2, `__c[${F}]++;`);
        d.fall!.push(F);
      }
    }
    this.emit(ind, "}");
  }
  loop(ind: number, depth: number, ctx: Ctx) {
    const label = `L${this.labelN++}`;
    const iv = `i${label}`;
    const bound = this.pick([...ctx.vars.filter((v) => !v.startsWith("i")), "2", "3"]);
    const P = this.m();
    const at = this.emit(ind, `${label}: for (let ${iv} = 0; ${iv} < ${bound}; ${iv}++) {`);
    this.loops.push({ at, pass: P });
    this.emit(ind + 1, `__c[${P}]++;`);
    this.block(ind + 1, depth + 1, { ...ctx, loops: [...ctx.loops, label], inSwitch: false, vars: [...ctx.vars, iv] });
    this.emit(ind, "}");
  }
  tryc(ind: number, depth: number, ctx: Ctx) {
    const R = this.m();
    const A = this.m();
    const d: GenDecision = { kind: "try", at: -1, reach: R, arms: [A] };
    this.decisions.push(d);
    d.at = this.emit(ind, `__c[${R}]++; try {`);
    this.block(ind + 1, depth + 1, ctx);
    this.emit(ind, "} catch (e) {");
    this.emit(ind + 1, `__c[${A}]++;`);
    this.block(ind + 1, depth + 1, ctx);
    if (this.chance(0.4)) {
      this.emit(ind, "} finally {");
      this.block(ind + 1, depth + 1, { ...ctx, inFinally: true }, false);
    }
    this.emit(ind, "}");
  }
}

const HEADER = [
  "const __c = [];",
  "const __last = [-1];",
  "const O = { g(v) { return v; } };",
  "const __stacks = [];",
  "function boom(p) { if (p) { const e = new Error('boom'); __stacks.push(e.stack); throw e; } return 0; }",
  "function rej(p) { if (p) { const e = new Error('rej'); __stacks.push(e.stack); return Promise.reject(e); } return Promise.resolve(0); }",
];

function generate(seed: number) {
  const r = rng(seed);
  const g = new Gen(r, r() < 0.35);
  g.block(0, 0, { loops: [], inSwitch: false, inFinally: false, vars: ["a", "b", "c", "d"] }, false);
  g.leave(0, "return");
  const fnLine = HEADER.length + 1;
  const src = [
    ...HEADER,
    `${g.async ? "async " : ""}function f(a, b, c, d) {`,
    "  let x = 0;",
    ...g.lines,
    "}",
    `module.exports = { f, __c, __last, __stacks, markers: ${g.markers} };`,
    "",
  ].join("\n");
  // `lines` start two lines below the function's own line.
  const lineOf = (at: number) => fnLine + 2 + at;
  return { src, g, lineOf, fnLine };
}

/* ------------------------------------------------------------- the check */

function truthOf(d: GenDecision, c: number[]): number[] {
  const n = (i: number) => c[i] ?? 0;
  switch (d.kind) {
    case "if": {
      const arms = d.arms.map(n);
      if (!d.hasElse) arms.push(n(d.reach) - arms.reduce((s, v) => s + v, 0));
      return arms;
    }
    case "ternary":
      return d.arms.map(n);
    case "logical":
      return [n(d.arms[0]!), n(d.reach) - n(d.arms[0]!)];
    case "try":
      return [n(d.reach) - n(d.arms[0]!), n(d.arms[0]!)];
    case "switch": {
      const matched = d.arms.map((a, i) => n(a) - (i > 0 && d.fall![i - 1]! >= 0 ? n(d.fall![i - 1]!) : 0));
      if (!d.hasDefault) matched.push(n(d.reach) - matched.reduce((s, v) => s + v, 0));
      return matched;
    }
  }
}

let programs = 0;
let checkedArms = 0;
let unknownArms = 0;
/** Known counts that differ from the ground truth (the model claims exact counts). */
let wrongCounts = 0;
let checkedExits = 0;
/** 'arms-inconsistent' on real, correct coverage: the model's structure fell short. */
let inconsistent = 0;
const firstWrong: string[] = [];
const firstInconsistent: string[] = [];

async function runOne(seed: number, inputs: number[][], located: boolean) {
  const { src, g, lineOf, fnLine } = generate(seed);
  const file = path.join(dir, `p${seed >>> 0}-${located ? "l" : "n"}-${programs++}.cjs`);
  fs.writeFileSync(file, src);
  const mod = load(file);
  for (let i = 0; i < mod.markers; i++) mod.__c[i] = 0;
  let threw = 0;
  const stacks: string[] = [];
  /** How each call left: `return@<exit id>`, `throw@<exit id>`, or `exception`. */
  const outcomes: string[] = [];
  const escaping: string[] = [];
  const cov = await capture(file, async () => {
    for (const [a, b, c, d] of inputs) {
      mod.__last[0] = -1;
      try {
        await mod.f(a, b, c, d);
        outcomes.push(`return@${mod.__last[0]}`);
      } catch (err) {
        threw++;
        stacks.push((err as Error).stack ?? "");
        if ((err as Error).message === "t") outcomes.push(`throw@${mod.__last[0]}`);
        else {
          outcomes.push("exception");
          escaping.push((err as Error).stack ?? "");
        }
      }
    }
  });
  stacks.push(...mod.__stacks);
  const endLine = fnLine + 2 + g.lines.length;
  // As capture.ts records them: per distinct error stack, its innermost frame inside f.
  const lineIn = (st: string): number | undefined => {
    for (const l of st.split("\n")) {
      const m = /\((.*):(\d+):\d+\)\s*$/.exec(l) ?? /at (.*):(\d+):\d+\s*$/.exec(l);
      if (!m || path.resolve(m[1]!) !== file) continue;
      const line = Number(m[2]);
      if (line >= fnLine && line <= endLine) return line;
    }
    return undefined;
  };
  const throwLines: number[] = [];
  for (const st of new Set(stacks)) {
    const l = lineIn(st);
    if (l !== undefined) throwLines.push(l);
  }
  const a: FnAnalysis = analyze(file, cov, "f", { threw, throwLines: located ? throwLines : undefined });
  if (process.env.PATH_PROP_DUMP) {
    fs.writeFileSync(
      path.join(os.tmpdir(), "hoplens-prop-debug.json"),
      JSON.stringify({ src, c: mod.__c, a, throwLines: [...throwLines], threw, cov }, null, 1),
    );
  }
  const byLine = new Map<string, GenDecision>();
  for (const d of g.decisions) byLine.set(`${d.kind}@${lineOf(d.at)}`, d);
  const fail = (msg: string) => {
    throw new Error(
      `${msg}\nseed=${seed} located=${located} inputs=${JSON.stringify(inputs)} threw=${threw} lines=${throwLines}\n${src}`,
    );
  };
  for (const d of a.decisions) {
    const kind = d.kind;
    const gd = byLine.get(`${kind}@${d.line}`);
    if (!gd) {
      // The exit guards emit their marker on the if's line too; anything else is a model bug.
      fail(`decision ${d.id} ${d.kind} L${d.line} has no generated counterpart`);
      continue;
    }
    const truth = truthOf(gd, mod.__c);
    if (truth.length !== d.arms.length) fail(`${d.id} L${d.line}: ${d.arms.length} arms, generated ${truth.length}`);
    d.arms.forEach((arm, i) => {
      const t = truth[i]!;
      checkedArms++;
      if (arm.taken === "unknown") unknownArms++;
      if (arm.why === "arms-inconsistent") {
        inconsistent++;
        if (firstInconsistent.length < 3)
          firstInconsistent.push(`seed=${seed} located=${located} inputs=${JSON.stringify(inputs)} ${d.id} L${d.line}`);
      }
      if (arm.count !== null && arm.count !== t) {
        wrongCounts++;
        if (firstWrong.length < 3)
          firstWrong.push(
            `seed=${seed} located=${located} inputs=${JSON.stringify(inputs)} ${d.id} L${d.line} ${arm.label}: ${arm.count} vs ${t}`,
          );
      }
      if (arm.taken === "taken" && !(t > 0))
        fail(`${d.id} L${d.line} arm ${arm.label} marked TAKEN (${arm.count}) but ran ${t}x`);
      if (arm.taken === "not-taken" && t !== 0)
        fail(`${d.id} L${d.line} arm ${arm.label} marked NOT-TAKEN but ran ${t}x`);
    });
  }
  for (const l of a.loops) {
    const gl = g.loops.find((x) => lineOf(x.at) === l.line);
    if (!gl) fail(`loop L${l.line} has no generated counterpart`);
    const t = mod.__c[gl!.pass] ?? 0;
    if (l.passes !== null && l.passes > 0 !== t > 0) fail(`loop L${l.line}: passes ${l.passes}, ran ${t}x`);
  }
  // Exits: exact when counted; the exception's line is the escaping errors'; complete when known.
  const truthExits = new Map<string, number>();
  for (const o of outcomes) {
    const [kind, id] = o.split("@");
    const key = kind === "exception" ? "exception" : `${kind}@${lineOf(g.exits[Number(id)]!.at)}`;
    truthExits.set(key, (truthExits.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  for (const e of a.exits) {
    const key = e.kind === "exception" ? "exception" : `${e.kind}@${e.line}`;
    seen.add(key);
    checkedExits++;
    if (e.count !== null && e.count !== (truthExits.get(key) ?? 0))
      fail(`exit ${key}: count ${e.count}, truth ${truthExits.get(key) ?? 0} (${JSON.stringify(a.exits)})`);
    if (e.kind === "exception" && e.line !== null && e.count !== null && e.count > 0) {
      const lines = new Set(escaping.map(lineIn));
      if (lines.size !== 1 || !lines.has(e.line))
        fail(`exception exit at L${e.line}, escaping errors at ${[...lines]} (${JSON.stringify(a.exits)})`);
    }
  }
  if (a.exits.every((e) => e.count !== null))
    for (const [key, n] of truthExits)
      if (n > 0 && !seen.has(key)) fail(`exit ${key} ran ${n}x, missing from ${JSON.stringify(a.exits)}`);
  try {
    fs.rmSync(file);
  } catch {
    /* tmp dir is removed after */
  }
}

// Debug one case: PATH_PROP_SEED=<seed> PATH_PROP_INPUTS='[[0,0,3,0]]' PATH_PROP_LOCATED=1
const DEBUG = process.env.PATH_PROP_SEED;
if (DEBUG)
  test("debug one seed", async () => {
    const inputs = JSON.parse(process.env.PATH_PROP_INPUTS ?? "[[0,0,0,0]]");
    process.env.PATH_PROP_DUMP = "1";
    await runOne(Number(DEBUG), inputs, process.env.PATH_PROP_LOCATED === "1");
  });

const RUNS = Number(process.env.PATH_PROP_RUNS ?? 300);

/**
 * Counterexamples deep runs found for the exit checks, kept: a finally that replaced one of several
 * pending completions (normal, a break, a throw), an unplaced catch after a finally cut the flow,
 * and explicit throws through a finally read as callee exceptions.
 */
const PINNED: Array<[seed: number, inputs: number[][], located: boolean]> = [
  [
    -695090042,
    [
      [3, 3, 0, 0],
      [0, 3, 0, 0],
      [0, 0, 0, 0],
    ],
    false,
  ],
  [
    1214243610,
    [
      [0, 1, 3, 2],
      [0, 0, 0, 0],
    ],
    true,
  ],
  [
    2147483618,
    [
      [1, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    false,
  ],
  [2147483618, [[1, 0, 0, 0]], true],
  [
    2147483618,
    [
      [0, 1, 0, 2],
      [1, 0, 0, 0],
    ],
    false,
  ],
  [
    -136237066,
    [
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [3, 0, 0, 0],
    ],
    false,
  ],
  [
    62903119,
    [
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 1, 3],
      [0, 0, 0, 0],
    ],
    true,
  ],
  [
    -73199790,
    [
      [1, 0, 0, 1],
      [2, 0, 0, 0],
    ],
    false,
  ],
];

// Its own timeout: past the 5s default under load, vitest moved on while this loop still ran, and
// the next property test then shared the coverage session with it ("no coverage for f").
test.skipIf(!!DEBUG)(
  "pinned counterexamples",
  async () => {
    for (const [seed, inputs, located] of PINNED) await runOne(seed, inputs, located);
  },
  120_000,
);

const inputArb = fc.array(fc.tuple(fc.nat(3), fc.nat(3), fc.nat(3), fc.nat(3)), { minLength: 1, maxLength: 4 });

test.skipIf(!!DEBUG)(
  "TAKEN arms really ran and arms that ran are never NOT-TAKEN (with hop stack lines)",
  async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), inputArb, async (seed, inputs) => runOne(seed, inputs, true)),
      { numRuns: RUNS },
    );
  },
  1_200_000,
);

test.skipIf(!!DEBUG)(
  "... and without any exception location",
  async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), inputArb, async (seed, inputs) => runOne(seed, inputs, false)),
      { numRuns: RUNS },
    );
    // The model is not vacuous: most arms get an answer and the counts it gives are exact.
    console.log(
      `path property: ${programs} programs, ${checkedArms} arms, ${unknownArms} unknown (${Math.round((100 * unknownArms) / checkedArms)}%), ${wrongCounts} wrong counts, ${inconsistent} inconsistent, ${checkedExits} exits`,
    );
    expect(firstWrong).toEqual([]);
    // An exception the counters cannot place may have replaced an exit or a normal completion; the
    // model then shrinks the exit (flows stay upper bounds), which can read as arms-inconsistent
    // later: safe, and rare (142 of 246098 arms over 5000 programs).
    if (firstInconsistent.length) console.log(`arms-inconsistent, e.g. ${firstInconsistent[0]}`);
    expect(inconsistent / checkedArms).toBeLessThan(0.01);
    expect(checkedArms).toBeGreaterThan(1000);
    expect(unknownArms / checkedArms).toBeLessThan(0.5);
  },
  1_200_000,
);
