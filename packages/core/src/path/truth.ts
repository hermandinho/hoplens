// Request path, layer 3b: which arms of which decisions one request took, from V8 block counts
// joined to a function's control-flow model (plan P2). Pure: no fs, no TypeScript.
//
// What V8 block coverage gives: for each function, nested ranges with execution counts. A range is
// reported only where its count differs from its parent's, so the count at an offset is the count
// of the innermost range containing it (`countAt`). That count is an upper bound, not the truth:
//
//   - Continuation ranges get clipped (probe "case C": after `if (!user) return ...`, the code from
//     a ternary on falls back to the function's range, count 1, so the switch below looks reached).
//   - A callee that throws synchronously leaves no trace: there is no counter between a call and
//     the next statement (throwmid probe: `a = 2` after `boom()` reads 1).
//
// So counts are computed STRUCTURALLY, walking the model in execution order with the flow that can
// reach each point:
//
//   reach(stmt)  = min(countAt(stmt), flow in). A countAt below the flow is an exception between the
//                  last counter and here (an awaited rejection reads exactly so: probed).
//   arm count    = countAt(arm). V8 keeps a counter at every arm (then / else, case, loop body,
//                  catch, finally, ternary arm, right operand), so this one is exact even when the
//                  range was not reported (it is left out when equal to the innermost reported range
//                  around it). Arms must not sum past the reach: 'arms-inconsistent'.
//   flow out     = what completed normally: arm outs (+ the implied else), loop entries minus the
//                  exits that left it, try + catch outs.
//   case C       -> the then-arm returned once, so the flow after the if is 0 and the switch's
//                  stale count 1 clamps to 0.
//
// Exceptions (the throw cut): every exception ends somewhere V8 can count it, or in the hop:
//   - a deficit (countAt below the flow) at a later counter,
//   - a catch entered more often than the explicit throws and deficits inside its try explain,
//   - a function hop that threw / rejected more often than its explicit throws and deficits explain.
// Each such event says an exception happened somewhere in a region; the error stacks (the frames in
// this function, `throwLines`) narrow it to the statement that threw. Nodes inside the region whose
// count leans on a counter that fired before that point are UNKNOWN 'after-throw'; arms with a
// counter of their own stay exact (they count entries), and so does the first statement of an arm
// (nothing runs between the arm's counter and it) or right after a counter that fired inside the
// region.
//
// What runs between the function's counter and its body: parameter defaults and patterns (they can
// throw before the body), and a generator's body only runs when iterated. There the body's first
// statement is not anchored to the call count, and a generator's body is a 'suspended' region.
//
// Suspension: an await still pending at capture, or a generator parked at a yield, leaves the same
// deficit an exception does. When the hops recorded fewer errors than the deficits say, the
// exception exit is UNKNOWN 'suspended', not a count.
//
// Guarded expression decisions (cfg.ts: an optional chain's tail, a destructuring or parameter
// default, a logical assignment's right side) may be skipped by their statement without a counter
// saying so: they are reached as often as their arms ran, never short of it (no exception), and a
// logical's implied short-circuit there is UNKNOWN 'no-counter'.
//
// Exits are completions: a return / throw that left the function (a throw its own catch took is
// none), minus the exceptions that may have been raised inside it. When the counted exits add up
// to the calls, the unknown ones are 0.
//
// A function called more than once is BLENDED: counts are totals over its calls. A decision with
// more than one arm taken is SPLIT: 'split-loop' within one call (inside a loop), 'split-calls'
// across calls.

import type {
  CfgArm,
  CfgBlock,
  CfgCase,
  CfgExit,
  CfgExpr,
  CfgFile,
  CfgFunction,
  CfgIf,
  CfgLoop,
  CfgNode,
  CfgSwitch,
  CfgTry,
} from "./cfg-model";

export type TruthWhy =
  | "no-blocks"
  | "contaminated"
  | "join-mismatch"
  | "join-ambiguous"
  | "no-location"
  | "source-unreadable"
  | "too-large"
  | "source-moved"
  | "compiled"
  | "after-throw"
  | "arms-inconsistent"
  | "no-analyzer"
  | "no-function"
  | "no-counter"
  | "suspended";

/** One V8 block range of the function (offsets into the file; [0] is the function itself). */
export interface RangeIn {
  start: number;
  end: number;
  count: number;
}

export interface TruthInput {
  fn: CfgFunction;
  ranges: readonly RangeIn[];
  /** Calls of this function that threw or rejected (its hops with an error); undefined: unknown. */
  threw?: number;
  /** The file's model: names the functions created at a node (`PathNode.fns`). */
  file?: CfgFile;
  /**
   * One line per distinct recorded error that passed through this function: its innermost frame in
   * this function (1-based). A region is narrowed to these lines only when they account for every
   * exception the region holds.
   */
  throwLines?: readonly number[];
}

export type ArmTaken = "taken" | "not-taken" | "unknown";

export interface PathArm {
  label: string;
  line?: number;
  /** Total over the calls; null when unknown. */
  count: number | null;
  taken: ArmTaken;
  why?: TruthWhy;
  /** No code of its own (an else that is not written, a short-circuit, no case matched). */
  implied?: boolean;
}

export type DecisionKind = "if" | "switch" | "ternary" | "logical" | "try";

export interface PathDecision {
  /** `kind#ordinal`, stable for one function's source. */
  id: string;
  nodeId: number;
  kind: DecisionKind;
  line: number;
  /** Source text of the test, truncated. */
  label: string;
  reach: number | null;
  why?: TruthWhy;
  arms: PathArm[];
  verdict: "one" | "split-loop" | "split-calls" | "unreached" | "unknown";
  /** Chip text: `then`, `then 1/3 . else 2/3`, `not reached`, `? (after-throw)`. */
  summary: string;
  inLoop: boolean;
}

export interface PathLoop {
  nodeId: number;
  line: number;
  label: string;
  kind: CfgLoop["loop"];
  /** Times the loop statement was reached. */
  entries: number | null;
  /** Body passes, total. */
  passes: number | null;
  why?: TruthWhy;
}

export interface PathExit {
  nodeId?: number;
  kind: "return" | "throw" | "end" | "exception";
  /** null: an exception whose line no recorded stack settles. */
  line: number | null;
  count: number | null;
  why?: TruthWhy;
  /** The innermost decision arm the exit sits in. */
  via?: { decision: string; label: string; arm: string; line: number };
}

/** The annotated tree for the flowchart (P4). */
export interface PathNode {
  id: number;
  k: CfgNode["k"];
  line: number;
  endLine: number;
  label?: string;
  n: number | null;
  why?: TruthWhy;
  body?: PathNode[];
  arms?: Array<{
    label: string;
    line: number;
    n: number | null;
    why?: TruthWhy;
    implied?: boolean;
    body?: PathNode[];
    /** A switch clause that can complete normally into the next one (structural; never the last). */
    fallsThrough?: boolean;
    /**
     * A switch clause grouped with its neighbours (`case 1: case 2: ...`): `n` is that shared
     * decision arm's count, not this clause's alone.
     */
    sharedArm?: string;
  }>;
  passes?: number | null;
  exit?: CfgExit["kind"];
  target?: string;
  calls?: string[];
  /** Calls whose callee the trace recorded as a hop of this function (analyze.ts links them). */
  callees?: Array<{ name: string; fnKey: string }>;
  /** Calls left unlinked because more than one recorded hop of this function matches the name. */
  ambiguous?: string[];
  /** Functions created here (callbacks, class members); `fnKey` when the payload has one. */
  fns?: Array<{ id: number; name: string; line: number; fnKey?: string }>;
  awaits?: number;
  /** Decision ids shown on this node (its own, and expression decisions inside it). */
  decisions?: string[];
}

export interface FnAnalysis {
  status: "ok" | "unknown";
  why?: TruthWhy;
  /** V8 call count (K). */
  calls: number;
  blended: boolean;
  decisions: PathDecision[];
  loops: PathLoop[];
  exits: PathExit[];
  graph?: PathNode;
  nodeCount: number;
  truncated?: boolean;
  warnings?: string[];
}

/* ----------------------------------------------------------- range lookup */

class Ranges {
  readonly list: RangeIn[];
  constructor(ranges: readonly RangeIn[]) {
    this.list = ranges.slice();
  }
  /** Index of the innermost range containing `o` (0 = the function), -1 for none. */
  at(o: number): number {
    let best = -1;
    let bestLen = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!;
      if (r.start <= o && o < r.end && r.end - r.start < bestLen) {
        best = i;
        bestLen = r.end - r.start;
      }
    }
    return best;
  }
  count(o: number): number {
    const i = this.at(o);
    return i < 0 ? 0 : this.list[i]!.count;
  }
  startOf(i: number): number {
    return i < 0 ? -1 : this.list[i]!.start;
  }
}

/* ------------------------------------------------------------------ model */

interface NodeT {
  reach: number;
  /** Executable node (a statement, decision or exit; not a container block). */
  exec: boolean;
  parent?: number;
  start: number;
  /** First statement of an arm (or of the function): its count is the arm's counter. */
  anchored?: boolean;
}

interface ArmT {
  label: string;
  line: number;
  count: number;
  implied?: boolean;
  /** No counter tells this arm's count (a guarded logical's short-circuit). */
  why?: TruthWhy;
  /**
   * A switch clause's matched count is its entries minus the previous clause's fall-through flow:
   * only as good as that flow, which an exception in the previous clause would inflate.
   */
  dep?: { from: number; to: number; entered: number };
}

interface DecisionT {
  nodeId: number;
  kind: DecisionKind;
  start: number;
  line: number;
  label: string;
  reach: number;
  arms: ArmT[];
  inLoop: boolean;
  /** Implied arm: an exception in the head would inflate it. */
  hasImplied: boolean;
  /** No counter tells how often it was reached. */
  reachWhy?: TruthWhy;
  /** switch: per clause, the index of its (possibly shared) arm. */
  caseArms?: number[];
}

interface LoopT {
  node: CfgLoop;
  reach: number;
  passes: number;
}

interface Region {
  from: number;
  to: number;
  why: TruthWhy;
  /** Every node inside is unknown (no exemption for nodes right after a counter). */
  all: boolean;
  /**
   * The exception may have been raised inside an exit's own expression (a catch or hop event, a
   * finally, a generator), unlike a deficit, which was seen in the flow toward a later counter.
   */
  exits?: boolean;
  /** Narrowed by recorded stacks that cover it: the exception was raised on one of these lines. */
  lines?: number[];
}

interface Pending {
  kind: "return" | "throw" | "break" | "continue";
  target?: string;
  n: number;
  /** An exit that left through a finally block: that finally may have replaced it. */
  guarded?: boolean;
  /** The exit statement (return / throw that may leave the function). */
  node?: CfgExit;
  via?: PathExit["via"];
  /** Finally blocks it passed: an exception raised in one replaces it. */
  through?: CfgBlock[];
  /** A finally it passed completed abruptly: which pending completions it replaced is unknown. */
  unsure?: boolean;
}

interface Walked {
  out: number;
  exits: Pending[];
  /** Exceptions that left this node (deficits seen inside and not caught inside). */
  escaped: number;
}

interface Ctx {
  loopDepth: number;
  /** Innermost try-with-catch whose try block encloses this point, and that block. */
  tryId?: number;
  tryBlock?: { start: number; end: number };
  /** `guards` when that try block was entered. */
  tryGuards?: number;
  /**
   * Enclosing sections a finally guards (try blocks and catch bodies of try-with-finally): an
   * exception raised in one can vanish there (the finally throws, returns or breaks instead).
   */
  guards: number;
  via?: PathExit["via"];
}

const AMBIGUOUS = -1;

interface ExcEvent {
  from: number;
  to: number;
  n: number;
  /**
   * What it explains: the try whose catch took it (its region lies inside that try block), the
   * function (no try with a catch around it), or AMBIGUOUS (the region starts outside the innermost
   * try block: the exception may have been raised before it, so it explains no catch).
   */
  tryId?: number;
  /** Seen as a deficit in the flow toward a later counter (so not raised inside an exit). */
  deficit?: boolean;
  /** Recorded stack lines inside [from, to), when they cover all `n` exceptions. */
  lines?: number[];
}

/* ------------------------------------------------------------------- walk */

/** Per-decision verdicts and per-node counts for one function's coverage (pure). */
export function pathTruth(input: TruthInput): FnAnalysis {
  const { fn } = input;
  const R = new Ranges(input.ranges);
  const K = input.ranges[0]?.count ?? 0;
  const nodes = new Map<number, NodeT>();
  const decisions: DecisionT[] = [];
  const decisionOf = new Map<number, DecisionT>();
  const loops: LoopT[] = [];
  const regions: Region[] = [];
  const events: ExcEvent[] = [];
  const warnings: string[] = [];
  let explicitThrowsOut = 0;
  /** Flows a finally cut to what its counters say (not by a recorded exception). */
  let clamps = 0;
  /**
   * A flow after `end` is a guess between bounds (a finally replaced one of several pending
   * completions, or a cut flow met an unplaced catch): what leans on it is after-throw, and so is
   * a deficit seen against it (the exception count).
   */
  let flowGuess = false;
  const guessed = (end: number) => {
    flowGuess = true;
    regions.push({ from: end - 1, to: fn.end, why: "after-throw", all: false });
  };
  let escapedOut = 0;

  /**
   * Record an exception somewhere in [from, to), seen as a deficit in the flow (it was raised in
   * what flows on, never inside an exit), attributed as ExcEvent.tryId says.
   */
  const exception = (from: number, to: number, n: number, ctx: Ctx) => {
    let tryId: number | undefined;
    if (ctx.tryId !== undefined)
      tryId =
        ctx.tryBlock && from >= ctx.tryBlock.start && to <= ctx.tryBlock.end && ctx.guards === ctx.tryGuards
          ? ctx.tryId
          : AMBIGUOUS;
    else if (ctx.guards > 0) tryId = AMBIGUOUS;
    events.push({ from, to, n, tryId, deficit: true });
  };
  /** Start of the counter segment `pos` is in: an exception detected later may be anywhere after it. */
  const segment = (pos: number) => R.startOf(R.at(pos));
  const inconsistent = (from: number) => regions.push({ from, to: fn.end, why: "arms-inconsistent", all: true });
  const note = (n: { id: number; start: number }, reach: number, exec: boolean, parent?: number) =>
    nodes.set(n.id, { reach, exec, parent, start: n.start });

  const consume = (w: Walked, pred: (p: Pending) => boolean): number => {
    let n = 0;
    w.exits = w.exits.filter((p) => {
      if (!pred(p)) return true;
      n += p.n;
      return false;
    });
    return n;
  };

  /* ---------------------------------------------------- expression decisions */

  const exprs = (list: readonly CfgExpr[] | undefined, ctxReach: number, ctx: Ctx, parent: number): number => {
    let escaped = 0;
    for (const e of list ?? []) {
      const bound = Math.min(R.count(e.start), ctxReach);
      // `&&=` / `||=` / `??=`: V8 keeps no counter for the right side (cfg.ts never shows them).
      const assign = e.k === "logical" && e.op.endsWith("=");
      if (e.guarded || assign) {
        guardedExpr(e, bound, ctx, parent, assign);
        continue;
      }
      const reach = bound;
      note(e, reach, true, parent);
      if (e.k === "cond") {
        const arms = e.arms.map((a) => ({ label: a.label, line: a.line, count: R.count(a.start) }));
        const sum = arms.reduce((s, a) => s + a.count, 0);
        if (sum > reach) inconsistent(e.start);
        else if (sum < reach) {
          // An exception before either arm: in the condition, or earlier since the last counter.
          exception(segment(e.start), e.arms[0]!.start, reach - sum, ctx);
          escaped += reach - sum;
        }
        addDecision(e.id, "ternary", e.start, e.line, e.label, reach, arms, ctx, false);
        e.arms.forEach((a, i) => {
          escaped += exprs(a.exprs, arms[i]!.count, ctx, e.id);
        });
      } else {
        const a = e.arms[0]!;
        const right = R.count(a.start);
        if (right > reach) inconsistent(e.start);
        const arms: ArmT[] = [
          { label: a.label, line: a.line, count: right },
          { label: "short-circuit", line: e.line, count: Math.max(0, reach - right), implied: true },
        ];
        if (e.shown) addDecision(e.id, "logical", e.start, e.line, e.label, reach, arms, ctx, true);
        escaped += exprs(a.exprs, right, ctx, e.id);
      }
    }
    return escaped;
  };

  /**
   * A decision its statement may skip (cfg.ts `guarded`), or a logical assignment: reached at most
   * `bound` times, as often as its arm counters say. Never an exception: a skipped one and one that
   * threw before its arms read the same, and a later counter still sees the throw's deficit.
   */
  const guardedExpr = (e: CfgExpr, bound: number, ctx: Ctx, parent: number, assign: boolean) => {
    if (e.k === "cond") {
      const arms = e.arms.map((a) => ({ label: a.label, line: a.line, count: R.count(a.start) }));
      const sum = arms.reduce((s, a) => s + a.count, 0);
      if (sum > bound) inconsistent(e.start);
      note(e, Math.min(sum, bound), true, parent);
      addDecision(e.id, "ternary", e.start, e.line, e.label, Math.min(sum, bound), arms, ctx, false);
      e.arms.forEach((a, i) => {
        exprs(a.exprs, arms[i]!.count, ctx, e.id);
      });
      return;
    }
    const a = e.arms[0]!;
    // A logical assignment's right side has no counter: what R reads there is the enclosing count.
    const right = R.count(a.start);
    if (!assign && right > bound) inconsistent(e.start);
    note(e, bound, true, parent);
    const arms: ArmT[] = [
      assign
        ? { label: a.label, line: a.line, count: 0, why: "no-counter" }
        : { label: a.label, line: a.line, count: right },
      { label: "short-circuit", line: e.line, count: 0, implied: true, why: "no-counter" },
    ];
    if (e.shown) {
      const d = addDecision(e.id, "logical", e.start, e.line, e.label, bound, arms, ctx, true);
      d.reachWhy = "no-counter";
    }
    // What is inside the right side is guarded too (cfg.ts): `right` only bounds it.
    exprs(a.exprs, assign ? bound : right, ctx, e.id);
  };

  const addDecision = (
    nodeId: number,
    kind: DecisionKind,
    start: number,
    line: number,
    label: string,
    reach: number,
    arms: ArmT[],
    ctx: Ctx,
    hasImplied: boolean,
  ) => {
    const d: DecisionT = { nodeId, kind, start, line, label, reach, arms, inLoop: ctx.loopDepth > 0, hasImplied };
    decisions.push(d);
    decisionOf.set(nodeId, d);
    return d;
  };

  /* ------------------------------------------------------------- statements */

  const seq = (
    list: readonly CfgNode[],
    flowIn: number,
    ctx: Ctx,
    containerStart: number,
    parent: number,
    anchored = false,
  ): Walked => {
    let flow = flowIn;
    let prev: CfgNode | undefined;
    const acc: Walked = { out: 0, exits: [], escaped: 0 };
    for (const s of list) {
      if (s.k === "fold") {
        note(s, flow, true, parent);
        regions.push({ from: s.start - 1, to: fn.end, why: "too-large", all: true });
        prev = s;
        continue;
      }
      const raw = R.count(s.start);
      if (raw < flow) {
        // An exception between the last counter before `s` and `s` (or a rejected await).
        const from = prev ? R.startOf(R.at(prev.start)) : containerStart;
        exception(from, s.start, flow - raw, ctx);
        acc.escaped += flow - raw;
        flow = raw;
      }
      const w = node(s, flow, ctx, parent);
      if (anchored && s === list[0] && flow === flowIn) nodes.get(s.id)!.anchored = true;
      acc.exits.push(...w.exits);
      acc.escaped += w.escaped;
      flow = w.out;
      prev = s;
    }
    acc.out = flow;
    return acc;
  };

  const labelled = (n: CfgNode, target: string | undefined) => !!target && !!n.labels?.includes(target);

  /** Walk one node; a labeled statement takes the `break label` aimed at it. */
  const node = (s: CfgNode, reach: number, ctx: Ctx, parent: number, anchored = false): Walked => {
    const w = walkKind(s, reach, ctx, parent, anchored);
    if (s.labels?.length) w.out += consume(w, (p) => p.kind === "break" && labelled(s, p.target));
    return w;
  };

  const walkKind = (s: CfgNode, reach: number, ctx: Ctx, parent: number, anchored: boolean): Walked => {
    switch (s.k) {
      case "block": {
        note(s, reach, false, parent);
        return seq(s.body, reach, ctx, s.start, s.id, anchored);
      }
      case "stmt": {
        note(s, reach, true, parent);
        const escaped = exprs(s.exprs, reach, ctx, s.id);
        return { out: Math.max(0, reach - escaped), exits: [], escaped };
      }
      case "exit": {
        note(s, reach, true, parent);
        const escaped = exprs(s.exprs, reach, ctx, s.id);
        const n = Math.max(0, reach - escaped);
        const p: Pending = { kind: s.kind, target: s.target, n, node: s };
        if (ctx.via) p.via = ctx.via;
        return { out: 0, exits: [p], escaped };
      }
      case "if":
        return ifNode(s, reach, ctx, parent);
      case "switch":
        return switchNode(s, reach, ctx, parent);
      case "loop":
        return loopNode(s, reach, ctx, parent);
      case "try":
        return tryNode(s, reach, ctx, parent);
      case "fold":
        note(s, reach, true, parent);
        regions.push({ from: s.start - 1, to: fn.end, why: "too-large", all: true });
        return { out: reach, exits: [], escaped: 0 };
    }
  };

  const viaOf = (d: { label: string; kind: DecisionKind; line: number }, arm: string, id: string): Ctx["via"] => ({
    decision: id,
    label: decisionText(d.kind, d.label),
    arm,
    line: d.line,
  });

  const ifNode = (s: CfgIf, reach: number, ctx: Ctx, parent: number): Walked => {
    note(s, reach, true, parent);
    let escaped = exprs(s.exprs, reach, ctx, s.id);
    const arms: ArmT[] = [];
    let remaining = reach - escaped;
    const acc: Walked = { out: 0, exits: [], escaped: 0 };
    const d = addDecision(s.id, "if", s.start, s.line, s.label, reach, arms, ctx, !s.hasElse);
    const ordinal = `if#${decisions.filter((x) => x.kind === "if").length - 1}`;
    s.arms.forEach((a: CfgArm, i) => {
      if (i > 0 && a.testExprs) {
        const lost = exprs(a.testExprs, remaining, ctx, s.id);
        escaped += lost;
        remaining -= lost;
      }
      const count = R.count(a.start);
      arms.push({ label: a.label, line: a.line, count });
      remaining -= count;
      const w = node(a.body, count, { ...ctx, via: viaOf(d, a.label, ordinal) }, s.id, true);
      acc.out += w.out;
      acc.exits.push(...w.exits);
      acc.escaped += w.escaped;
    });
    if (!s.hasElse) {
      arms.push({ label: "else", line: s.endLine, count: Math.max(0, remaining), implied: true });
      acc.out += Math.max(0, remaining);
    }
    if (remaining < 0) inconsistent(s.start);
    else if (s.hasElse && remaining > 0) {
      // Every arm is written out but fewer ran than reached the if: an exception in a test, or
      // earlier since the last counter.
      exception(segment(s.start), s.arms[0]!.start, remaining, ctx);
      escaped += remaining;
    }
    acc.escaped += escaped;
    return acc;
  };

  const switchNode = (s: CfgSwitch, reach: number, ctx: Ctx, parent: number): Walked => {
    note(s, reach, true, parent);
    let escaped = exprs(s.exprs, reach, ctx, s.id);
    // What got past the discriminant.
    const avail = Math.max(0, reach - escaped);
    const arms: ArmT[] = [];
    const acc: Walked = { out: 0, exits: [], escaped: 0 };
    const d = addDecision(s.id, "switch", s.start, s.line, s.label, reach, arms, ctx, false);
    const ordinal = `switch#${decisions.filter((x) => x.kind === "switch").length - 1}`;
    let fall = 0;
    let matched = 0;
    let prev: CfgCase | undefined;
    // Empty clauses (`case "a": case "b": ...`) share the next clause's arm: no telling them apart.
    let group: { labels: string[]; line: number; count: number; dep?: ArmT["dep"] } | undefined;
    const caseArms: number[] = [];
    d.caseArms = caseArms;
    s.cases.forEach((c: CfgCase, i) => {
      caseArms.push(arms.length);
      escaped += exprs(c.exprs, Math.max(0, reach - matched), ctx, s.id);
      const entered = R.count(c.start);
      if (entered < fall) {
        // Fewer entered than fell through: the previous clause threw (counted here).
        const last = prev?.body[prev.body.length - 1];
        const from = last ? R.startOf(R.at(last.start)) : (prev?.start ?? s.start);
        exception(from, c.start, fall - entered, ctx);
        acc.escaped += fall - entered;
        fall = entered;
      }
      const hit = entered - fall;
      matched += hit;
      group ??= { labels: [], line: c.line, count: 0 };
      group.labels.push(c.label);
      group.count += hit;
      if (fall > 0 && prev) {
        const dep = { from: prev.start, to: c.start, entered };
        group.dep = group.dep ? { from: group.dep.from, to: dep.to, entered: group.dep.entered + entered } : dep;
      }
      const w = seq(c.body, entered, { ...ctx, via: viaOf(d, c.label, ordinal) }, c.start, s.id, true);
      acc.out += consume(w, (p) => p.kind === "break" && (!p.target || labelled(s, p.target)));
      acc.exits.push(...w.exits);
      acc.escaped += w.escaped;
      fall = w.out;
      prev = c;
      if (c.body.length > 0 || i === s.cases.length - 1) {
        const arm: ArmT = { label: group.labels.join(", "), line: group.line, count: group.count };
        if (group.dep) arm.dep = group.dep;
        arms.push(arm);
        group = undefined;
      }
    });
    acc.out += fall;
    const hasDefault = s.cases.some((c) => c.isDefault);
    if (!hasDefault) {
      arms.push({ label: "no case", line: s.line, count: Math.max(0, avail - matched), implied: true });
      d.hasImplied = true;
      acc.out += Math.max(0, avail - matched);
    }
    if (matched > avail) inconsistent(s.start);
    else if (hasDefault && matched < avail) {
      // Fewer matched than got past the discriminant: an exception there, or before the switch, or
      // one inside a clause that inflated the fall-through into the next.
      exception(segment(s.start), s.end, avail - matched, ctx);
      escaped += avail - matched;
    }
    acc.escaped += escaped;
    return acc;
  };

  const loopNode = (s: CfgLoop, reach: number, ctx: Ctx, parent: number): Walked => {
    note(s, reach, true, parent);
    // Head decisions of for / while / do run once per pass plus once more; V8 has no counter that
    // tells those apart from the loop's entries, so they are not modelled. A for-of / for-in
    // iterable is evaluated once per entry.
    const iterates = s.loop === "for-of" || s.loop === "for-in" || s.loop === "for-await";
    const passes = R.count(s.bodyStart);
    // The binding (guarded in cfg.ts) runs once per pass: bounded by the passes, not the entries.
    let escaped = iterates
      ? exprs(
          s.exprs.filter((e) => !e.guarded),
          reach,
          ctx,
          s.id,
        )
      : 0;
    // (Not countAt there: the head sits outside the body's range and reads the entries.)
    if (iterates) for (const e of s.exprs) if (e.guarded) guardedExpr(e, passes, ctx, s.id, false);
    // Body passes need an entry: passes with no reach mean the structure is wrong here.
    if ((reach === 0 && passes > 0) || (s.loop === "do" && passes < reach)) inconsistent(s.start);
    loops.push({ node: s, reach, passes });
    const w = node(s.body, passes, { ...ctx, loopDepth: ctx.loopDepth + 1 }, s.id, true);
    const mine = (p: Pending) => !p.target || labelled(s, p.target);
    consume(w, (p) => (p.kind === "break" || p.kind === "continue") && mine(p));
    const left = w.exits.reduce((n, p) => n + p.n, 0) + w.escaped;
    const out = reach - left;
    if (out < 0) inconsistent(s.start);
    escaped += w.escaped;
    return { out: Math.max(0, out), exits: w.exits, escaped };
  };

  const tryNode = (s: CfgTry, reach: number, ctx: Ctx, parent: number): Walked => {
    note(s, reach, true, parent);
    const hasCatch = !!s.catch;
    // Inside the block and the catch an exception may vanish in this try's finally.
    const guards = ctx.guards + (s.finally ? 1 : 0);
    const inner: Ctx = hasCatch
      ? { ...ctx, guards, tryId: s.id, tryBlock: { start: s.block.start, end: s.block.end }, tryGuards: guards }
      : { ...ctx, guards };
    const before = events.length;
    const clampsBefore = clamps;
    const wb = node(s.block, reach, inner, s.id);
    const placed = events.slice(before).reduce((n, e) => n + (e.tryId === s.id ? e.n : 0), 0);
    const acc: Walked = { out: wb.out, exits: [], escaped: 0 };
    if (s.catch) {
      const C = R.count(s.catch.start);
      const sure = wb.exits.reduce((n, p) => n + (p.kind === "throw" && !p.guarded ? p.n : 0), 0);
      const thrown = consume(wb, (p) => p.kind === "throw");
      const explained = sure + placed;
      if (C > explained) {
        // Exceptions the counters cannot place: a callee threw inside the try block.
        events.push({ from: s.block.start, to: s.block.end, n: C - explained, tryId: s.id });
        // Those runs did not complete the block either (deficits seen inside it already took theirs):
        // they were exits a nested finally replaced, or normal completions.
        let need = Math.max(0, C - thrown - wb.escaped);
        // Which of them (an exit a nested finally passed, or a normal completion) is a guess when
        // more than one could be: those exits and the flow after this try are not exact.
        const passed = wb.exits.filter((p) => p.guarded && p.n > 0);
        if (need > 0 && passed.length > 0 && (passed.length > 1 || acc.out > 0)) {
          for (const p of passed) p.unsure = true;
          guessed(s.end);
        }
        for (const p of wb.exits)
          if (p.guarded && need > 0) {
            const take = Math.min(p.n, need);
            p.n -= take;
            need -= take;
          }
        acc.out = Math.max(0, acc.out - need);
        if (need > 0 && clamps > clampsBefore)
          // A finally inside the block already cut its flow to what its counters say, which may
          // have dropped these runs once: the out lies between that and the cut one.
          guessed(s.end);
      } else if (C < explained) inconsistent(s.start);
      if (C > reach) inconsistent(s.start);
      const d = addDecision(
        s.id,
        "try",
        s.start,
        s.line,
        "try",
        reach,
        [
          { label: "no throw", line: s.line, count: Math.max(0, reach - C), implied: true },
          { label: "catch", line: s.catch.line, count: C },
        ],
        ctx,
        true,
      );
      const ordinal = `try#${decisions.filter((x) => x.kind === "try").length - 1}`;
      const wc = node(s.catch.body, C, { ...ctx, guards, via: viaOf(d, "catch", ordinal) }, s.id, true);
      acc.out += wc.out;
      acc.exits.push(...wb.exits, ...wc.exits);
      // Deficits inside the block beyond what the catch took were raised before the try (their
      // region starts outside it): they leave with the try.
      acc.escaped += wc.escaped + Math.max(0, thrown + wb.escaped - C);
    } else {
      acc.exits.push(...wb.exits);
      acc.escaped += wb.escaped;
    }
    if (s.finally) {
      const F = R.count(s.finally.start);
      if (F > reach) inconsistent(s.start);
      // Exits leaving the block or the catch pass the finally, which may replace them.
      for (const p of acc.exits) {
        p.guarded = true;
        (p.through ??= []).push(s.finally.body);
      }
      const seen = events.length;
      const wf = node(s.finally.body, F, ctx, s.id, true);
      // Each abrupt completion of the finally (its own exit or exception) overrides one pending
      // completion of the block or the catch: drop that many (exceptions first, then exits).
      const abrupt = wf.escaped + wf.exits.reduce((n, p) => n + p.n, 0);
      let excess = acc.out + acc.escaped + acc.exits.reduce((n, p) => n + p.n, 0) - Math.max(0, F - abrupt);
      if (abrupt > 0 && excess > 0) {
        // Which pending completions the finally replaced is a guess when more than one could have
        // been: the flows after this try (and at the targets of its breaks) are not exact.
        const pending = [acc.out, acc.escaped, ...acc.exits.map((p) => p.n)].filter((n) => n > 0).length;
        if (pending > 1) guessed(s.end);
        const cut = Math.min(acc.escaped, excess);
        acc.escaped -= cut;
        excess -= cut;
        for (let i = acc.exits.length - 1; i >= 0 && excess > 0; i--) {
          const p = acc.exits[i]!;
          const take = Math.min(p.n, excess);
          p.n -= take;
          excess -= take;
        }
        if (excess > 0) clamps++;
        acc.out = Math.max(0, acc.out - excess);
      }
      if (wf.out < F) {
        // The finally block exits on its own: what it overrides is not modelled further.
        if (wf.out < acc.out) clamps++;
        acc.out = Math.min(acc.out, wf.out);
      }
      if (events.length > seen || wf.exits.some((p) => p.n > 0) || wf.out < F) {
        // The finally completed abruptly at least once: an exception pending from the block or the
        // catch may have vanished there, leaving no count anywhere, and so may an exit.
        regions.push({ from: s.block.start, to: s.finally.start, why: "after-throw", all: false });
        for (const p of acc.exits) p.unsure = true;
      }
      acc.exits.push(...wf.exits);
      acc.escaped += wf.escaped;
    }
    return acc;
  };

  /* ----------------------------------------------------------------- run it */

  const root = fn.body;
  // The body's first statement runs once per call only when nothing runs (or waits) in between.
  const entered = !fn.generator && !fn.paramInit;
  const top = seq(root.body, K, { loopDepth: 0, guards: 0 }, root.start, root.id, entered);
  if (fn.generator && K > 0)
    // A generator's body runs when iterated, not when called: only its own counters say how often.
    regions.push({ from: root.start, to: fn.end, why: "suspended", all: false, exits: true });
  else if (fn.paramInit && K > 0 && input.threw === undefined)
    // A parameter default may have thrown before the body, and no hop says whether one did.
    regions.push({ from: root.start, to: fn.end, why: "after-throw", all: false, exits: true });
  explicitThrowsOut = top.exits.reduce((n, p) => n + (p.kind === "throw" && !p.guarded ? p.n : 0), 0);
  note(root, K, false);
  escapedOut = events.reduce((n, e) => n + (e.tryId === undefined ? e.n : 0), 0);
  // break / continue that found no target: the model is wrong for this function.
  if (top.exits.some((p) => p.kind === "break" || p.kind === "continue")) inconsistent(root.start);
  const ended = top.out;

  // A hop that threw more often than the function's own throws and deficits explain: a callee
  // threw where no counter follows.
  let suspended = false;
  let hopThrew = 0;
  if (input.threw !== undefined) {
    const explained = explicitThrowsOut + escapedOut;
    if (input.threw > explained) {
      hopThrew = input.threw - explained;
      events.push({ from: root.start, to: root.end, n: hopThrew });
    } else if (input.threw < explained) {
      // Deficits the hops did not record as errors: a call suspended there (an await still
      // pending, a generator parked at a yield) reads exactly like an exception.
      suspended = true;
      warnings.push(
        `${explained - input.threw} exit(s) look like exceptions the hops did not record (a suspended generator or an await that never resumed?)`,
      );
    }
  }

  /* ---------------------------------------------------- regions (throw cut) */

  const exec = [...nodes.entries()].filter(([, t]) => t.exec).sort((a, b) => a[1].start - b[1].start);
  const isAncestor = (a: number, of: number): boolean => {
    for (let p = nodes.get(of)?.parent; p !== undefined; p = nodes.get(p)?.parent) if (p === a) return true;
    return false;
  };
  // Statement-level nodes a throw line can name (the innermost one containing the line).
  const lineNodes = (line: number, from: number, to: number): number | undefined => {
    let best: { start: number; len: number } | undefined;
    const visit = (n: CfgNode | CfgExpr) => {
      if (!("k" in n)) return;
      if (n.k === "block" || n.k === "cond" || n.k === "logical") return;
      if (n.start < from || n.start >= to || line < n.line || line > n.endLine) return;
      const len = n.end - n.start;
      if (!best || len < best.len || (len === best.len && n.start < best.start)) best = { start: n.start, len };
    };
    walkNodes(fn, visit);
    return best?.start;
  };
  for (const e of events) {
    const from = e.from;
    let located: number | undefined;
    const lines: number[] = [];
    for (const l of input.throwLines ?? []) {
      const at = lineNodes(l, e.from, e.to);
      if (at === undefined) continue;
      lines.push(l);
      if (located === undefined || at < located) located = at;
    }
    const g: Region = { from, to: e.to, why: "after-throw", all: false };
    if (!e.deficit) g.exits = true;
    // Every exception here has a recorded stack: it was raised at the earliest of those statements.
    if (located !== undefined && lines.length >= e.n) {
      g.from = located;
      g.lines = lines;
      e.lines = lines;
    }
    regions.push(g);
  }

  /** Why node `id` (starting at `start`) has no trustworthy count, if it has none. */
  const suspect = (id: number, start: number): TruthWhy | undefined => {
    for (const g of regions) {
      if (g.all) {
        if (start > g.from && start < g.to) return g.why;
        continue;
      }
      if (!(start > g.from && start < g.to)) continue;
      if (nodes.get(id)?.anchored) continue;
      // Exempt: right after a counter that fired inside the region, with nothing run in between.
      const r = R.at(start);
      const rs = R.startOf(r);
      if (rs > g.from) {
        const between = exec.some(([oid, t]) => oid !== id && t.start >= rs && t.start < start && !isAncestor(oid, id));
        // ...and only when its count is that counter's: a flow below it is no count to vouch for.
        if (!between && nodes.get(id)?.reach === R.list[r]!.count) continue;
      }
      return g.why;
    }
    return undefined;
  };
  /** Regions whose exception may have been raised in this decision's head. */
  const headIn = (start: number): TruthWhy | undefined => {
    for (const g of regions) if (start >= g.from && start < g.to) return g.why;
    return undefined;
  };

  /**
   * The line the escaping exceptions were raised on: the one recorded stack line in this function
   * that no catch here took (a catch event that its lines cover exactly claims them). null when no
   * line, or more than one, is left.
   */
  const exceptionLine = (): number | null => {
    const claimed = new Set<number>();
    for (const e of events)
      if (e.tryId !== undefined && e.tryId !== AMBIGUOUS && e.lines && e.lines.length === e.n)
        for (const l of e.lines) claimed.add(l);
    const left = new Set((input.throwLines ?? []).filter((l) => l >= fn.line && l <= fn.endLine && !claimed.has(l)));
    return left.size === 1 ? [...left][0]! : null;
  };

  /**
   * Every call ends in one exit (or is still suspended): when the counted exits already add up to
   * the calls, the unknown ones are 0. (An unknown one is never set to what is left: that would
   * lean on every other exit being listed and exact.)
   */
  const settleExits = (list: PathExit[]) => {
    if (regions.some((g) => g.all && g.why === "arms-inconsistent")) return;
    const unknown = list.filter((e) => e.count === null);
    if (!unknown.length) return;
    const known = list.reduce((n, e) => n + (e.count ?? 0), 0);
    if (known === K) for (const e of unknown) list.splice(list.indexOf(e), 1);
  };

  /* ----------------------------------------------------------------- output */

  const reachOf = (id: number): { n: number | null; why?: TruthWhy } => {
    const t = nodes.get(id);
    if (!t) return { n: null, why: "too-large" };
    const why = suspect(id, t.start);
    return why ? { n: null, why } : { n: t.reach };
  };

  const ords = new Map<string, number>();
  const outDecisions: PathDecision[] = [];
  const decisionIds = new Map<number, string>();
  for (const d of decisions) {
    const ord = ords.get(d.kind) ?? 0;
    ords.set(d.kind, ord + 1);
    const id = `${d.kind}#${ord}`;
    decisionIds.set(d.nodeId, id);
    const r = reachOf(d.nodeId);
    // An implied arm is inflated by an exception in the decision's test (a try has none).
    const headWhy = d.hasImplied && d.kind !== "try" ? headIn(d.start) : undefined;
    const inconsistentHere = regions.some(
      (g) => g.all && g.why === "arms-inconsistent" && d.start >= g.from && d.start < g.to,
    );
    const arms: PathArm[] = d.arms.map((a) => {
      let why: TruthWhy | undefined;
      if (inconsistentHere) why = "arms-inconsistent";
      else if (a.why) why = a.why;
      else if (a.implied) why = r.why ?? headWhy;
      else {
        const g = regions.find((x) => x.all && d.start > x.from && d.start < x.to);
        why = g?.why;
      }
      // A switch clause's matched count leans on the fall-through flow of the clause before it.
      if (!why && a.dep && a.dep.entered > 0) {
        const dep = a.dep;
        const g = regions.find((x) => x.from < dep.to && x.to > dep.from);
        if (g) why = g.why;
      }
      const arm: PathArm = {
        label: a.label,
        line: a.line,
        count: why ? null : a.count,
        taken: why ? "unknown" : a.count > 0 ? "taken" : "not-taken",
      };
      if (why) arm.why = why;
      if (a.implied) arm.implied = true;
      return arm;
    });
    // An implied arm is the reach minus the written arms: unknown as soon as one of them is.
    const lost = arms.find((a) => !a.implied && a.taken === "unknown");
    if (lost)
      for (const a of arms)
        if (a.implied && a.taken !== "unknown") {
          a.count = null;
          a.taken = "unknown";
          a.why = lost.why;
        }
    let reach = r.n;
    let why = r.why;
    if (inconsistentHere) {
      reach = null;
      why = "arms-inconsistent";
    } else if (d.reachWhy) {
      reach = null;
      why = d.reachWhy;
    } else if (reach === null && arms.every((a) => a.count !== null)) {
      // Every arm has its own counter: they sum to what reached the decision.
      reach = arms.reduce((s, a) => s + (a.count ?? 0), 0);
      why = undefined;
    }
    const taken = arms.filter((a) => a.taken === "taken");
    const unknown = arms.some((a) => a.taken === "unknown");
    let verdict: PathDecision["verdict"];
    if (reach === 0 && !unknown) verdict = "unreached";
    else if (taken.length > 1) verdict = K > 1 ? "split-calls" : "split-loop";
    else if (taken.length === 1 && !unknown) verdict = "one";
    else verdict = "unknown";
    const out: PathDecision = {
      id,
      nodeId: d.nodeId,
      kind: d.kind,
      line: d.line,
      label: d.label,
      reach,
      arms,
      verdict,
      summary: "",
      inLoop: d.inLoop,
    };
    if (why) out.why = why;
    out.summary = decisionSummary(out);
    outDecisions.push(out);
  }

  const caseArmsOf = new Map<number, number[]>();
  for (const d of decisions) if (d.caseArms) caseArmsOf.set(d.nodeId, d.caseArms);

  const outLoops: PathLoop[] = loops.map((l) => {
    const r = reachOf(l.node.id);
    const passesWhy = regions.find((g) => g.all && l.node.start > g.from && l.node.start < g.to)?.why;
    const out: PathLoop = {
      nodeId: l.node.id,
      line: l.node.line,
      label: l.node.label,
      kind: l.node.loop,
      entries: r.n,
      passes: passesWhy ? null : l.passes,
    };
    const why = r.why ?? passesWhy;
    if (why) out.why = why;
    return out;
  });

  /**
   * Why an exit's completions are unknown: an exception may have been raised inside it, or in a
   * finally it passed (which then replaced it).
   */
  const raisedIn = (p: Pending): TruthWhy | undefined => {
    if (p.unsure) return "after-throw";
    for (const x of [p.node!, ...(p.through ?? [])])
      for (const g of regions) {
        if (g.all || !g.exits || !(g.from < x.end && g.to > x.start)) continue;
        if (g.lines && !g.lines.some((l) => l >= x.line && l <= x.endLine)) continue;
        return g.why;
      }
    return undefined;
  };
  const outExits: PathExit[] = [];
  // The returns and throws that left the function, with what completed (a caught throw is none).
  for (const p of top.exits) {
    const x = p.node;
    if (!x || (p.kind !== "return" && p.kind !== "throw")) continue;
    const r = reachOf(x.id);
    const why = r.why ?? raisedIn(p);
    if (!why && p.n === 0) continue;
    const e: PathExit = { nodeId: x.id, kind: p.kind, line: x.line, count: why ? null : p.n };
    if (why) e.why = why;
    if (p.via) e.via = p.via;
    outExits.push(e);
  }
  // Falling off the end, and exceptions the counters placed (deficits that left the function).
  const endWhy = suspect(-1, root.end - 1);
  if (ended > 0 || endWhy) {
    if (!endWhy || ended > 0) {
      const e: PathExit = { kind: "end", line: fn.endLine, count: endWhy ? null : ended };
      if (endWhy) e.why = endWhy;
      outExits.push(e);
    }
  }
  const escapes = events.filter((e) => e.tryId === undefined);
  const thrown = escapes.reduce((s, e) => s + e.n, 0);
  if (thrown > 0) {
    // Hop errors beyond what the counters explain are exceptions, unless an explicit throw that
    // left through a finally (not counted as explained: the finally may have replaced it) was one.
    // (By its reach: a finally's cut may have taken its count.)
    const passedFinally = top.exits.some(
      (p) => p.kind === "throw" && p.guarded && (nodes.get(p.node?.id ?? -1)?.reach ?? 0) > 0,
    );
    const why: TruthWhy | undefined = suspended
      ? "suspended"
      : (hopThrew > 0 && passedFinally) || flowGuess
        ? "after-throw"
        : undefined;
    const e: PathExit = { kind: "exception", line: exceptionLine(), count: why ? null : thrown };
    if (why) e.why = why;
    outExits.push(e);
  }
  settleExits(outExits);

  const graph = toGraph(fn, reachOf, decisionIds, outDecisions, outLoops, caseArmsOf, input.file);
  const result: FnAnalysis = {
    status: "ok",
    calls: K,
    blended: K > 1,
    decisions: outDecisions,
    loops: outLoops,
    exits: outExits,
    graph,
    nodeCount: fn.nodeCount,
  };
  if (fn.truncated) result.truncated = true;
  if (warnings.length) result.warnings = warnings;
  return result;
}

/** `if !user`, `switch (order.status)`, `user.vip ?`, `order.coupon &&`, `try`. */
export function decisionText(kind: DecisionKind, label: string): string {
  switch (kind) {
    case "if":
      return `if ${label}`;
    case "switch":
      return `switch (${label})`;
    case "ternary":
      return `${label} ?`;
    case "logical":
      return label;
    case "try":
      return "try";
  }
}

/** `then` | `then 1/3 . else 2/3` | `not reached` | `? (after-throw)`. */
export function decisionSummary(d: Pick<PathDecision, "verdict" | "arms" | "reach" | "why">): string {
  switch (d.verdict) {
    case "unreached":
      return "not reached";
    case "one":
      return d.arms.find((a) => a.taken === "taken")!.label;
    case "split-loop":
    case "split-calls":
      return d.arms
        .filter((a) => a.taken === "taken")
        .map((a) => `${a.label} ${a.count}/${d.reach ?? "?"}`)
        .join(" . ");
    default: {
      const why = d.why ?? d.arms.find((a) => a.why)?.why;
      const taken = d.arms.filter((a) => a.taken === "taken").map((a) => a.label);
      return `${taken.length ? `${taken.join(" + ")} ` : ""}? (${why ?? "unknown"})`;
    }
  }
}

/** Visit every node and expression decision of a function, source order. */
function walkNodes(fn: CfgFunction, visit: (n: CfgNode | CfgExpr) => void): void {
  const ex = (list: readonly CfgExpr[] | undefined) => {
    for (const e of list ?? []) {
      visit(e);
      for (const a of e.arms) ex(a.exprs);
    }
  };
  const go = (n: CfgNode): void => {
    visit(n);
    switch (n.k) {
      case "block":
        for (const c of n.body) go(c);
        break;
      case "stmt":
      case "exit":
        ex(n.exprs);
        break;
      case "if":
        ex(n.exprs);
        for (const a of n.arms) {
          ex(a.testExprs);
          go(a.body);
        }
        break;
      case "switch":
        ex(n.exprs);
        for (const c of n.cases) {
          ex(c.exprs);
          for (const s of c.body) go(s);
        }
        break;
      case "loop":
        ex(n.exprs);
        go(n.body);
        break;
      case "try":
        go(n.block);
        if (n.catch) go(n.catch.body);
        if (n.finally) go(n.finally.body);
        break;
      case "fold":
        break;
    }
  };
  go(fn.body);
}

function toGraph(
  fn: CfgFunction,
  reachOf: (id: number) => { n: number | null; why?: TruthWhy },
  decisionIds: Map<number, string>,
  decisions: PathDecision[],
  loops: PathLoop[],
  caseArms: Map<number, number[]>,
  file: CfgFile | undefined,
): PathNode {
  const byNode = new Map(decisions.map((d) => [d.nodeId, d] as const));
  const passes = new Map(loops.map((l) => [l.nodeId, l] as const));
  const exprIds = (list: readonly CfgExpr[] | undefined, out: string[]) => {
    for (const e of list ?? []) {
      const id = decisionIds.get(e.id);
      if (id) out.push(id);
      for (const a of e.arms) exprIds(a.exprs, out);
    }
  };
  const base = (n: CfgNode): PathNode => {
    const r = reachOf(n.id);
    const p: PathNode = { id: n.id, k: n.k, line: n.line, endLine: n.endLine, n: r.n };
    if (r.why) p.why = r.why;
    return p;
  };
  const extras = (p: PathNode, n: { calls?: string[]; fns?: number[]; awaits?: number; exprs?: CfgExpr[] }) => {
    if (n.calls?.length) p.calls = n.calls;
    if (n.awaits) p.awaits = n.awaits;
    const ids: string[] = [];
    const own = decisionIds.get(p.id);
    if (own) ids.push(own);
    exprIds(n.exprs, ids);
    if (ids.length) p.decisions = ids;
    if (n.fns?.length)
      p.fns = n.fns.map((id) => {
        const f = file?.functions[id];
        return { id, name: f?.name ?? "", line: f?.line ?? p.line };
      });
  };
  const list = (n: CfgNode): PathNode[] => (n.k === "block" ? n.body.map(conv) : [conv(n)]);
  const conv = (n: CfgNode): PathNode => {
    const p = base(n);
    switch (n.k) {
      case "block":
        p.body = n.body.map(conv);
        break;
      case "stmt":
        p.label = n.label;
        extras(p, n);
        break;
      case "exit":
        p.label = n.label;
        p.exit = n.kind;
        if (n.target) p.target = n.target;
        extras(p, n);
        break;
      case "if": {
        p.label = n.label;
        extras(p, n);
        const d = byNode.get(n.id);
        p.arms = n.arms.map((a, i) => {
          const t = d?.arms[i];
          const arm: NonNullable<PathNode["arms"]>[number] = {
            label: a.label,
            line: a.line,
            n: t?.count ?? null,
            body: list(a.body),
          };
          if (t?.why) arm.why = t.why;
          return arm;
        });
        const implied = d?.arms.find((a) => a.implied);
        if (implied) {
          const arm: NonNullable<PathNode["arms"]>[number] = {
            label: implied.label,
            line: n.endLine,
            n: implied.count,
            implied: true,
          };
          if (implied.why) arm.why = implied.why;
          p.arms.push(arm);
        }
        break;
      }
      case "switch": {
        p.label = n.label;
        extras(p, n);
        const d = byNode.get(n.id);
        const map = caseArms.get(n.id) ?? [];
        const last = n.cases.length - 1;
        p.arms = n.cases.map((c, i) => {
          // The clause's matched count is its decision arm's (empty clauses share the next one's).
          const t = d?.arms[map[i] ?? -1];
          const arm: NonNullable<PathNode["arms"]>[number] = {
            label: c.label,
            line: c.line,
            n: t ? t.count : null,
            body: c.body.map(conv),
          };
          if (t?.why) arm.why = t.why;
          else if (!t) arm.why = "too-large";
          if (t && map.filter((x) => x === map[i]).length > 1) arm.sharedArm = t.label;
          if (i < last && completes(c.body)) arm.fallsThrough = true;
          return arm;
        });
        break;
      }
      case "loop": {
        p.label = n.label;
        extras(p, n);
        // The same value loops[] reports (own counter, unknown only in an `all` region).
        p.passes = passes.get(n.id)?.passes ?? null;
        p.body = list(n.body);
        break;
      }
      case "try": {
        const d = byNode.get(n.id);
        p.arms = [{ label: "try", line: n.line, n: p.n, body: list(n.block) }];
        if (n.catch) {
          const c = d?.arms[1];
          const arm: NonNullable<PathNode["arms"]>[number] = {
            label: "catch",
            line: n.catch.line,
            n: c?.count ?? null,
            body: list(n.catch.body),
          };
          if (c?.why) arm.why = c.why;
          p.arms.push(arm);
        }
        if (n.finally) {
          const r = reachOf(n.finally.body.id);
          const arm: NonNullable<PathNode["arms"]>[number] = {
            label: "finally",
            line: n.finally.line,
            n: r.n,
            body: list(n.finally.body),
          };
          if (r.why) arm.why = r.why;
          p.arms.push(arm);
        }
        const own = decisionIds.get(n.id);
        if (own) p.decisions = [own];
        break;
      }
      case "fold":
        p.label = `${n.count} statement${n.count === 1 ? "" : "s"} folded`;
        break;
    }
    return p;
  };
  return conv(fn.body as CfgBlock);
}

/**
 * Whether a statement list can complete normally (structural, conservative: a loop, a nested
 * switch or a labeled statement may). A switch clause that can falls through into the next.
 */
function completes(list: readonly CfgNode[]): boolean {
  const one = (n: CfgNode): boolean => {
    if (n.labels?.length) return true;
    switch (n.k) {
      case "exit":
        return false;
      case "block":
        return completes(n.body);
      case "if":
        return !n.hasElse || n.arms.some((a) => one(a.body));
      case "try": {
        const body = one(n.block) || (!!n.catch && one(n.catch.body));
        return n.finally ? body && one(n.finally.body) : body;
      }
      default:
        return true;
    }
  };
  return list.every(one);
}

/* ------------------------------------------------------------------ join */

export interface JoinInput {
  /** The model of the file as it is on disk now. */
  cfg: CfgFile | undefined;
  ranges: readonly RangeIn[];
  /** sha1/12 of the file at capture, and now. */
  capturedHash?: string;
  currentHash?: string;
  /** The file changed after the process started (its text may not be what V8 compiled). */
  stale?: boolean;
  /** A TypeScript-family file (an offset mismatch means compiled output, not an edit). */
  typescript?: boolean;
}

/**
 * The model function a coverage function is, validated: the file must hash as it did at capture,
 * and the function's AST start and end must be the coverage function's range (identity mapping).
 */
export function joinCfg(j: JoinInput): { fn: CfgFunction } | { why: TruthWhy } {
  if (!j.cfg) return { why: "no-analyzer" };
  if (j.capturedHash === undefined || j.currentHash === undefined) return { why: "source-unreadable" };
  if (j.capturedHash !== j.currentHash || j.stale) return { why: "source-moved" };
  const r0 = j.ranges[0];
  if (!r0) return { why: "no-blocks" };
  const fn = j.cfg.functions.find((f) => f.starts.includes(r0.start));
  if (!fn || fn.end !== r0.end) {
    // The text is the one V8 ran (hash and mtime hold), so this is no edit: a TypeScript file is
    // compiled output; otherwise the model has no function there (or a cap left it out).
    if (j.typescript) return { why: "compiled" };
    return { why: j.cfg.truncated && !fn ? "too-large" : "no-function" };
  }
  return { fn };
}

/** Every decision, loop and exit UNKNOWN for `why` (a function whose counts cannot be joined). */
export function unknownAnalysis(why: TruthWhy, calls: number): FnAnalysis {
  return { status: "unknown", why, calls, blended: calls > 1, decisions: [], loops: [], exits: [], nodeCount: 0 };
}
