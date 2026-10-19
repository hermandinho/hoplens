// Request path, layer 3c: the per-function truth of a captured payload, built lazily (on the POST
// that captured it, else on the first GET) and cached on the payload (plan P2).
//
// For each joined function: read the file as it is now, check it is the text the capture saw
// (hash) and that it was not edited after the app started (mtime, recorded at capture), build its
// control-flow model with the injected analyzer (@hoplens/transform/cfg; core has no TypeScript),
// validate the join (the AST function's start and end are the coverage function's range) and run
// the truth model (truth.ts). Anything that does not hold is UNKNOWN with the reason, never counted.
//
// Then link the flowchart nodes to other functions of the payload: a function created at a node
// (callback, class member) by its AST start, which must be the payload function's range start; a
// call by name only to a function the trace recorded as a hop under this one, and only when that
// name picks exactly one of them (never a guess between two).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PathFn, PathPayload } from "./capture";
import type { CfgFile } from "./cfg-model";
import {
  type FnAnalysis,
  type PathExit,
  type PathNode,
  type TruthWhy,
  joinCfg,
  pathTruth,
  unknownAnalysis,
} from "./truth";

/** Builds the control-flow model of one file (RuntimeConfig.path.analyzer). */
export interface PathAnalyzer {
  cfg(absFile: string, text: string): CfgFile | undefined;
  /** Load what the first cfg() call would (TypeScript), ahead of time. */
  warm?(): void;
}

export interface PathVerdict {
  /** `Exited: return at GET /api/products/:id L21 via if !(await findProduct(id)) -> then`. */
  text: string;
  /** `line` null: an exception no recorded stack places. */
  exit?: { fnKey: string; nodeId?: number; kind: PathExit["kind"]; line: number | null; via?: PathExit["via"] };
}

export interface PayloadAnalysis extends PathVerdict {
  /** Wall time of the analysis, ms. */
  ms: number;
  /** Graphs dropped to keep the payload under MAX_PAYLOAD_BYTES. */
  graphsDropped?: boolean;
  error?: string;
}

export interface AnalyzeDeps {
  analyzer?: PathAnalyzer;
  root: string;
  readSource?: (abs: string) => string | undefined;
  now?: () => number;
}

/** Payload size cap (plan dataModel): past it the flowchart graphs are left out. */
export const MAX_PAYLOAD_BYTES = 512 * 1024;

const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

function readFile(abs: string): string | undefined {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

const TS_FILE = /\.[mc]?tsx?$/i;

/** Analyze every function of `p` once (no-op when it already was). Never throws. */
export function analyzePayload(p: PathPayload, deps: AnalyzeDeps): PayloadAnalysis {
  if (p.analysis) return p.analysis;
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  const read = deps.readSource ?? readFile;
  try {
    const texts = new Map<string, string | undefined>();
    const cfgs = new Map<string, CfgFile | undefined | Error>();
    for (const f of Object.values(p.functions)) {
      f.analysis = analyzeFn(f, deps, read, texts, cfgs);
    }
    linkGraphs(p, deps.root, cfgs);
    let bytes = 0;
    try {
      bytes = JSON.stringify(p).length;
    } catch {
      /* measured below as 0 */
    }
    const verdict = requestVerdict(p);
    const out: PayloadAnalysis = { ...verdict, ms: 0 };
    if (bytes > MAX_PAYLOAD_BYTES) {
      for (const f of Object.values(p.functions)) if (f.analysis) f.analysis.graph = undefined;
      out.graphsDropped = true;
      p.warnings.push(`the flowcharts were left out: the payload would be over ${MAX_PAYLOAD_BYTES / 1024}KB`);
    }
    out.ms = Math.round((now() - t0) * 10) / 10;
    p.analysis = out;
  } catch (err) {
    p.analysis = {
      text: "Exit: UNKNOWN (analysis failed)",
      ms: Math.round((now() - t0) * 10) / 10,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return p.analysis;
}

function analyzeFn(
  f: PathFn,
  deps: AnalyzeDeps,
  read: (abs: string) => string | undefined,
  texts: Map<string, string | undefined>,
  cfgs: Map<string, CfgFile | undefined | Error>,
): FnAnalysis {
  const calls = f.calls.coverage ?? 0;
  if (f.truth.t === "unknown") return unknownAnalysis(f.truth.why, calls);
  if (f.truncated) return unknownAnalysis("too-large", calls);
  if (!f.ranges.length) return unknownAnalysis("no-blocks", calls);
  if (f.mapping !== "identity") return unknownAnalysis("join-mismatch", calls);
  if (!deps.analyzer) return unknownAnalysis("no-analyzer", calls);
  const abs = path.resolve(deps.root, f.file);
  if (!texts.has(abs)) texts.set(abs, read(abs));
  const text = texts.get(abs);
  if (text === undefined) return unknownAnalysis("source-unreadable", calls);
  if (!cfgs.has(abs)) {
    try {
      cfgs.set(abs, deps.analyzer.cfg(abs, text));
    } catch (err) {
      cfgs.set(abs, err instanceof Error ? err : new Error(String(err)));
    }
  }
  const cfg = cfgs.get(abs);
  if (cfg instanceof Error) return unknownAnalysis("no-analyzer", calls);
  const ranges = f.ranges.map((r) => ({ start: r.start, end: r.end, count: r.count }));
  const j = joinCfg({
    cfg,
    ranges,
    capturedHash: f.sourceHash,
    currentHash: sha(text),
    stale: f.stale,
    typescript: TS_FILE.test(f.file),
  });
  if ("why" in j) return unknownAnalysis(j.why, calls);
  return pathTruth({ fn: j.fn, ranges, threw: f.errors?.hops ?? 0, throwLines: f.errors?.lines, file: cfg });
}

/** Fill `fns[].fnKey` and `callees` on every graph node (see the header). */
function linkGraphs(p: PathPayload, root: string, cfgs: Map<string, CfgFile | undefined | Error>): void {
  const byStart = new Map<string, string>();
  for (const f of Object.values(p.functions))
    if (f.mapping === "identity" && f.ranges[0])
      byStart.set(`${path.resolve(root, f.file)}#${f.ranges[0].start}`, f.key);
  // Hop children: lanes are in span order, a lane's parent is the nearest earlier lane one level up.
  const children = new Map<string, Set<string>>();
  const stack: Array<string | undefined> = [];
  for (const l of p.lanes) {
    stack.length = l.depth;
    const parent = stack[l.depth - 1];
    if (parent && l.fnKey) {
      let set = children.get(parent);
      if (!set) children.set(parent, (set = new Set()));
      set.add(l.fnKey);
    }
    stack[l.depth] = l.fnKey;
  }
  for (const f of Object.values(p.functions)) {
    const graph = f.analysis?.graph;
    if (!graph) continue;
    const abs = path.resolve(root, f.file);
    const cfg = cfgs.get(abs);
    const kids = [...(children.get(f.key) ?? [])].map((k) => p.functions[k]).filter((x): x is PathFn => !!x);
    const visit = (n: PathNode) => {
      for (const x of n.fns ?? []) {
        const fn = cfg && !(cfg instanceof Error) ? cfg.functions[x.id] : undefined;
        const key = fn?.starts.map((s) => byStart.get(`${abs}#${s}`)).find((k) => k !== undefined);
        if (key) x.fnKey = key;
      }
      const callees: NonNullable<PathNode["callees"]> = [];
      const ambiguous: string[] = [];
      for (const name of n.calls ?? []) {
        const last = name.split(/[.?]+/).pop() ?? name;
        const hits = kids.filter((k) => k.name === name || k.name === last || (k.v8Name && k.v8Name === last));
        if (hits.length === 1) callees.push({ name, fnKey: hits[0]!.key });
        // More than one hop could be this call: left unlinked, and the UI says why.
        else if (hits.length > 1) ambiguous.push(name);
      }
      if (callees.length) n.callees = callees;
      if (ambiguous.length) n.ambiguous = ambiguous;
      for (const c of n.body ?? []) visit(c);
      for (const a of n.arms ?? []) for (const c of a.body ?? []) visit(c);
    };
    visit(graph);
  }
}

/** The request's exit, from the handler lane's function (the first lane at depth 0). */
export function requestVerdict(p: PathPayload): PathVerdict {
  const lane = p.lanes.find((l) => l.depth === 0 && l.fnKey);
  if (!lane?.fnKey) return { text: "Exit: UNKNOWN (no handler lane)" };
  const fn = p.functions[lane.fnKey];
  const a = fn?.analysis;
  const name = lane.name;
  if (!fn || !a) return { text: "Exit: UNKNOWN (no analysis)" };
  if (a.status === "unknown") return { text: `Exit: UNKNOWN (${a.why ?? "unknown"})` };
  const exits = a.exits.filter((e) => e.count !== 0);
  const unknown = exits.find((e) => e.count === null);
  if (unknown) return { text: `Exit: UNKNOWN (${unknown.why ?? "unknown"})` };
  if (!exits.length) return { text: `Exit: UNKNOWN (no exit counted in ${name})` };
  const calls = a.calls > 1 ? ` (${a.calls} calls, totals)` : "";
  if (exits.length === 1) {
    const e = exits[0]!;
    const via = e.via ? ` via ${e.via.label} -> ${e.via.arm}` : "";
    const at = e.line === null ? " (line unknown)" : ` L${e.line}`;
    const text =
      e.kind === "end"
        ? `Exited: end of ${name}${at}${calls}`
        : e.kind === "exception"
          ? `Threw: exception in ${name}${at}${calls}`
          : `${e.kind === "throw" ? "Threw" : "Exited"}: ${e.kind} at ${name}${at}${via}${calls}`;
    const exit: PathVerdict["exit"] = { fnKey: lane.fnKey, kind: e.kind, line: e.line };
    if (e.nodeId !== undefined) exit.nodeId = e.nodeId;
    if (e.via) exit.via = e.via;
    return { text, exit };
  }
  const list = exits.map((e) => `${e.kind} L${e.line ?? "?"} x${e.count}`).join(", ");
  return { text: `Exited ${exits.length} ways in ${name}${calls}: ${list}` };
}

export type { TruthWhy };
