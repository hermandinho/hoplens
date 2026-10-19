import { signal } from "@preact/signals";
import { api } from "../api/client";
import type { PathFn, PathNode, PathPayload, PathWhy } from "../api/types";
import { QUALITY, decisionText, whyText } from "./path";
import { type Tone, countText, toneOf } from "./pathFlow";

/*
 * Request path function panel (plan P4): which function of a path trace is open (a stack, for the
 * breadcrumb and Backspace), Flow or Source, and the Source view's gutter model (mockup D). Pure
 * helpers plus the panel's signals. Every count shown comes from the server's graph / analysis
 * (core truth.ts); nothing here decides taken or not. Tested by test/pathPanel.test.ts.
 */

export type PanelView = "flow" | "source";

export interface PanelState {
  traceId: string;
  /** Open functions, root first (the trail's pick, then callee links followed). */
  stack: string[];
  /** Flow / Source picked by hand (v); null: the function's default. */
  view: PanelView | null;
  /** The line a chip pointed at, for the first focus. */
  line?: number;
  /** The flowchart node to focus first (back from a callee: the chip it was followed from). */
  focus?: string;
  /** Per stack level below the top: the chip that opened the next level (for the way back). */
  from?: Array<FromChip | undefined>;
}

/** The node a callee link was followed from. */
export interface FromChip {
  key: string;
  line?: number;
}

export type PanelAction =
  | { t: "open"; traceId: string; fnKey: string; line?: number }
  | { t: "push"; fnKey: string; from?: FromChip }
  | { t: "back" }
  | { t: "crumb"; depth: number }
  | { t: "close" }
  | { t: "view"; view: PanelView };

/** Deepest callee chain kept (a recursive helper links to itself). */
export const MAX_STACK = 12;

export function panelReduce(s: PanelState | null, a: PanelAction): PanelState | null {
  switch (a.t) {
    case "open": {
      const next: PanelState = { traceId: a.traceId, stack: [a.fnKey], view: s?.traceId === a.traceId ? s.view : null };
      if (a.line !== undefined) next.line = a.line;
      return next;
    }
    case "push": {
      if (!s || s.stack[s.stack.length - 1] === a.fnKey) return s;
      const from = [...(s.from ?? []), a.from];
      while (from.length < s.stack.length) from.unshift(undefined);
      const keep = s.stack.length + 1 - MAX_STACK;
      return {
        traceId: s.traceId,
        stack: [...s.stack, a.fnKey].slice(-MAX_STACK),
        view: s.view,
        from: keep > 0 ? from.slice(keep) : from,
      };
    }
    case "back":
      return !s || s.stack.length <= 1 ? null : cut(s, s.stack.length - 1);
    case "crumb":
      return !s || a.depth < 0 ? null : cut(s, Math.min(a.depth + 1, s.stack.length));
    case "close":
      return null;
    case "view":
      return s ? { ...s, view: a.view } : s;
  }
}

/** The stack cut to its first `depth` levels, focus on the chip that opened the level cut away. */
function cut(s: PanelState, depth: number): PanelState {
  if (depth >= s.stack.length) return s;
  const next: PanelState = { traceId: s.traceId, stack: s.stack.slice(0, depth), view: s.view };
  const from = s.from ?? [];
  if (depth > 1) next.from = from.slice(0, depth - 1);
  const chip = from[depth - 1];
  if (chip) {
    next.focus = chip.key;
    if (chip.line !== undefined) next.line = chip.line;
  }
  return next;
}

export const pathPanel = signal<PanelState | null>(null);

export function panelDo(a: PanelAction): void {
  pathPanel.value = panelReduce(pathPanel.peek(), a);
}

/** Above this many graph nodes the Source view opens first (a flowchart that big reads worse). */
export const FLOW_MAX_NODES = 150;

/** Why there is no flowchart for `fn`, or null when there is one. */
export function flowUnavailable(payload: PathPayload, fn: PathFn | undefined): string | null {
  const a = fn?.analysis;
  if (!fn || !a) return "this function was not analyzed";
  if (a.status !== "ok") return `UNKNOWN: ${whyText(a.why ?? (fn.truth.t === "unknown" ? fn.truth.why : undefined))}`;
  if (!a.graph)
    return payload.analysis?.graphsDropped
      ? "the flowcharts were left out to keep the payload small"
      : "the server sent no flowchart";
  return null;
}

/** Flow or Source: the hand-picked one when it can be shown, else Source on phones, for big or chart-less functions. */
export function viewFor(
  s: Pick<PanelState, "view">,
  payload: PathPayload,
  fn: PathFn | undefined,
  phone: boolean,
): PanelView {
  if (flowUnavailable(payload, fn)) return "source";
  if (s.view) return s.view;
  return phone || (fn?.analysis?.nodeCount ?? 0) > FLOW_MAX_NODES ? "source" : "flow";
}

/** `Trail > GET /api/products/:id > findProduct`: the trail, then each open function. */
export function crumbs(payload: PathPayload, stack: readonly string[]): string[] {
  return [
    "Trail",
    ...stack.map((k) => {
      const lane = payload.lanes.find((l) => l.fnKey === k && l.depth === 0);
      return lane?.name ?? (payload.functions[k]?.name || "(anonymous)");
    }),
  ];
}

/** The function's call count for the panel head: the server's coverage count, else its hop count. */
export function fnCalls(fn: PathFn): number {
  return fn.calls.coverage ?? fn.calls.hops;
}

/** `block coverage . identity map . quiet window . EXACT` (+ the blend, when there is one). */
export function evidenceText(payload: PathPayload, fn: PathFn | undefined): string {
  const parts = [
    fn?.blocks === false ? "function counts only" : "block coverage",
    fn?.mapping === "identity" ? "identity map" : fn?.mapping === "sourcemap" ? "source map" : "not mapped",
    payload.quality === "contaminated" || payload.window.taint.length ? "window tainted" : "quiet window",
  ];
  const calls = fn?.analysis?.calls ?? 0;
  if (fn?.analysis?.blended && calls > 1) parts.push(`${calls} calls: totals`);
  if (fn && !fn.calls.checked) parts.push("calls unchecked");
  parts.push(QUALITY[payload.quality].label);
  return parts.join(" . ");
}

/* ----------------------------------------------------------- source view */

export interface GutterNote {
  text: string;
  tone: Tone | "split";
  title?: string;
}

export interface GutterRow {
  line: number;
  text: string;
  /** `x3`, `0`, `?`, or "" (blank line). */
  count: string;
  tone: Tone | "none";
  why?: PathWhy | string;
  notes: GutterNote[];
  /** An exit that ran; `request`: the request's exit. */
  exit?: "exit" | "request";
}

interface Paint {
  n: number | null;
  why?: PathWhy | string;
}

/**
 * Paint every line of the function with the count of the innermost node / arm spanning it. A
 * compound statement keeps its own count on its header line (`if (x) continue;` reads the if's
 * reach, not the continue's) and on a closing `}` line of its own.
 */
function paintGraph(g: PathNode, from: number, to: number, text: (line: number) => string): Map<number, Paint> {
  const out = new Map<number, Paint>();
  const locked = new Set<number>();
  const paint = (a: number, b: number, p: Paint) => {
    for (let l = Math.max(a, from); l <= Math.min(b, to); l++) if (!locked.has(l)) out.set(l, p);
  };
  const visit = (n: PathNode) => {
    paint(n.line, n.endLine, { n: n.n, why: n.why });
    const compound = n.k !== "stmt" && n.k !== "exit" && n.k !== "fold";
    if (!compound) return;
    if (n.k !== "block") locked.add(n.line);
    const closer = n.endLine > n.line && /^\s*\}/.test(text(n.endLine));
    const last = closer ? n.endLine - 1 : n.endLine;
    if (closer) locked.add(n.endLine);
    const arms = n.arms ?? [];
    arms.forEach((a, i) => {
      if (a.implied) return;
      const next = arms.slice(i + 1).find((x) => !x.implied);
      paint(a.line, next ? next.line - 1 : last, { n: a.n, why: a.why });
      for (const c of a.body ?? []) visit(c);
    });
    if (n.k === "loop") paint(n.line + 1, last, { n: n.passes ?? null, why: n.why });
    for (const c of n.body ?? []) visit(c);
  };
  visit(g);
  return out;
}

/**
 * The gutter for `fn` over its source lines (`start` is the first line's number): counts per line,
 * decision lines annotated with the arm taken, loops with their passes, exits marked. A function
 * without a graph gets `?` everywhere, with the reason.
 */
export function gutterRows(
  payload: PathPayload,
  fn: PathFn,
  src: { start: number; lines: readonly string[]; hash?: string },
): GutterRow[] {
  const from = fn.startLine ?? fn.line;
  const to = fn.endLine ?? src.start + src.lines.length - 1;
  // Counts belong to the lines that were traced: a file edited since gets '?' everywhere.
  const moved = sourceMoved(fn, src);
  const a = moved ? undefined : fn.analysis;
  const g = a?.status === "ok" ? a.graph : undefined;
  const why: string | undefined = moved
    ? "source-moved"
    : !a
      ? "not analyzed"
      : a.status !== "ok"
        ? (a.why ?? (fn.truth.t === "unknown" ? fn.truth.why : undefined))
        : g
          ? undefined
          : "too-large";
  const painted = g ? paintGraph(g, from, to, (l) => src.lines[l - src.start] ?? "") : undefined;
  const notes = new Map<number, GutterNote[]>();
  const note = (line: number | null, n: GutterNote) => {
    if (line === null) return;
    const list = notes.get(line);
    if (list) list.push(n);
    else notes.set(line, [n]);
  };
  const exits = new Map<number, "exit" | "request">();
  if (a?.status === "ok") {
    for (const d of a.decisions) {
      const head = d.kind === "ternary" || d.kind === "logical" ? `${decisionText(d.kind, d.label)} ` : "";
      const tone: GutterNote["tone"] =
        d.verdict === "one"
          ? "taken"
          : d.verdict === "unreached"
            ? "not"
            : d.verdict === "unknown"
              ? "unknown"
              : "split";
      const text = d.verdict === "one" ? `${head}-> ${d.summary}` : `${head}${d.summary}`;
      note(d.line, { text, tone, title: d.arms.map((x) => `${x.label} ${x.count ?? "?"}`).join(", ") });
    }
    for (const l of a.loops) {
      const t = toneOf(l.entries) === "taken" ? toneOf(l.passes) : toneOf(l.entries);
      note(l.line, { text: t === "not" ? "not entered" : countText(l.passes), tone: t });
    }
    const req = payload.analysis?.exit;
    for (const e of a.exits) {
      if (e.line === null || e.kind === "end" || toneOf(e.count) !== "taken") continue;
      const isReq = !!req && req.fnKey === fn.key && req.line === e.line && req.kind === e.kind;
      exits.set(e.line, isReq ? "request" : "exit");
      note(e.line, { text: isReq ? `${e.kind} (the request's exit)` : e.kind, tone: "taken" });
    }
  }
  const rows: GutterRow[] = [];
  for (let line = from; line <= to; line++) {
    const text = src.lines[line - src.start];
    if (text === undefined) continue;
    const row: GutterRow = { line, text, count: "", tone: "none", notes: notes.get(line) ?? [] };
    if (text.trim()) {
      const p = painted ? painted.get(line) : { n: null, why };
      if (p) {
        row.count = countText(p.n);
        row.tone = toneOf(p.n);
        if (row.tone === "unknown") row.why = p.why ?? why;
      }
    }
    const ex = exits.get(line);
    if (ex) row.exit = ex;
    rows.push(row);
  }
  return rows;
}

/** The file changed since the trace (its hash now differs from the one captured with the counts). */
export function sourceMoved(fn: PathFn, src: { hash?: string }): boolean {
  return !!fn.sourceHash && !!src.hash && src.hash !== fn.sourceHash;
}

/** Not-run regions of this many lines or more fold behind '> N lines not run' (shorter ones are only dimmed). */
export const SOURCE_FOLD_MIN = 2;

export type SourceBlock =
  | { t: "row"; row: GutterRow }
  | { t: "fold"; key: string; from: number; to: number; lines: number; open: boolean; rows: GutterRow[] };

/** Rows with not-run regions folded (blank lines inside a region belong to it). */
export function sourceBlocks(rows: readonly GutterRow[], open: ReadonlySet<string>): SourceBlock[] {
  const out: SourceBlock[] = [];
  for (let i = 0; i < rows.length; ) {
    const r = rows[i]!;
    if (r.tone !== "not") {
      out.push({ t: "row", row: r });
      i++;
      continue;
    }
    let j = i;
    let last = i;
    while (j < rows.length && (rows[j]!.tone === "not" || rows[j]!.tone === "none")) {
      if (rows[j]!.tone === "not") last = j;
      j++;
    }
    const region = rows.slice(i, last + 1);
    if (region.length >= SOURCE_FOLD_MIN) {
      const key = `s${r.line}`;
      out.push({
        t: "fold",
        key,
        from: r.line,
        to: rows[last]!.line,
        lines: region.length,
        open: open.has(key),
        rows: region,
      });
    } else for (const x of region) out.push({ t: "row", row: x });
    i = last + 1;
  }
  return out;
}

/* ------------------------------------------------------------ source text */

export type FnSource = { start: number; lines: string[]; hash?: string } | { error: string } | "loading";

export const fnSources = signal<ReadonlyMap<string, FnSource>>(new Map());

/** Lines `fn` spans (its hop line plus some when the join gave none). */
export function fnSpan(fn: PathFn): [number, number] {
  const from = fn.startLine ?? fn.line;
  return [from, Math.max(from, fn.endLine ?? from + 30)];
}

/** Cache key: the captured hash too, so a later trace of an edited file never reads the old text. */
const srcKey = (fn: PathFn) => `${fn.file}:${fnSpan(fn).join("-")}:${fn.sourceHash ?? ""}`;

export function sourceOf(fn: PathFn): FnSource | undefined {
  return fnSources.value.get(srcKey(fn));
}

/** Fetch `fn`'s lines once from the source endpoint (the file as it is now). */
export async function loadFnSource(fn: PathFn): Promise<void> {
  const key = srcKey(fn);
  if (fnSources.peek().has(key)) return;
  const set = (v: FnSource) => {
    const next = new Map(fnSources.peek());
    next.set(key, v);
    while (next.size > 40) next.delete(next.keys().next().value as string);
    fnSources.value = next;
  };
  set("loading");
  const [from, to] = fnSpan(fn);
  try {
    const r = await api.source(fn.file, from, to - from);
    const got: FnSource = { start: from, lines: r.lines.slice(from - r.start, to - r.start + 1) };
    if (r.hash) got.hash = r.hash;
    set(got);
  } catch (err) {
    set({ error: (err as Error)?.message ?? "could not read the file" });
  }
}
