import type { PathDecision, PathFn, PathNode, PathNodeArm, PathPayload, PathWhy } from "../api/types";
import { decisionChip, decisionText, whyText } from "./path";

/*
 * Request path flowchart (plan P4, mockup C): the server's per-function node graph (core truth.ts
 * PathNode) as a top-down structured diagram, laid out by recursive series-parallel measuring (no
 * layout library). Pure: PathFlow.tsx only draws what this returns. Tested by test/pathFlow.test.ts.
 *
 * Truth is read, never derived: a node's tone is its server count (n > 0 taken, 0 not run, null
 * UNKNOWN), an arm edge's tone is its arm's count, and an edge between two counted points is taken
 * only when both ends are (joinTone): an arm's edge out to the join also takes its last node's
 * tone. Nothing here turns a 0 or an UNKNOWN into taken.
 *
 * Folding keeps big functions readable: a run of nodes that did not run is one '> N lines not run'
 * node, a not-run `if` arm is a dashed stub beside its diamond, and RUN_MIN or more plain statements
 * with the same count are one box. Each fold opens on click / Enter (its key in `open`).
 */

export type Tone = "taken" | "not" | "unknown";

/** A server count's tone: n > 0 taken, 0 not run, null / absent UNKNOWN. */
export function toneOf(n: number | null | undefined): Tone {
  return typeof n !== "number" ? "unknown" : n > 0 ? "taken" : "not";
}

/** An edge between counted points: not taken when any end is 0, UNKNOWN when any is, else taken. */
export function joinTone(...tones: Tone[]): Tone {
  return tones.includes("not") ? "not" : tones.includes("unknown") ? "unknown" : "taken";
}

/** `x3`, `0`, `?`. */
export function countText(n: number | null | undefined): string {
  return typeof n !== "number" ? "?" : n > 0 ? `x${n}` : "0";
}

const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;

/** `ran 2 times` | `not run` | `UNKNOWN: <reason>`. */
export function countPhrase(n: number | null | undefined, why?: PathWhy | string): string {
  const t = toneOf(n);
  return t === "taken" ? `ran ${times(n as number)}` : t === "not" ? "not run" : `UNKNOWN: ${whyText(why)}`;
}

/** `then taken 1 time` | `then not taken` | `then UNKNOWN (reason)`. */
export function armPhrase(label: string, n: number | null | undefined, why?: PathWhy | string): string {
  const t = toneOf(n);
  return t === "taken"
    ? `${label} taken ${times(n as number)}`
    : t === "not"
      ? `${label} not taken`
      : `${label} UNKNOWN (${whyText(why)})`;
}

/* ------------------------------------------------------------------ sizes */

const BOX_H = 22;
const TAG_H = 16;
const GAP_Y = 12;
const GAP_X = 14;
const CH = 6.6;
/** Per character at 10px (tags, chips, edge labels): mono fonts run 0.55-0.6em, plus slack. */
const TAG_CH = 6.2;
const PAD = 8;
const COUNT_W = 26;
const DIA_H = 24;
/** Horizontal inset of a diamond's text past its pointed ends. */
const DIA_X = 20;
const FORK_GAP = 24;
const JOIN_GAP = 12;
const LOOP_PAD = 14;
const FRAME_HEAD = 16;
const STUB_GAP = 30;
/** A not-run stub's label row, above its box. */
const STUB_LAB = 12;
const MIN_W = 56;
const MAX_W = 236;
const ARM_MIN = 44;
const MARGIN = 12;

/** Layout sizes (px), for tests and the renderer. */
export const FLOW = {
  BOX_H,
  TAG_H,
  GAP_Y,
  GAP_X,
  CH,
  TAG_CH,
  PAD,
  COUNT_W,
  DIA_H,
  DIA_X,
  FORK_GAP,
  JOIN_GAP,
  LOOP_PAD,
  FRAME_HEAD,
  STUB_GAP,
  STUB_LAB,
  MIN_W,
  MAX_W,
  ARM_MIN,
  MARGIN,
} as const;

/** Plain statements with one count that fold into one box. */
export const RUN_MIN = 3;

const clampW = (w: number) => Math.max(MIN_W, Math.min(MAX_W, Math.ceil(w)));

/** `text` cut to `max` characters (`...` marks the cut). */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 3))}...`;
}

/* ------------------------------------------------------------------ model */

export type FlowKind = "entry" | "end" | "stmt" | "run" | "exit" | "fold" | "cap" | "decision" | "loop" | "callee";

export interface FlowTag {
  x: number;
  y: number;
  w: number;
  text: string;
  title: string;
  tone: Tone | "split";
}

export interface FlowNode {
  key: string;
  kind: FlowKind;
  shape: "box" | "pill" | "diamond" | "fold" | "chip";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Shown (clipped) text; `full` is the hover / title text. */
  text: string;
  full: string;
  count: string;
  tone: Tone;
  line?: number;
  endLine?: number;
  nodeId?: number;
  /** A fold / run: its key in `open`. */
  toggle?: string;
  /** A callee chip, or a box with exactly one linked callee: the function it opens. */
  fnKey?: string;
  aria: string;
  /** The request's exit. */
  exitMark?: boolean;
  /** Non-focusable decision tags and unlinked call names under the box. */
  tags?: FlowTag[];
}

export interface FlowEdge {
  pts: Array<[number, number]>;
  tone: Tone;
  label?: { x: number; y: number; text: string; anchor?: "start" | "end" };
  back?: boolean;
}

export interface FlowFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  tone: Tone;
}

export interface FlowLayout {
  w: number;
  h: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  frames: FlowFrame[];
}

interface Tag {
  text: string;
  title: string;
  tone: Tone | "split";
  fnKey?: string;
  callee?: string;
}

/** A measured part: its extents left (l) and right (r) of its spine, height, and whether it ends the flow. */
interface M {
  l: number;
  r: number;
  w: number;
  h: number;
  term: boolean;
}

type V =
  | { t: "pill"; key: string; kind: "entry" | "end"; text: string; full: string; n: number | null; aria: string }
  | {
      t: "box";
      key: string;
      kind: "stmt" | "exit" | "cap";
      node: PathNode;
      term: boolean;
      /** A break that leaves the enclosing switch clause from inside an if / try. */
      esc?: boolean;
      tags: Tag[];
    }
  | { t: "fold"; key: string; nodes: PathNode[]; lines: number; from: number; to: number }
  | { t: "run"; key: string; nodes: PathNode[] }
  | {
      t: "fork";
      key: string;
      kind: "if" | "switch" | "try";
      node: PathNode;
      arms: VArm[];
      stubs: VArm[];
      fin?: VArm;
      term: boolean;
      esc: boolean;
      /** Callee links and tags of the head (left of the diamond). */
      head: Tag[];
    }
  | { t: "loop"; key: string; node: PathNode; body: V[]; head: Tag[] };

interface VArm {
  label: string;
  n: number | null;
  why?: PathWhy;
  body: V[];
  /** No code (an unwritten else, an empty case): the edge goes straight to the join. */
  empty: boolean;
  /** A switch clause that runs on into the next one (server: arm.fallsThrough). */
  fallsThrough?: boolean;
  /** Fold key of a not-run stub (opens the arm). */
  toggle?: string;
}

interface Ctx {
  decisions: Map<string, PathDecision>;
  open: ReadonlySet<string>;
  exitNode?: number;
}

/** Where a node sits relative to a switch: its clause's own list, nested under it (if / try), or neither. */
type InCase = "clause" | "nested" | false;

const lastName = (s: string) => s.split(/[.?]+/).pop() ?? s;

function flatten(list: readonly PathNode[] | undefined): PathNode[] {
  const out: PathNode[] = [];
  for (const n of list ?? []) {
    if (n.k === "block") out.push(...flatten(n.body));
    else out.push(n);
  }
  return out;
}

function tagsOf(n: PathNode, ctx: Ctx): Tag[] {
  const out: Tag[] = [];
  for (const id of n.decisions ?? []) {
    const d = ctx.decisions.get(id);
    // The node's own if / switch / try decision is drawn as the node itself.
    if (!d || d.nodeId === n.id) continue;
    const c = decisionChip(d);
    out.push({ text: clip(c.text, 30), title: c.title, tone: c.tone === "split" ? "split" : (c.tone as Tone) });
  }
  const linked = new Set<string>();
  for (const c of n.callees ?? []) {
    linked.add(c.name);
    out.push({ text: `-> ${clip(lastName(c.name), 22)}()`, title: `call ${c.name}`, tone: "taken", fnKey: c.fnKey });
  }
  for (const f of n.fns ?? [])
    if (f.fnKey)
      out.push({
        text: `-> ${clip(f.name || "callback", 22)}`,
        title: `function ${f.name}`,
        tone: "taken",
        fnKey: f.fnKey,
      });
  // Only the server knows why a call is unlinked: it marks the ones more than one hop matches.
  for (const c of n.ambiguous ?? [])
    if (!linked.has(c))
      out.push({
        text: `${clip(lastName(c), 22)}()`,
        title: `call ${c}: more than one traced function could be this one, so it is not linked`,
        tone: "unknown",
        callee: c,
      });
  return out;
}

function plain(n: PathNode, ctx: Ctx): boolean {
  return n.k === "stmt" && !tagsOf(n, ctx).length;
}

function toArm(a: PathNodeArm, ctx: Ctx, inCase: InCase): VArm {
  const body = lowerList(a.body, ctx, inCase);
  const arm: VArm = { label: a.label, n: a.n, body, empty: !body.length };
  if (a.why) arm.why = a.why;
  return arm;
}

/** The fold key of a not-run list starting at `first` (shared by a stub and its list fold). */
const foldKey = (first: PathNode) => `f${first.id}`;

function lowerOne(n: PathNode, ctx: Ctx, inCase: InCase): V {
  const key = `n${n.id}`;
  // An if / try under a clause keeps the clause's breaks (they leave the switch, not the if).
  const sub: InCase = inCase ? "nested" : false;
  switch (n.k) {
    case "if": {
      const all = (n.arms ?? []).map((a) => {
        const arm = toArm(a, ctx, sub);
        const first = flatten(a.body)[0];
        if (first && toneOf(a.n) === "not" && !ctx.open.has(foldKey(first))) arm.toggle = foldKey(first);
        return arm;
      });
      const stubs = all.filter((a) => a.toggle);
      const arms = all.filter((a) => !a.toggle);
      const term = arms.length > 0 && arms.every((a) => !a.empty && armTerm(a));
      const esc = arms.some(armEsc);
      return { t: "fork", key, kind: "if", node: n, arms, stubs, term, esc, head: tagsOf(n, ctx) };
    }
    case "switch": {
      const arms = (n.arms ?? []).map((a) => {
        const arm = toArm(a, ctx, "clause");
        if (a.fallsThrough) {
          arm.label = `${a.label} (falls through)`;
          arm.fallsThrough = true;
        }
        return arm;
      });
      if (!(n.arms ?? []).some((a) => /^default\b/.test(a.label))) {
        const d = n.decisions?.map((id) => ctx.decisions.get(id)).find((x) => x?.nodeId === n.id);
        const implied = d?.arms.find((a) => a.implied);
        const arm: VArm = {
          label: implied?.label ?? "no match",
          n: implied ? implied.count : null,
          body: [],
          empty: true,
        };
        arm.why = implied?.why ?? (implied ? undefined : "no-counter");
        arms.push(arm);
      }
      // A clause that breaks out of a nested if / try still reaches the code after the switch.
      const term = arms.every((a) => !a.empty && armTerm(a) && !armEsc(a));
      return { t: "fork", key, kind: "switch", node: n, arms, stubs: [], term, esc: false, head: tagsOf(n, ctx) };
    }
    case "try": {
      const parts = (n.arms ?? []).map((a) => toArm(a, ctx, sub));
      const fin = (n.arms ?? []).findIndex((a) => a.label === "finally");
      const arms = parts.filter((_, i) => i !== fin);
      const finArm = fin >= 0 ? parts[fin] : undefined;
      const term = (arms.every((a) => !a.empty && armTerm(a)) && arms.length > 0) || (!!finArm && armTerm(finArm));
      const esc = parts.some(armEsc);
      return finArm
        ? { t: "fork", key, kind: "try", node: n, arms, stubs: [], fin: finArm, term, esc, head: [] }
        : { t: "fork", key, kind: "try", node: n, arms, stubs: [], term, esc, head: [] };
    }
    case "loop":
      return { t: "loop", key, node: n, body: lowerList(n.body, ctx, false), head: tagsOf(n, ctx) };
    case "exit": {
      const caseBreak = n.exit === "break" && !n.target && !!inCase;
      // A clause's own break ends it into the code after the switch: flow goes on from there.
      // One nested in an if / try ends that arm (nothing after it in the arm runs) but leaves the switch.
      const v: V = {
        t: "box",
        key,
        kind: "exit",
        node: n,
        term: !(caseBreak && inCase === "clause"),
        tags: tagsOf(n, ctx),
      };
      if (caseBreak && inCase === "nested") v.esc = true;
      return v;
    }
    case "fold":
      return { t: "box", key, kind: "cap", node: n, term: false, tags: [] };
    default:
      return { t: "box", key, kind: "stmt", node: n, term: false, tags: tagsOf(n, ctx) };
  }
}

function armTerm(a: VArm): boolean {
  return a.body.some(termOf);
}

function termOf(v: V): boolean {
  return v.t === "box" ? v.term : v.t === "fork" ? v.term : false;
}

function armEsc(a: VArm): boolean {
  return a.body.some((v) => (v.t === "box" || v.t === "fork") && !!v.esc);
}

function lowerList(list: readonly PathNode[] | undefined, ctx: Ctx, inCase: InCase): V[] {
  const flat = flatten(list);
  const out: V[] = [];
  for (let i = 0; i < flat.length; ) {
    const n = flat[i]!;
    if (toneOf(n.n) === "not") {
      let j = i;
      while (j < flat.length && toneOf(flat[j]!.n) === "not") j++;
      const group = flat.slice(i, j);
      if (!ctx.open.has(foldKey(n))) {
        const lines = new Set<number>();
        for (const g of group) for (let l = g.line; l <= g.endLine; l++) lines.add(l);
        out.push({
          t: "fold",
          key: foldKey(n),
          nodes: group,
          lines: lines.size,
          from: n.line,
          to: group[group.length - 1]!.endLine,
        });
      } else for (const g of group) out.push(lowerOne(g, ctx, inCase));
      i = j;
      continue;
    }
    if (plain(n, ctx)) {
      let j = i + 1;
      while (j < flat.length && plain(flat[j]!, ctx) && flat[j]!.n === n.n && flat[j]!.why === n.why) j++;
      if (j - i >= RUN_MIN && !ctx.open.has(`r${n.id}`)) {
        out.push({ t: "run", key: `r${n.id}`, nodes: flat.slice(i, j) });
        i = j;
        continue;
      }
    }
    out.push(lowerOne(n, ctx, inCase));
    i++;
  }
  return out;
}

/* ---------------------------------------------------------------- measure */

const textW = (s: string, ch: number = CH) => s.length * ch;
const boxW = (text: string) => clampW(textW(text) + 2 * PAD + COUNT_W);
const tagW = (t: Tag) => Math.round(textW(t.text, TAG_CH) + 12);
const tagsW = (tags: Tag[]) => tags.reduce((a, t) => a + tagW(t), 0) + Math.max(0, tags.length - 1) * 6;
/** Head tags sit left of the diamond: how far they reach past its left point. */
const headL = (tags: Tag[]) => (tags.length ? 8 + tagsW(tags) : 0);
const diaW = (text: string) => clampW(textW(text) + 2 * PAD + COUNT_W + DIA_X);
const labW = (text: string) => Math.ceil(textW(text, TAG_CH));
const forkHead = (v: Extract<V, { t: "fork" }>) => (v.kind === "try" ? 4 : DIA_H);
const sym = (w: number, h: number, term: boolean): M => ({ l: w / 2, r: w / 2, w, h, term });

function boxText(v: V): string {
  switch (v.t) {
    case "pill":
      return v.text;
    case "box":
      return v.node.label ?? "";
    case "fold":
      return `> ${v.lines} line${v.lines === 1 ? "" : "s"} not run`;
    case "run": {
      const a = v.nodes[0]!;
      const b = v.nodes[v.nodes.length - 1]!;
      return `L${a.line}-${b.endLine}: ${v.nodes.length} statements`;
    }
    case "fork":
      return v.kind === "switch" ? `switch (${v.node.label ?? ""})` : `if ${v.node.label ?? ""}`;
    case "loop":
      return v.node.label ?? "loop";
  }
}

const sizes = new WeakMap<V | VArm, M>();

function measure(v: V): M {
  const hit = sizes.get(v);
  if (hit) return hit;
  let m: M;
  switch (v.t) {
    case "pill":
    case "fold":
    case "run":
      m = sym(boxW(boxText(v)), BOX_H, false);
      break;
    case "box":
      m = sym(Math.max(boxW(boxText(v)), tagsW(v.tags)), BOX_H + (v.tags.length ? TAG_H + 4 : 0), v.term);
      break;
    case "loop": {
      const b = measureList(v.body);
      const half = diaW(boxText(v)) / 2;
      // Right: room for the back edge's pass count between the diamond and the loop rail.
      const back = labW(countText(v.node.passes)) + 8;
      const l = Math.max(half + headL(v.head), b.l) + LOOP_PAD;
      const r = Math.max(half + back, b.r) + LOOP_PAD;
      m = { l, r, w: l + r, h: DIA_H + FORK_GAP + b.h + LOOP_PAD, term: false };
      break;
    }
    case "fork": {
      const half = v.kind === "try" ? 0 : diaW(boxText(v)) / 2;
      const stubR = v.stubs.length
        ? half + STUB_GAP + Math.max(...v.stubs.map((s) => Math.max(measureList(s.body).w, labW(armLabel(s)))))
        : 0;
      const headH = Math.max(forkHead(v), stubsH(v.stubs));
      const row = armsRow(v.arms);
      let h = headH + (v.arms.length ? FORK_GAP + row.h : 0) + (v.term ? 0 : JOIN_GAP);
      let l = Math.max(half + (v.head.length ? headL(v.head) : 0), row.l);
      let r = Math.max(half, stubR, row.r);
      if (v.kind === "try") {
        const fin = v.fin ? measureList(v.fin.body) : undefined;
        if (fin) h += FORK_GAP + fin.h;
        l = Math.max(l, fin?.l ?? 0) + LOOP_PAD;
        r = Math.max(r, fin?.r ?? 0) + LOOP_PAD;
        h += FRAME_HEAD + LOOP_PAD;
      }
      m = { l, r, w: l + r, h, term: v.term };
      break;
    }
  }
  sizes.set(v, m);
  return m;
}

function stubsH(stubs: VArm[]): number {
  return stubs.reduce((h, s, i) => h + STUB_LAB + measureList(s.body).h + (i ? 4 : 0), 0);
}

/** An arm's column: its body's extents around the arm's spine, room for its label right of it. */
function armCol(a: VArm): { l: number; r: number } {
  const b = measureList(a.body);
  return { l: Math.max(ARM_MIN / 2, b.l), r: Math.max(ARM_MIN / 2, b.r, labW(armLabel(a)) + 8) };
}

/** The arms side by side; one arm hangs straight under the head (its spine on the fork's). */
function armsRow(arms: VArm[]): { l: number; r: number; h: number } {
  if (!arms.length) return { l: 0, r: 0, h: 0 };
  const h = Math.max(...arms.map((a) => measureList(a.body).h));
  if (arms.length === 1) return { ...armCol(arms[0]!), h };
  const w = arms.reduce((s, x) => {
    const c = armCol(x);
    return s + c.l + c.r;
  }, 0);
  const total = w + GAP_X * (arms.length - 1);
  return { l: total / 2, r: total / 2, h };
}

function measureList(list: V[]): M {
  let l = 0;
  let r = 0;
  let h = 0;
  let term = false;
  list.forEach((c, i) => {
    const m = measure(c);
    l = Math.max(l, m.l);
    r = Math.max(r, m.r);
    h += m.h + (i ? GAP_Y : 0);
    term ||= m.term;
  });
  return { l, r, w: l + r, h, term };
}

const armLabel = (a: VArm) => `${a.label} ${typeof a.n === "number" ? a.n : "?"}`;

/* ------------------------------------------------------------------ place */

interface Out {
  nodes: FlowNode[];
  edges: FlowEdge[];
  frames: FlowFrame[];
  ctx: Ctx;
  fn: PathFn;
}

function inTone(v: V): Tone {
  switch (v.t) {
    case "pill":
      return toneOf(v.n);
    case "fold":
      return "not";
    case "run":
      return toneOf(v.nodes[0]!.n);
    default:
      return toneOf(v.node.n);
  }
}

/** The tone flow leaves a list with: its last part's (an arm ending in an UNKNOWN node is not solid out). */
function outTone(list: V[]): Tone {
  const last = list[list.length - 1];
  return last ? inTone(last) : "taken";
}

/** What a fallthrough enters: the first code at or after arm `i` (empty clauses pass through). */
function entryTone(arms: VArm[], i: number): Tone {
  for (let k = i; k < arms.length; k++) {
    const a = arms[k]!;
    if (!a.empty) return inTone(a.body[0]!);
    if (!a.fallsThrough) return toneOf(a.n);
  }
  return "unknown";
}

function edge(out: Out, pts: Array<[number, number]>, tone: Tone, label?: FlowEdge["label"], back?: boolean) {
  const e: FlowEdge = { pts, tone };
  if (label) e.label = label;
  if (back) e.back = true;
  out.edges.push(e);
}

/** Place a series on the spine `cx` from `y`; returns its bottom. */
function placeList(list: V[], cx: number, y: number, out: Out, after: Tone): number {
  let cy = y;
  let prev: { y: number; tone: Tone } | null = null;
  let dead = false;
  list.forEach((v, i) => {
    const m = measure(v);
    if (prev && !dead)
      edge(
        out,
        [
          [cx, prev.y],
          [cx, cy],
        ],
        joinTone(prev.tone, inTone(v)),
      );
    const next = i + 1 < list.length ? inTone(list[i + 1]!) : after;
    placeV(v, cx, cy, out, next);
    // Code after a return / throw is unreachable: drawn (as not run) but not wired.
    if (m.term) dead = true;
    prev = { y: cy + m.h, tone: inTone(v) };
    cy += m.h + GAP_Y;
  });
  return cy - (list.length ? GAP_Y : 0);
}

function exitIsRequest(n: PathNode, ctx: Ctx): boolean {
  return ctx.exitNode !== undefined && ctx.exitNode === n.id;
}

function placeV(v: V, cx: number, y: number, out: Out, after: Tone): void {
  const ctx = out.ctx;
  switch (v.t) {
    case "pill": {
      const bw = boxW(v.text);
      out.nodes.push({
        key: v.key,
        kind: v.kind,
        shape: "pill",
        x: cx - bw / 2,
        y,
        w: bw,
        h: BOX_H,
        text: clip(v.text, chars(bw)),
        full: v.full,
        count: countText(v.n),
        tone: toneOf(v.n),
        aria: v.aria,
      });
      return;
    }
    case "fold":
    case "run": {
      const text = boxText(v);
      const bw = boxW(text);
      const first = v.nodes[0]!;
      const tone = v.t === "fold" ? "not" : toneOf(first.n);
      const labels = v.nodes.map((n) => n.label ?? "").filter(Boolean);
      out.nodes.push({
        key: v.key,
        kind: v.t,
        shape: v.t === "fold" ? "fold" : "box",
        x: cx - bw / 2,
        y,
        w: bw,
        h: BOX_H,
        text: clip(text, chars(bw)),
        full: labels.length > 2 ? `${labels[0]} ... ${labels[labels.length - 1]}` : labels.join(" "),
        count: v.t === "fold" ? "" : countText(first.n),
        tone,
        line: first.line,
        endLine: v.t === "fold" ? v.to : v.nodes[v.nodes.length - 1]!.endLine,
        toggle: v.key,
        aria:
          v.t === "fold"
            ? `${text.slice(2)}, L${v.from}-L${v.to}. Enter shows them`
            : `${v.nodes.length} statements, L${first.line}-L${v.nodes[v.nodes.length - 1]!.endLine}, each ${countPhrase(first.n, first.why)}. Enter shows them`,
      });
      return;
    }
    case "box": {
      const n = v.node;
      const text = n.label ?? "";
      const bw = boxW(text);
      const exitMark = v.kind === "exit" && exitIsRequest(n, ctx);
      const links = v.tags.filter((t) => t.fnKey);
      const kindWord =
        v.kind === "exit" ? (n.exit ?? "exit") : v.kind === "cap" ? "folded by the size cap" : "statement";
      const node: FlowNode = {
        key: v.key,
        kind: v.kind,
        shape: v.kind === "exit" && v.term ? "pill" : "box",
        x: cx - bw / 2,
        y,
        w: bw,
        h: BOX_H,
        text: clip(text, chars(bw)),
        full: text,
        count: countText(n.n),
        tone: toneOf(n.n),
        line: n.line,
        endLine: n.endLine,
        nodeId: n.id,
        aria: `${kindWord} L${n.line}: ${text}. ${countPhrase(n.n, n.why)}${exitMark ? ". The request's exit" : ""}${
          links.length ? `. Calls ${links.map(linkName).join(", ")}` : ""
        }`,
      };
      if (exitMark) node.exitMark = true;
      if (links.length === 1) node.fnKey = links[0]!.fnKey;
      out.nodes.push(node);
      const plainTags = placeTags(out, v.key, v.tags, cx - tagsW(v.tags) / 2, y + BOX_H + 4, n);
      if (plainTags.length) node.tags = plainTags;
      return;
    }
    case "loop": {
      const n = v.node;
      const m = measure(v);
      const text = boxText(v);
      const dw = diaW(text);
      const passes = n.passes;
      const passTone = joinTone(toneOf(n.n), toneOf(passes));
      const lp: FlowNode = {
        key: v.key,
        kind: "loop",
        shape: "diamond",
        x: cx - dw / 2,
        y,
        w: dw,
        h: DIA_H,
        text: clip(text, chars(dw - DIA_X)),
        full: text,
        count: countText(passes),
        tone: toneOf(n.n),
        line: n.line,
        endLine: n.endLine,
        nodeId: n.id,
        aria: `loop L${n.line} ${text}: ${
          toneOf(n.n) === "unknown"
            ? `UNKNOWN: ${whyText(n.why)}`
            : toneOf(n.n) === "not"
              ? "not reached"
              : typeof passes === "number"
                ? `${passes} pass${passes === 1 ? "" : "es"}`
                : "passes UNKNOWN"
        }`,
      };
      out.nodes.push(lp);
      headTags(out, v.key, v.head, n, cx, dw, y, lp);
      const by = y + DIA_H + FORK_GAP;
      const bm = measureList(v.body);
      edge(
        out,
        [
          [cx, y + DIA_H],
          [cx, by],
        ],
        passTone,
      );
      const bottom = placeList(v.body, cx, by, out, passTone);
      const xr = cx + m.r - LOOP_PAD / 2;
      const xl = cx - m.l + LOOP_PAD / 2;
      const midY = y + DIA_H / 2;
      if (!bm.term && v.body.length)
        edge(
          out,
          [
            [cx, bottom],
            [cx, bottom + LOOP_PAD / 2],
            [xr, bottom + LOOP_PAD / 2],
            [xr, midY],
            [cx + dw / 2, midY],
          ],
          // Back from the body's end: solid only when that end ran too.
          joinTone(passTone, outTone(v.body)),
          { x: xr - 4, y: midY - 4, text: countText(passes), anchor: "end" },
          true,
        );
      edge(
        out,
        [
          [cx - dw / 2, midY],
          [xl, midY],
          [xl, y + m.h],
          [cx, y + m.h],
        ],
        joinTone(toneOf(n.n), after),
      );
      return;
    }
    case "fork": {
      const n = v.node;
      const m = measure(v);
      let top = y;
      if (v.kind === "try") {
        out.frames.push({ x: cx - m.l + 2, y, w: m.w - 4, h: m.h, label: "try", tone: toneOf(n.n) });
        top = y + FRAME_HEAD;
        edge(
          out,
          [
            [cx, y],
            [cx, top + forkHead(v)],
          ],
          toneOf(n.n),
        );
      }
      const head = forkHead(v);
      const dw = v.kind === "try" ? 0 : diaW(boxText(v));
      const headH = Math.max(head, stubsH(v.stubs));
      const dy = top + (headH - head) / 2;
      const own = n.decisions?.map((id) => ctx.decisions.get(id)).find((d) => d?.nodeId === n.id);
      const armsAll = [...(n.arms ?? [])];
      if (v.kind !== "try") {
        const text = boxText(v);
        const dn: FlowNode = {
          key: v.key,
          kind: "decision",
          shape: "diamond",
          x: cx - dw / 2,
          y: dy,
          w: dw,
          h: DIA_H,
          text: clip(text, chars(dw - DIA_X)),
          full: own ? decisionChip(own).title : text,
          count: countText(n.n),
          tone: toneOf(n.n),
          line: n.line,
          endLine: n.endLine,
          nodeId: n.id,
          aria: `decision ${own ? decisionText(own.kind, own.label) : text}: ${
            toneOf(n.n) === "unknown"
              ? `UNKNOWN (${whyText(n.why)})`
              : own
                ? own.arms.map((a) => armPhrase(a.label, a.count, a.why)).join(", ")
                : armsAll.map((a) => armPhrase(a.label, a.n, a.why)).join(", ")
          }`,
        };
        out.nodes.push(dn);
        headTags(out, v.key, v.head, n, cx, dw, dy, dn);
      }
      // Not-run arms of an if: dashed stubs beside the diamond, folded, each labelled on its own row.
      let sy = top;
      const sx = cx + dw / 2 + STUB_GAP;
      for (const s of v.stubs) {
        const sm = measureList(s.body);
        const by = sy + STUB_LAB;
        edge(
          out,
          [
            [cx + dw / 2, dy + DIA_H / 2],
            [sx - 6, by + BOX_H / 2],
            [sx, by + BOX_H / 2],
          ],
          "not",
          { x: sx, y: by - 3, text: armLabel(s) },
        );
        placeList(s.body, sx + sm.l, by, out, "not");
        sy = by + sm.h + 4;
      }
      const hy = top + headH;
      const joinY = top + measureForkBody(v, headH);
      // Stubs taller than the diamond centre it in the head: keep the spine joined above and below.
      if (v.kind !== "try" && dy > top) {
        edge(
          out,
          [
            [cx, top],
            [cx, dy],
          ],
          toneOf(n.n),
        );
        if (v.arms.length || !v.term)
          edge(
            out,
            [
              [cx, dy + DIA_H],
              [cx, hy],
            ],
            v.arms.length ? toneOf(n.n) : "not",
          );
      }
      if (!v.arms.length && !v.term)
        edge(
          out,
          [
            [cx, hy],
            [cx, joinY],
          ],
          "not",
        );
      if (v.arms.length) {
        const row = armsRow(v.arms);
        const ay = hy + FORK_GAP;
        const midY = hy + 8;
        // Where a fallthrough enters a clause: beside its first box, below the arm labels.
        const inY = ay + BOX_H / 2;
        const cols = v.arms.map(armCol);
        const spines: number[] = [];
        let ax = cx - row.l;
        for (const c of cols) {
          spines.push(ax + c.l);
          ax += c.l + c.r + GAP_X;
        }
        const entryX = (j: number) => {
          const b = v.arms[j]!;
          return b.empty ? spines[j]! : spines[j]! - measure(b.body[0]!).l;
        };
        v.arms.forEach((a, i) => {
          const acx = spines[i]!;
          const tone = toneOf(a.n);
          const lab = { x: acx + 4, y: ay - 3, text: armLabel(a) };
          const into = a.fallsThrough && i + 1 < v.arms.length ? i + 1 : -1;
          if (a.empty) {
            if (into >= 0)
              edge(
                out,
                [
                  [cx, hy],
                  [cx, midY],
                  [acx, midY],
                  [acx, inY],
                  [entryX(into), inY],
                ],
                joinTone(tone, entryTone(v.arms, into)),
                lab,
              );
            else
              edge(
                out,
                [
                  [cx, hy],
                  [cx, midY],
                  [acx, midY],
                  [acx, joinY - JOIN_GAP / 2],
                  [cx, joinY - JOIN_GAP / 2],
                  [cx, joinY],
                ],
                joinTone(tone, after),
                lab,
              );
            return;
          }
          edge(
            out,
            [
              [cx, hy],
              [cx, midY],
              [acx, midY],
              [acx, ay],
            ],
            tone,
            lab,
          );
          const bottom = placeList(a.body, acx, ay, out, joinTone(tone, after));
          if (armTerm(a)) return;
          if (into >= 0) {
            // Runs on into the next clause, not out of the switch.
            const gx = acx + cols[i]!.r + GAP_X / 2;
            edge(
              out,
              [
                [acx, bottom],
                [acx, bottom + 3],
                [gx, bottom + 3],
                [gx, inY],
                [entryX(into), inY],
              ],
              joinTone(tone, outTone(a.body), entryTone(v.arms, into)),
            );
          } else if (!v.term)
            edge(
              out,
              [
                [acx, bottom],
                [acx, joinY - JOIN_GAP / 2],
                [cx, joinY - JOIN_GAP / 2],
                [cx, joinY],
              ],
              joinTone(tone, outTone(a.body), after),
            );
        });
      }
      if (v.kind === "try") {
        let bottom = joinY;
        let last: Tone = toneOf(n.n);
        if (v.fin) {
          const fy = joinY + FORK_GAP;
          const tone = toneOf(v.fin.n);
          edge(
            out,
            [
              [cx, joinY],
              [cx, fy],
            ],
            tone,
            { x: cx + 4, y: fy - 3, text: armLabel(v.fin) },
          );
          bottom = placeList(v.fin.body, cx, fy, out, after);
          last = joinTone(tone, outTone(v.fin.body));
        }
        if (!v.term)
          edge(
            out,
            [
              [cx, bottom],
              [cx, y + m.h],
            ],
            joinTone(last, after),
          );
      }
      return;
    }
  }
}

const linkName = (t: Tag) => t.title.replace(/^call |^function /, "");

/**
 * Callee chips (focusable nodes, in the node's own tone: a call that did not run links grey) and
 * plain tags in a row from `x`. Returns the plain tags.
 */
function placeTags(out: Out, key: string, tags: Tag[], x: number, y: number, n: PathNode): FlowTag[] {
  const plain: FlowTag[] = [];
  for (const t of tags) {
    const tw = tagW(t);
    if (t.fnKey)
      out.nodes.push({
        key: `${key}c${out.nodes.length}`,
        kind: "callee",
        shape: "chip",
        x,
        y,
        w: tw,
        h: TAG_H,
        text: t.text,
        full: t.title,
        count: "",
        tone: toneOf(n.n),
        line: n.line,
        nodeId: n.id,
        fnKey: t.fnKey,
        aria: `${t.title}: opens its flowchart`,
      });
    else plain.push({ x, y, w: tw, text: t.text, title: t.title, tone: t.tone });
    x += tw + 6;
  }
  return plain;
}

/** Links of a diamond (`if (!(await find(id)))`): left of it, so the chips stay reachable. */
function headTags(
  out: Out,
  key: string,
  tags: Tag[],
  n: PathNode,
  cx: number,
  dw: number,
  dy: number,
  at: FlowNode,
): void {
  if (!tags.length) return;
  const links = tags.filter((t) => t.fnKey);
  if (links.length === 1) {
    // Enter on the diamond follows that call: say so.
    at.fnKey = links[0]!.fnKey;
    at.aria += `. Calls ${linkName(links[0]!)}, Enter opens it`;
  }
  const plain = placeTags(out, key, tags, cx - dw / 2 - 8 - tagsW(tags), dy + (DIA_H - TAG_H) / 2, n);
  if (plain.length) at.tags = plain;
}

/** Head to join, inside the fork (try: without its frame head / finally). */
function measureForkBody(v: Extract<V, { t: "fork" }>, headH: number): number {
  return headH + (v.arms.length ? FORK_GAP + armsRow(v.arms).h : 0) + (v.term ? 0 : JOIN_GAP);
}

/** Characters that fit a box of width `w` beside its count (the epsilon keeps an exact fit uncut). */
const chars = (w: number) => Math.max(4, Math.floor((w - 2 * PAD - COUNT_W) / CH + 1e-6));

/* ------------------------------------------------------------------ entry */

export interface FlowOptions {
  /** Fold / run keys the user opened. */
  open?: ReadonlySet<string>;
}

/** The flowchart of `fn`, or null when the server sent no graph for it. */
export function layoutFlow(payload: PathPayload, fn: PathFn, opts: FlowOptions = {}): FlowLayout | null {
  const a = fn.analysis;
  const g = a?.graph;
  if (!a || a.status !== "ok" || !g) return null;
  const exit = payload.analysis?.exit;
  const ctx: Ctx = {
    decisions: new Map(a.decisions.map((d) => [d.id, d])),
    open: opts.open ?? new Set(),
    exitNode: exit && exit.fnKey === fn.key ? exit.nodeId : undefined,
  };
  const body = lowerList(g.body ?? [g], ctx, false);
  const name = fn.name || "(anonymous)";
  const head: V = {
    t: "pill",
    key: "entry",
    kind: "entry",
    text: `${name} L${fn.startLine ?? fn.line}`,
    full: `${name} at ${fn.file}:${fn.startLine ?? fn.line}`,
    n: g.n,
    aria: `function ${name} at ${fn.file}:${fn.startLine ?? fn.line}: ${
      typeof g.n === "number" ? `called ${times(g.n)}` : `UNKNOWN: ${whyText(g.why)}`
    }`,
  };
  const series: V[] = [head, ...body];
  // Falling off the end: drawn only when the server reports it (it leaves out exits that ran 0 times).
  const end = a.exits.find((e) => e.kind === "end");
  if (end && !measureList(body).term) {
    series.push({
      t: "pill",
      key: "end",
      kind: "end",
      text: "end",
      full: `end of ${name} (falls off the end)`,
      n: end.count,
      aria: `end of the function: ${countPhrase(end.count, end.why)}`,
    });
  }
  const m = measureList(series);
  const out: Out = { nodes: [], edges: [], frames: [], ctx, fn };
  placeList(series, MARGIN + m.l, MARGIN, out, "taken");
  return {
    w: Math.ceil(m.w + 2 * MARGIN),
    h: Math.ceil(m.h + 2 * MARGIN),
    nodes: out.nodes,
    edges: out.edges,
    frames: out.frames,
  };
}

/** Every fold, run and stub key of `fn`'s chart, nested ones included: the `u` key's "unfold all". */
export function allFolds(payload: PathPayload, fn: PathFn): Set<string> {
  const open = new Set<string>();
  // Each pass opens what the last one showed; nesting depth bounds the passes.
  for (let i = 0; i < 64; i++) {
    const l = layoutFlow(payload, fn, { open });
    const add = (l?.nodes ?? []).map((n) => n.toggle).filter((k): k is string => !!k && !open.has(k));
    if (!add.length) break;
    for (const k of add) open.add(k);
  }
  return open;
}

/* --------------------------------------------------------------- keyboard */

export type FlowKey = "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/**
 * The node arrow keys move to: Down / Up in reading order (top-down, arms left to right), Left /
 * Right to the nearest node on that side (row first). Unchanged at an edge.
 */
export function flowNav(nodes: readonly FlowNode[], from: string | null, key: FlowKey): string | null {
  if (!nodes.length) return null;
  const i = nodes.findIndex((n) => n.key === from);
  if (i < 0 || key === "Home") return nodes[0]!.key;
  if (key === "End") return nodes[nodes.length - 1]!.key;
  if (key === "ArrowDown") return nodes[Math.min(nodes.length - 1, i + 1)]!.key;
  if (key === "ArrowUp") return nodes[Math.max(0, i - 1)]!.key;
  const c = nodes[i]!;
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  const dir = key === "ArrowRight" ? 1 : -1;
  let best: FlowNode | undefined;
  let score = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    if (n === c) continue;
    const dx = (n.x + n.w / 2 - cx) * dir;
    if (dx <= 1) continue;
    const s = Math.abs(n.y + n.h / 2 - cy) * 3 + dx;
    if (s < score) {
      score = s;
      best = n;
    }
  }
  return (best ?? c).key;
}

export type FlowAction = { t: "open"; fnKey: string } | { t: "toggle"; key: string } | null;

/** What Enter does on a node: follow its callee link, or open its fold. */
export function flowEnter(n: FlowNode | undefined): FlowAction {
  if (!n) return null;
  if (n.fnKey) return { t: "open", fnKey: n.fnKey };
  if (n.toggle) return { t: "toggle", key: n.toggle };
  return null;
}

/**
 * The node to focus first: `key` when it is drawn (the callee chip followed, on the way back), else
 * the one at `line` (a chip opened the panel), else the entry.
 */
export function flowStart(layout: FlowLayout, line?: number, key?: string): string | null {
  if (key && layout.nodes.some((n) => n.key === key)) return key;
  if (line !== undefined) {
    const at =
      layout.nodes.find((n) => n.kind !== "callee" && n.line === line) ??
      layout.nodes.find((n) => n.line !== undefined && n.endLine !== undefined && n.line <= line && line <= n.endLine);
    if (at) return at.key;
  }
  return layout.nodes[0]?.key ?? null;
}
