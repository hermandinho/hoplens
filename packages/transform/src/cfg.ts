// Request path, layer 3a: a structured control-flow model of every function in one source file,
// read off the TypeScript AST (plan P2, mockup C). Pure: no fs, no runtime dependencies; the caller
// hands in the TypeScript module (loadTypeScript) and the file's text.
//
// The model is a tree, not a graph: statements stay grouped in blocks, and every decision keeps its
// arms in source order, so `@hoplens/core`'s truth model (path/truth.ts) can join V8 block counts to
// it structurally (a node after an always-exiting arm cannot run more often than what reached it).
//
//   function -> block -> [stmt | if | switch | loop | try | exit | fold]
//   if       -> arms: then, else-if..., else (or none: the else is implied)
//   switch   -> cases in source order (fall-through is the truth model's business)
//   loop     -> for, for-of, for-in, for-await, while, do; `labels` for labeled break/continue
//   try      -> block, catch?, finally?
//   exit     -> return | throw | break | continue (with the target label)
//   stmt     -> anything else that runs: calls, awaits, nested functions (by id, never inlined)
//   (`with (o) body` is its body as a block; `o`'s decisions are not modelled)
//
// Expression decisions (`exprs`, on the statement or decision head that evaluates them):
//   cond     -> `a ? b : c`, always a decision (arms true / false)
//   logical  -> `a && b`, `a || b`, `a ?? b`. Every one is kept for nesting, but `shown` only when
//               it decides something: the right side has a side effect (a call, new, await, yield,
//               delete, assignment, ++/--), or the whole expression is the value a return / throw
//               / concise arrow hands back. A pure `x && x.y` is a value, not a path decision.
//               `&&=`, `||=`, `??=` are kept but never shown: V8 keeps no block counter for their
//               right side (probed), so nothing tells whether it ran.
//   guarded  -> a decision in code its statement may skip: the tail of an optional chain after
//               `?.` (V8 keeps no counter for the short-circuit), a destructuring or parameter
//               default, a logical assignment's right side, a for-of / for-in binding (per pass,
//               not per entry). Only its own arm counters say how often it ran.
// Class field initializers run in V8's synthetic initializer functions, not in the statement that
// declares the class: their functions are kept, their decisions are not.
//
// Await points are counted on their statement (`awaits`), not decisions. Function declarations are
// hoisted, so they are listed on their parent function (`nested`), not as statements.
//
// Offsets are `node.getStart(sf)` (the first token, no leading trivia) and `node.end`, in UTF-16
// code units like V8's coverage offsets. A function's `starts` lists every offset V8 may report as
// its range start: the first token, and the first JS token after TS-only modifiers (`static`,
// `public`, decorators, `export`...), which V8 skips.
//
// Caps: MAX_NODES nodes per function (the rest of a block folds into one `fold` node, from the
// statement that hit it), MAX_DEPTH nested expressions / statements (likewise), and a time budget
// per file (past it every remaining block folds); a file over MAX_TEXT is not parsed. A file that
// still overflows the stack has no functions (`truncated`).

export const CFG_VERSION = 1;

/** Nodes per function before the rest folds. */
export const MAX_NODES = 2000;
/** Wall-time budget for one file, ms. */
export const MAX_FILE_MS = 250;
/** Characters: a larger file is not parsed (`truncated`, no functions). */
export const MAX_TEXT = 2_000_000;
/** Label length (source text, whitespace collapsed). */
export const MAX_LABEL = 60;
/** Callee names kept per statement. */
const MAX_CALLS = 8;
/** Nesting (expressions and statements) before the statement folds. */
export const MAX_DEPTH = 300;
/** Nodes the side-effect check visits before it assumes one. */
const MAX_EFFECT_VISITS = 200;

export interface CfgSpan {
  /** First token (getStart). */
  start: number;
  end: number;
  /** 1-based. */
  line: number;
  endLine: number;
}

export interface CfgExprArm {
  label: string;
  /** Where V8's counter for this arm sits (the arm's first token; its range may start a little earlier). */
  start: number;
  line: number;
  exprs: CfgExpr[];
}

export interface CfgExpr extends CfgSpan {
  id: number;
  k: "cond" | "logical";
  op: "?:" | "&&" | "||" | "??" | "&&=" | "||=" | "??=";
  label: string;
  /** cond: [true, false]. logical: [right] (the short-circuit is implied). */
  arms: CfgExprArm[];
  /** A decision worth showing (always for cond; see the header for logical). */
  shown: boolean;
  /** In code its statement may skip (see the header): reached as often as its arms say, at most. */
  guarded?: boolean;
}

interface NodeBase extends CfgSpan {
  id: number;
  /** Labels on this statement (`outer: for (...)`). */
  labels?: string[];
}

export interface CfgBlock extends NodeBase {
  k: "block";
  body: CfgNode[];
}

export interface CfgStmt extends NodeBase {
  k: "stmt";
  label: string;
  exprs: CfgExpr[];
  awaits: number;
  calls: string[];
  /** Nested functions created here (callbacks, class members): ids into CfgFile.functions. */
  fns: number[];
}

export interface CfgArm {
  label: string;
  start: number;
  line: number;
  /** The else-if test evaluated before this arm (arms after the first of a flattened chain). */
  test?: string;
  testExprs?: CfgExpr[];
  body: CfgNode;
}

export interface CfgIf extends NodeBase {
  k: "if";
  label: string;
  exprs: CfgExpr[];
  /** then, else-if..., else. No final else arm: it is implied. */
  arms: CfgArm[];
  hasElse: boolean;
  awaits: number;
  calls: string[];
  fns: number[];
}

export interface CfgCase {
  label: string;
  start: number;
  line: number;
  isDefault: boolean;
  exprs: CfgExpr[];
  body: CfgNode[];
}

export interface CfgSwitch extends NodeBase {
  k: "switch";
  label: string;
  exprs: CfgExpr[];
  cases: CfgCase[];
  awaits: number;
  calls: string[];
  fns: number[];
}

export interface CfgLoop extends NodeBase {
  k: "loop";
  loop: "for" | "for-of" | "for-in" | "for-await" | "while" | "do";
  label: string;
  /** The body's first token (V8's per-pass counter). */
  bodyStart: number;
  body: CfgNode;
  /** Decisions in the head (condition, incrementor, iterable). */
  exprs: CfgExpr[];
  awaits: number;
  calls: string[];
  fns: number[];
}

export interface CfgTry extends NodeBase {
  k: "try";
  block: CfgBlock;
  catch?: { start: number; line: number; body: CfgBlock };
  finally?: { start: number; line: number; body: CfgBlock };
}

export interface CfgExit extends NodeBase {
  k: "exit";
  kind: "return" | "throw" | "break" | "continue";
  /** break / continue target. */
  target?: string;
  label: string;
  exprs: CfgExpr[];
  awaits: number;
  calls: string[];
  fns: number[];
}

/** Statements past a cap, folded: the truth model reports them as unknown 'too-large'. */
export interface CfgFold extends NodeBase {
  k: "fold";
  /** Statements folded (direct children of the block). */
  count: number;
}

export type CfgNode = CfgBlock | CfgStmt | CfgIf | CfgSwitch | CfgLoop | CfgTry | CfgExit | CfgFold;

export interface CfgFunction extends CfgSpan {
  id: number;
  /** Declared or inferred name ("" when anonymous). */
  name: string;
  kind: "function" | "arrow" | "method" | "getter" | "setter" | "constructor";
  async: boolean;
  generator: boolean;
  /** Offsets V8 may report as the function's range start (see the header). */
  starts: number[];
  /** Enclosing function id. */
  parent?: number;
  /** Functions not created by a statement: hoisted declarations, parameter defaults. */
  nested: number[];
  /**
   * A parameter has a default or a binding pattern: code that runs (and can throw) between V8's
   * function counter and the body.
   */
  paramInit?: boolean;
  body: CfgBlock;
  /** Nodes and expression decisions in this function (nested functions not included). */
  nodeCount: number;
  truncated?: boolean;
}

export interface CfgFile {
  v: typeof CFG_VERSION;
  functions: CfgFunction[];
  /** Parse + build wall time, ms. */
  ms: number;
  /** A cap was hit: some blocks folded (or the file was too large to parse). */
  truncated?: boolean;
  /** The parse reported syntax errors (the tree is TypeScript's best effort). */
  syntaxErrors?: boolean;
}

export interface CfgOptions {
  maxNodes?: number;
  maxMs?: number;
  now?: () => number;
}

/** Collapse whitespace and clip to MAX_LABEL characters. */
export function clipLabel(text: string, max = MAX_LABEL): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

const cache = new Map<string, { text: string; cfg: CfgFile }>();
const CACHE_MAX = 64;

/**
 * Build the control-flow model of every function in `text`. Cached by file name + text (a hit is
 * a string compare). Undefined without a usable TypeScript.
 */
export function buildCfg(ts: any, text: string, fileName: string, opts: CfgOptions = {}): CfgFile | undefined {
  if (!ts || typeof ts.createSourceFile !== "function") return undefined;
  const hit = cache.get(fileName);
  if (hit && hit.text === text && !opts.maxNodes && !opts.maxMs) return hit.cfg;
  const cfg = build(ts, text, fileName, opts);
  if (!opts.maxNodes && !opts.maxMs) {
    cache.delete(fileName);
    cache.set(fileName, { text, cfg });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return cfg;
}

function scriptKind(ts: any, fileName: string): number {
  const ext = fileName.toLowerCase().match(/\.[^./\\]+$/)?.[0] ?? "";
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function build(ts: any, text: string, fileName: string, opts: CfgOptions): CfgFile {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const deadline = t0 + (opts.maxMs ?? MAX_FILE_MS);
  const out: CfgFile = { v: CFG_VERSION, functions: [], ms: 0 };
  if (text.length > MAX_TEXT) {
    out.truncated = true;
    out.ms = now() - t0;
    return out;
  }
  try {
    buildInto(ts, text, fileName, out, now, maxNodes, deadline);
  } catch (err) {
    // Past every cap the walk still overflowed the stack (nesting TypeScript parsed but no model
    // should hold): no functions, rather than a half-built one.
    if (!(err instanceof RangeError)) throw err;
    out.functions = [];
    out.truncated = true;
  }
  out.ms = now() - t0;
  return out;
}

function buildInto(
  ts: any,
  text: string,
  fileName: string,
  out: CfgFile,
  now: () => number,
  maxNodes: number,
  deadline: number,
): void {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind(ts, fileName));
  if ((sf.parseDiagnostics?.length ?? 0) > 0) out.syntaxErrors = true;
  const K = ts.SyntaxKind;
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const startOf = (n: any) => n.getStart(sf);
  /** A clipped label of [start, end): reads at most what the label can show (long chains stay linear). */
  const labelOf = (start: number, end: number, max = MAX_LABEL, suffix = ""): string => {
    const cut = start + max * 4;
    const t = clipLabel(text.slice(start, Math.min(end, cut)) + suffix, max);
    return end > cut && !t.endsWith("...") ? `${t.slice(0, max - 3)}...` : t;
  };
  const labelOfNode = (n: any, max = MAX_LABEL) => labelOf(startOf(n), n.end, max);
  const span = (n: any): CfgSpan => {
    const start = startOf(n);
    return { start, end: n.end, line: lineOf(start), endLine: lineOf(Math.max(start, n.end - 1)) };
  };
  let timedOut = false;
  let ticks = 0;
  const overTime = () => {
    if (timedOut) return true;
    if (++ticks % 64 === 0 && now() > deadline) timedOut = true;
    return timedOut;
  };

  /** Per-function build state. */
  interface FnState {
    fn: CfgFunction;
    nextId: number;
    /** A cap (nodes, depth, time) was hit: the statement being built folds, and the rest. */
    capped?: boolean;
  }
  /** Current nesting of scanNode / statement (shared across functions: it is the stack). */
  let depth = 0;
  const overCap = (st: FnState): boolean => {
    if (!st.capped && (st.nextId >= maxNodes || depth > MAX_DEPTH || overTime())) st.capped = true;
    return !!st.capped;
  };

  const TS_ONLY_MODIFIERS = new Set([
    K.ExportKeyword,
    K.DefaultKeyword,
    K.DeclareKeyword,
    K.StaticKeyword,
    K.PublicKeyword,
    K.PrivateKeyword,
    K.ProtectedKeyword,
    K.ReadonlyKeyword,
    K.OverrideKeyword,
    K.AbstractKeyword,
    K.AccessorKeyword,
  ]);

  const isFunctionLike = (n: any): boolean =>
    n.kind === K.FunctionDeclaration ||
    n.kind === K.FunctionExpression ||
    n.kind === K.ArrowFunction ||
    n.kind === K.MethodDeclaration ||
    n.kind === K.GetAccessor ||
    n.kind === K.SetAccessor ||
    n.kind === K.Constructor;

  const nameText = (n: any): string => {
    if (!n) return "";
    if (n.kind === K.Identifier || n.kind === K.PrivateIdentifier) return n.text;
    if (n.kind === K.StringLiteral || n.kind === K.NumericLiteral) return n.text;
    return labelOfNode(n, 40);
  };

  /** Offsets V8 may report as the start of function `n`. */
  const fnStarts = (n: any): number[] => {
    const first = startOf(n);
    const starts = [first];
    const mods: any[] = n.modifiers ? Array.from(n.modifiers) : [];
    let i = 0;
    while (i < mods.length && (mods[i].kind === K.Decorator || TS_ONLY_MODIFIERS.has(mods[i].kind))) i++;
    let js: number | undefined;
    if (i < mods.length) js = startOf(mods[i]);
    else if (mods.length) {
      // Every modifier is TS-only: the next token is `function`, `*`, `get`/`set`, or the name.
      js = ts.skipTrivia(text, mods[mods.length - 1].end) as number;
    }
    if (js !== undefined && js !== first) starts.push(js);
    return starts;
  };

  const fnKind = (n: any): CfgFunction["kind"] => {
    switch (n.kind) {
      case K.ArrowFunction:
        return "arrow";
      case K.MethodDeclaration:
        return "method";
      case K.GetAccessor:
        return "getter";
      case K.SetAccessor:
        return "setter";
      case K.Constructor:
        return "constructor";
      default:
        return "function";
    }
  };

  const hasModifier = (n: any, kind: number) => !!n.modifiers?.some((m: any) => m.kind === kind);

  /** Register function `n` (and everything inside it). Returns its id. */
  const addFunction = (n: any, inferred: string, parent?: number): number => {
    const id = out.functions.length;
    let name = n.name ? nameText(n.name) : inferred;
    if (n.kind === K.GetAccessor) name = `get ${name}`;
    else if (n.kind === K.SetAccessor) name = `set ${name}`;
    else if (n.kind === K.Constructor) name = inferred || "constructor";
    const fn: CfgFunction = {
      id,
      name,
      kind: fnKind(n),
      async: hasModifier(n, K.AsyncKeyword),
      generator: !!n.asteriskToken,
      ...span(n),
      starts: fnStarts(n),
      nested: [],
      body: undefined as unknown as CfgBlock,
      nodeCount: 0,
    };
    if (parent !== undefined) fn.parent = parent;
    out.functions.push(fn);
    const st: FnState = { fn, nextId: 0 };
    // Parameter defaults and patterns run before the body, only sometimes: their functions are
    // this function's own; their decisions are not modelled (no statement holds them).
    const params: any[] = n.parameters ? Array.from(n.parameters) : [];
    if (params.some((p) => p.initializer || (p.name && p.name.kind !== K.Identifier))) fn.paramInit = true;
    for (const p of params) {
      const scratch: Scan = { exprs: [], awaits: 0, calls: [], fns: [] };
      scanNode(st, p.name, scratch, scratch.exprs, p, false, true);
      scanNode(st, p.initializer, scratch, scratch.exprs, p, false, true);
      fn.nested.push(...scratch.fns);
    }
    st.capped = false;
    if (n.body && n.body.kind === K.Block) {
      fn.body = block(st, n.body);
    } else if (n.body) {
      // Concise arrow body: one implicit return of the expression.
      const id = st.nextId++;
      const scan = scanInto(st, n.body, true);
      if (st.capped) {
        fn.body = { id: st.nextId++, k: "block", ...span(n.body), body: [foldOf(st, [n.body])!] };
      } else {
        const exit: CfgExit = {
          id,
          k: "exit",
          kind: "return",
          label: labelOfNode(n.body),
          ...span(n.body),
          ...scan,
        };
        fn.body = { id: st.nextId++, k: "block", ...span(n.body), body: [exit] };
      }
    } else {
      fn.body = { id: st.nextId++, k: "block", ...span(n), body: [] };
    }
    fn.nodeCount = st.nextId;
    return id;
  };

  /** What scanning an expression collects for its statement. */
  interface Scan {
    exprs: CfgExpr[];
    awaits: number;
    calls: string[];
    fns: number[];
  }

  const sideEffects = (n: any): boolean => {
    let found = false;
    let visits = 0;
    const visit = (x: any) => {
      if (found) return;
      if (++visits > MAX_EFFECT_VISITS) {
        // Too big to tell cheaply: say it has one (shown is a display choice, never a count).
        found = true;
        return;
      }
      if (isFunctionLike(x) || x.kind === K.ClassExpression) return;
      switch (x.kind) {
        case K.CallExpression:
        case K.NewExpression:
        case K.TaggedTemplateExpression:
        case K.AwaitExpression:
        case K.YieldExpression:
        case K.DeleteExpression:
          found = true;
          return;
        case K.PrefixUnaryExpression:
        case K.PostfixUnaryExpression:
          if (x.operator === K.PlusPlusToken || x.operator === K.MinusMinusToken) {
            found = true;
            return;
          }
          break;
        case K.BinaryExpression: {
          const op = x.operatorToken.kind;
          if (op >= K.FirstAssignment && op <= K.LastAssignment) {
            found = true;
            return;
          }
          break;
        }
      }
      ts.forEachChild(x, visit);
    };
    visit(n);
    return found;
  };

  const LOGICAL: Record<number, CfgExpr["op"]> = {
    [K.AmpersandAmpersandToken]: "&&",
    [K.BarBarToken]: "||",
    [K.QuestionQuestionToken]: "??",
    [K.AmpersandAmpersandEqualsToken]: "&&=",
    [K.BarBarEqualsToken]: "||=",
    [K.QuestionQuestionEqualsToken]: "??=",
  };

  const unparen = (n: any): any => {
    while (
      n &&
      (n.kind === K.ParenthesizedExpression ||
        n.kind === K.AsExpression ||
        n.kind === K.NonNullExpression ||
        n.kind === K.SatisfiesExpression ||
        n.kind === K.TypeAssertionExpression)
    )
      n = n.expression;
    return n;
  };

  const calleeName = (expr: any): string => {
    const e = unparen(expr);
    if (!e) return "";
    if (e.kind === K.Identifier) return e.text;
    return labelOfNode(e, 40);
  };

  /** Name a function expression takes from where it sits (`const f = () => ...`, `{ f: ... }`). */
  const nameFromContext = (parentNode: any): string => {
    if (!parentNode) return "";
    switch (parentNode.kind) {
      case K.VariableDeclaration:
      case K.PropertyAssignment:
      case K.PropertyDeclaration:
        return parentNode.name ? nameText(parentNode.name) : "";
      case K.BinaryExpression:
        return parentNode.operatorToken.kind === K.EqualsToken ? labelOfNode(parentNode.left, 40) : "";
      default:
        return "";
    }
  };

  /**
   * Scan an expression (or any non-statement node) for decisions, calls, awaits and nested
   * functions. `exitValue`: the expression is what a return / throw hands back.
   */
  function scanInto(st: FnState, node: any, exitValue = false): Scan {
    const acc: Scan = { exprs: [], awaits: 0, calls: [], fns: [] };
    scanNode(st, node, acc, acc.exprs, undefined, exitValue);
    return acc;
  }

  function scanNode(
    st: FnState,
    n: any,
    acc: Scan,
    exprs: CfgExpr[],
    parentNode: any,
    exitValue = false,
    guard = false,
  ): void {
    if (!n || overCap(st)) return;
    depth++;
    try {
      scanOne(st, n, acc, exprs, parentNode, exitValue, guard);
    } finally {
      depth--;
    }
  }

  function scanOne(
    st: FnState,
    n: any,
    acc: Scan,
    exprs: CfgExpr[],
    parentNode: any,
    exitValue: boolean,
    guard: boolean,
  ): void {
    if (isFunctionLike(n)) {
      acc.fns.push(addFunction(n, nameFromContext(parentNode), st.fn.id));
      return;
    }
    if (n.kind === K.ClassExpression || n.kind === K.ClassDeclaration) {
      scanClass(st, n, acc, exprs, guard);
      return;
    }
    if (n.kind === K.ConditionalExpression) {
      scanNode(st, n.condition, acc, exprs, n, false, guard);
      const e: CfgExpr = {
        id: st.nextId++,
        k: "cond",
        op: "?:",
        label: labelOfNode(n.condition),
        ...span(n),
        shown: true,
        arms: [
          { label: "true", start: startOf(n.whenTrue), line: lineOf(startOf(n.whenTrue)), exprs: [] },
          { label: "false", start: startOf(n.whenFalse), line: lineOf(startOf(n.whenFalse)), exprs: [] },
        ],
      };
      if (guard) e.guarded = true;
      exprs.push(e);
      // An arm's own counter says how often it ran: what is inside it is relative to that.
      scanNode(st, n.whenTrue, acc, e.arms[0]!.exprs, n, exitValue);
      scanNode(st, n.whenFalse, acc, e.arms[1]!.exprs, n, exitValue);
      return;
    }
    if (n.kind === K.BinaryExpression && LOGICAL[n.operatorToken.kind]) {
      const op = LOGICAL[n.operatorToken.kind]!;
      scanNode(st, n.left, acc, exprs, n, false, guard);
      const right = n.right;
      // `&&=` / `||=` / `??=`: no counter for the right side (see the header).
      const assign = op.endsWith("=");
      const e: CfgExpr = {
        id: st.nextId++,
        k: "logical",
        op,
        label: labelOf(startOf(n.left), n.left.end, MAX_LABEL, ` ${op}`),
        ...span(n),
        shown: !assign && (exitValue || sideEffects(right)),
        arms: [{ label: "right", start: startOf(right), line: lineOf(startOf(right)), exprs: [] }],
      };
      if (guard) e.guarded = true;
      exprs.push(e);
      scanNode(st, right, acc, e.arms[0]!.exprs, n, exitValue, assign);
      return;
    }
    if (ts.isOptionalChain(n)) {
      scanChain(st, n, acc, exprs, guard);
      return;
    }
    switch (n.kind) {
      case K.CallExpression:
      case K.NewExpression:
        noteCall(acc, n);
        break;
      case K.AwaitExpression:
        acc.awaits++;
        break;
      case K.ParenthesizedExpression:
        scanNode(st, n.expression, acc, exprs, n, exitValue, guard);
        return;
      case K.BindingElement:
        // `{ a = d }` / `[x = d]`: the default runs only when the value is undefined.
        scanNode(st, n.propertyName, acc, exprs, n, false, guard);
        scanNode(st, n.name, acc, exprs, n, false, guard);
        scanNode(st, n.initializer, acc, exprs, n, false, true);
        return;
      case K.VariableDeclaration:
        // Evaluation order: the value, then the binding (its defaults guarded).
        scanNode(st, n.initializer, acc, exprs, n, false, guard);
        scanNode(st, n.name, acc, exprs, n, false, guard);
        return;
      case K.ShorthandPropertyAssignment:
        scanNode(st, n.objectAssignmentInitializer, acc, exprs, n, false, true);
        return;
      case K.BinaryExpression:
        if (
          n.operatorToken.kind === K.EqualsToken &&
          (n.left.kind === K.ObjectLiteralExpression || n.left.kind === K.ArrayLiteralExpression)
        ) {
          // Destructuring assignment: the right side first, then the pattern (its defaults sometimes).
          scanNode(st, n.right, acc, exprs, n, false, guard);
          scanPattern(st, n.left, acc, exprs, guard);
          return;
        }
        break;
    }
    ts.forEachChild(n, (c: any) => scanNode(st, c, acc, exprs, n, false, guard));
  }

  function noteCall(acc: Scan, n: any): void {
    if (acc.calls.length >= MAX_CALLS) return;
    const c = calleeName(n.expression);
    if (c && !acc.calls.includes(c)) acc.calls.push(c);
  }

  /**
   * A node of an optional chain (`a?.b(x).c[y]`): what follows the first `?.` is skipped when the
   * head is nullish, and V8 keeps no counter for that, so its decisions are guarded.
   */
  function scanChain(st: FnState, n: any, acc: Scan, exprs: CfgExpr[], guard: boolean): void {
    if (overCap(st)) return;
    depth++;
    try {
      // Evaluation order: the head (before the first `?.`, always runs), then the guarded tail.
      const inner = n.expression;
      if (!n.questionDotToken && inner && ts.isOptionalChain(inner)) scanChain(st, inner, acc, exprs, guard);
      else scanNode(st, inner, acc, exprs, n, false, guard);
      if (n.kind === K.CallExpression) {
        noteCall(acc, n);
        for (const a of n.arguments ?? []) scanNode(st, a, acc, exprs, n, false, true);
      } else if (n.kind === K.ElementAccessExpression) {
        scanNode(st, n.argumentExpression, acc, exprs, n, false, true);
      }
    } finally {
      depth--;
    }
  }

  /** The target side of a destructuring assignment: defaults are guarded, targets are not. */
  function scanPattern(st: FnState, p: any, acc: Scan, exprs: CfgExpr[], guard: boolean): void {
    if (!p || overCap(st)) return;
    depth++;
    try {
      switch (p.kind) {
        case K.ObjectLiteralExpression:
          for (const prop of p.properties ?? []) {
            if (prop.kind === K.ShorthandPropertyAssignment)
              scanNode(st, prop.objectAssignmentInitializer, acc, exprs, prop, false, true);
            else if (prop.kind === K.PropertyAssignment) {
              scanNode(st, prop.name, acc, exprs, prop, false, guard);
              scanPattern(st, prop.initializer, acc, exprs, guard);
            } else if (prop.kind === K.SpreadAssignment) scanPattern(st, prop.expression, acc, exprs, guard);
            else scanNode(st, prop, acc, exprs, p, false, guard);
          }
          return;
        case K.ArrayLiteralExpression:
          for (const el of p.elements ?? []) {
            if (el.kind === K.SpreadElement) scanPattern(st, el.expression, acc, exprs, guard);
            else if (el.kind !== K.OmittedExpression) scanPattern(st, el, acc, exprs, guard);
          }
          return;
        case K.BinaryExpression:
          if (p.operatorToken.kind === K.EqualsToken) {
            scanPattern(st, p.left, acc, exprs, guard);
            scanNode(st, p.right, acc, exprs, p, false, true);
            return;
          }
          break;
      }
      scanNode(st, p, acc, exprs, undefined, false, guard);
    } finally {
      depth--;
    }
  }

  function scanClass(st: FnState, n: any, acc: Scan, exprs: CfgExpr[], guard: boolean): void {
    const cls = n.name ? nameText(n.name) : "";
    for (const m of n.members ?? []) {
      if (isFunctionLike(m) && m.body) {
        acc.fns.push(addFunction(m, m.kind === K.Constructor ? cls : "", st.fn.id));
      } else if (m.kind === K.PropertyDeclaration && m.initializer) {
        // Field initializers run per instance in V8's synthetic initializer function: their
        // functions are functions of their own, their decisions are not this statement's.
        const scratch: Scan = { exprs: [], awaits: 0, calls: [], fns: [] };
        scanNode(st, m.initializer, scratch, scratch.exprs, m);
        acc.fns.push(...scratch.fns);
      } else if (m.kind === K.ClassStaticBlockDeclaration) {
        // Runs in V8's synthetic static initializer: only its functions belong to the model.
        ts.forEachChild(m, (c: any) => visitTop(c, m, st.fn.id, acc.fns));
      }
    }
    if (n.heritageClauses) for (const h of n.heritageClauses) scanNode(st, h, acc, exprs, n, false, guard);
  }

  const isTypeOnly = (s: any): boolean => {
    switch (s.kind) {
      case K.InterfaceDeclaration:
      case K.TypeAliasDeclaration:
      case K.EmptyStatement:
        return true;
      case K.ModuleDeclaration:
      case K.EnumDeclaration:
      case K.VariableStatement:
      case K.FunctionDeclaration:
      case K.ClassDeclaration:
        return hasModifier(s, K.DeclareKeyword) || (s.kind === K.EnumDeclaration && hasModifier(s, K.ConstKeyword));
      case K.ImportDeclaration:
        return !!s.importClause?.isTypeOnly;
      case K.ExportDeclaration:
        return !!s.isTypeOnly;
      case K.ImportEqualsDeclaration:
        return !!s.isTypeOnly;
      default:
        return false;
    }
  };

  function block(st: FnState, b: any): CfgBlock {
    return { id: st.nextId++, k: "block", ...span(b), body: statements(st, b.statements ?? []) };
  }

  /** One `fold` node for `rest` (statements past a cap), or none when nothing in it runs. */
  function foldOf(st: FnState, rest: readonly any[]): CfgFold | undefined {
    const run = rest.filter((x) => !isTypeOnly(x) && x.kind !== K.FunctionDeclaration);
    if (!run.length) return undefined;
    const first = run[0];
    const last = run[run.length - 1];
    const start = startOf(first);
    st.fn.truncated = true;
    out.truncated = true;
    return {
      id: st.nextId++,
      k: "fold",
      start,
      end: last.end,
      line: lineOf(start),
      endLine: lineOf(Math.max(start, last.end - 1)),
      count: run.length,
    };
  }

  /** A statement list, folding what is past a cap (from the statement that hit it). */
  function statements(st: FnState, list: readonly any[]): CfgNode[] {
    const outList: CfgNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      let node: CfgNode | undefined;
      if (!overCap(st)) {
        depth++;
        try {
          node = statement(st, s);
        } finally {
          depth--;
        }
      }
      if (st.capped) {
        const fold = foldOf(st, list.slice(i));
        if (fold) outList.push(fold);
        // Hoisted declarations past the cap still get their own functions (cheap: no walk past
        // caps). The one being built when the cap hit already has one.
        const have = new Set(st.fn.nested.map((id) => out.functions[id]?.start));
        for (const r of list.slice(i))
          if (r.kind === K.FunctionDeclaration && r.body && !have.has(startOf(r)))
            st.fn.nested.push(addFunction(r, "", st.fn.id));
        break;
      }
      if (node) outList.push(node);
    }
    return outList;
  }

  function statement(st: FnState, s: any, labels?: string[]): CfgNode | undefined {
    if (isTypeOnly(s)) return undefined;
    const withLabels = <T extends CfgNode>(node: T): T => {
      if (labels?.length) node.labels = labels;
      return node;
    };
    switch (s.kind) {
      case K.LabeledStatement: {
        const inner = statement(st, s.statement, [...(labels ?? []), s.label.text]);
        return inner;
      }
      case K.FunctionDeclaration:
        if (s.body) st.fn.nested.push(addFunction(s, "", st.fn.id));
        return undefined;
      case K.Block:
        return withLabels(block(st, s));
      case K.IfStatement:
        return withLabels(ifNode(st, s));
      case K.SwitchStatement:
        return withLabels(switchNode(st, s));
      case K.ForStatement:
      case K.ForOfStatement:
      case K.ForInStatement:
      case K.WhileStatement:
      case K.DoStatement:
        return withLabels(loopNode(st, s));
      case K.TryStatement:
        return withLabels(tryNode(st, s));
      case K.ReturnStatement:
      case K.ThrowStatement: {
        const scan = s.expression ? scanInto(st, s.expression, true) : { exprs: [], awaits: 0, calls: [], fns: [] };
        return withLabels({
          id: st.nextId++,
          k: "exit",
          kind: s.kind === K.ReturnStatement ? "return" : "throw",
          label: labelOfNode(s),
          ...span(s),
          ...scan,
        });
      }
      case K.BreakStatement:
      case K.ContinueStatement: {
        const exit: CfgExit = {
          id: st.nextId++,
          k: "exit",
          kind: s.kind === K.BreakStatement ? "break" : "continue",
          label: labelOfNode(s),
          ...span(s),
          exprs: [],
          awaits: 0,
          calls: [],
          fns: [],
        };
        if (s.label) exit.target = s.label.text;
        return withLabels(exit);
      }
      case K.WithStatement: {
        // Sloppy-mode `with (o) body`: the body runs once per `with`, as a block. `o` is scanned
        // for its functions only.
        st.fn.nested.push(...scanInto(st, s.expression).fns);
        return withLabels(armBody(st, s.statement));
      }
      default: {
        const id = st.nextId++;
        const scan = scanInto(st, s);
        return withLabels({ id, k: "stmt", label: labelOfNode(s), ...span(s), ...scan });
      }
    }
  }

  function ifNode(st: FnState, s: any): CfgIf {
    const id = st.nextId++;
    const head = scanInto(st, s.expression);
    const node: CfgIf = {
      id,
      k: "if",
      label: labelOfNode(s.expression),
      ...span(s),
      exprs: head.exprs,
      arms: [],
      hasElse: false,
      awaits: head.awaits,
      calls: head.calls,
      fns: head.fns,
    };
    node.arms.push({
      label: "then",
      start: startOf(s.thenStatement),
      line: lineOf(startOf(s.thenStatement)),
      body: armBody(st, s.thenStatement),
    });
    // Flatten `else if` chains into one decision.
    let e = s.elseStatement;
    while (e) {
      if (e.kind === K.IfStatement) {
        const test = scanInto(st, e.expression);
        node.awaits += test.awaits;
        for (const c of test.calls) if (node.calls.length < MAX_CALLS && !node.calls.includes(c)) node.calls.push(c);
        node.fns.push(...test.fns);
        node.arms.push({
          label: `else if ${labelOfNode(e.expression, MAX_LABEL - 8)}`,
          start: startOf(e.thenStatement),
          line: lineOf(startOf(e.thenStatement)),
          test: labelOfNode(e.expression),
          testExprs: test.exprs,
          body: armBody(st, e.thenStatement),
        });
        e = e.elseStatement;
      } else {
        node.arms.push({ label: "else", start: startOf(e), line: lineOf(startOf(e)), body: armBody(st, e) });
        node.hasElse = true;
        e = undefined;
      }
    }
    return node;
  }

  /** An arm's body as a block (a single statement becomes a one-statement block at its own span). */
  function armBody(st: FnState, s: any): CfgNode {
    if (s.kind === K.Block) return block(st, s);
    const inner = statement(st, s);
    return { id: st.nextId++, k: "block", ...span(s), body: inner ? [inner] : [] };
  }

  function switchNode(st: FnState, s: any): CfgSwitch {
    const id = st.nextId++;
    const head = scanInto(st, s.expression);
    const node: CfgSwitch = {
      id,
      k: "switch",
      label: labelOfNode(s.expression),
      ...span(s),
      exprs: head.exprs,
      cases: [],
      awaits: head.awaits,
      calls: head.calls,
      fns: head.fns,
    };
    for (const c of s.caseBlock.clauses) {
      const isDefault = c.kind === K.DefaultClause;
      const test = isDefault ? { exprs: [] as CfgExpr[] } : scanInto(st, c.expression);
      node.cases.push({
        label: isDefault ? "default" : `case ${labelOfNode(c.expression, MAX_LABEL - 5)}`,
        start: startOf(c),
        line: lineOf(startOf(c)),
        isDefault,
        exprs: test.exprs,
        body: statements(st, c.statements ?? []),
      });
    }
    return node;
  }

  function loopNode(st: FnState, s: any): CfgLoop {
    const id = st.nextId++;
    const acc: Scan = { exprs: [], awaits: 0, calls: [], fns: [] };
    let loop: CfgLoop["loop"];
    switch (s.kind) {
      case K.ForStatement:
        loop = "for";
        scanNode(st, s.initializer, acc, acc.exprs, s);
        scanNode(st, s.condition, acc, acc.exprs, s);
        scanNode(st, s.incrementor, acc, acc.exprs, s);
        break;
      case K.ForOfStatement:
      case K.ForInStatement:
        loop = s.kind === K.ForInStatement ? "for-in" : s.awaitModifier ? "for-await" : "for-of";
        scanNode(st, s.expression, acc, acc.exprs, s);
        // The binding runs once per pass, not per entry: guarded.
        if (s.initializer?.kind === K.ObjectLiteralExpression || s.initializer?.kind === K.ArrayLiteralExpression)
          scanPattern(st, s.initializer, acc, acc.exprs, true);
        else scanNode(st, s.initializer, acc, acc.exprs, s, false, true);
        break;
      case K.WhileStatement:
        loop = "while";
        scanNode(st, s.expression, acc, acc.exprs, s);
        break;
      default:
        loop = "do";
        scanNode(st, s.expression, acc, acc.exprs, s);
        break;
    }
    const bodyStart = startOf(s.statement);
    const label =
      loop === "do"
        ? clipLabel(`do ... while (${labelOfNode(s.expression)})`)
        : labelOf(startOf(s), bodyStart)
            .replace(/\{\s*$/, "")
            .trim();
    return {
      id,
      k: "loop",
      loop,
      label,
      ...span(s),
      bodyStart,
      body: armBody(st, s.statement),
      exprs: acc.exprs,
      awaits: acc.awaits + (loop === "for-await" ? 1 : 0),
      calls: acc.calls,
      fns: acc.fns,
    };
  }

  function tryNode(st: FnState, s: any): CfgTry {
    const id = st.nextId++;
    const node: CfgTry = { id, k: "try", ...span(s), block: block(st, s.tryBlock) };
    if (s.catchClause) {
      const c = s.catchClause;
      node.catch = { start: startOf(c), line: lineOf(startOf(c)), body: block(st, c.block) };
    }
    if (s.finallyBlock) {
      const f = s.finallyBlock;
      node.finally = { start: startOf(f), line: lineOf(startOf(f)), body: block(st, f) };
    }
    return node;
  }

  /**
   * Find functions in code that is not modelled (the module's top level, class static blocks):
   * `parent` / `into` link them to the function whose code holds them.
   */
  function visitTop(n: any, parentNode: any, parent?: number, into?: number[]): void {
    if (isFunctionLike(n)) {
      if (n.body) {
        // Not `into?.push(addFunction(..))`: a short-circuited optional call skips its arguments.
        const id = addFunction(n, nameFromContext(parentNode), parent);
        if (into) into.push(id);
      }
      return;
    }
    if (n.kind === K.ClassDeclaration || n.kind === K.ClassExpression) {
      const cls = n.name ? nameText(n.name) : "";
      for (const m of n.members ?? []) {
        if (isFunctionLike(m)) {
          if (m.body) {
            const id = addFunction(m, m.kind === K.Constructor ? cls : "", parent);
            if (into) into.push(id);
          }
        } else ts.forEachChild(m, (c: any) => visitTop(c, m, parent, into));
      }
      return;
    }
    ts.forEachChild(n, (c: any) => visitTop(c, n, parent, into));
  }
  visitTop(sf, undefined);
  if (timedOut) out.truncated = true;
}

/** Every node of a function, depth first in source order (expression decisions included). */
export function walkCfg(fn: CfgFunction, visit: (n: CfgNode | CfgExpr, depth: number) => void): void {
  const exprs = (list: CfgExpr[] | undefined, d: number) => {
    for (const e of list ?? []) {
      visit(e, d);
      for (const a of e.arms) exprs(a.exprs, d + 1);
    }
  };
  const node = (n: CfgNode, d: number): void => {
    visit(n, d);
    switch (n.k) {
      case "block":
        for (const c of n.body) node(c, d + 1);
        break;
      case "stmt":
      case "exit":
        exprs(n.exprs, d + 1);
        break;
      case "if":
        exprs(n.exprs, d + 1);
        for (const a of n.arms) {
          exprs(a.testExprs, d + 1);
          node(a.body, d + 1);
        }
        break;
      case "switch":
        exprs(n.exprs, d + 1);
        for (const c of n.cases) {
          exprs(c.exprs, d + 1);
          for (const s of c.body) node(s, d + 1);
        }
        break;
      case "loop":
        exprs(n.exprs, d + 1);
        node(n.body, d + 1);
        break;
      case "try":
        node(n.block, d + 1);
        if (n.catch) node(n.catch.body, d + 1);
        if (n.finally) node(n.finally.body, d + 1);
        break;
      case "fold":
        break;
    }
  };
  node(fn.body, 0);
}
