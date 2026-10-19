// The control-flow model the request path's truth model reads (path/truth.ts): the contract of
// `@hoplens/transform/cfg` buildCfg(). Core has no runtime TypeScript, so the model is built in
// transform and handed in through RuntimeConfig.path.analyzer; these types are a copy of the ones
// in packages/transform/src/cfg.ts, kept identical: packages/express/src/analyzer.ts fails to
// typecheck when they differ. See that file for what each node means.

export const CFG_VERSION = 1;

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
