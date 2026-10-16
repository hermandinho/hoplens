import type { HopKind, LogRecord, SpanRecord } from "../api/types";
import { type SpanGroup, type SpanTree, isMarker, unionLength } from "./traceview";

/*
 * Pure model for the single-request canvas (Flame and Tree modes): the critical path with idle
 * gaps, the display tree (framework spans folded into one "Next.js" band, same-shape siblings
 * folded into "xN" groups), the Tree flattening, the Flame (icicle) layout and the log ticks.
 * No signals, no DOM: everything here is verified by scratchpad/flame-check.ts.
 */

/* ------------------------------------------------------------ critical path */

/** Spans that ended after the response finished (after(), un-awaited work). Never critical. */
export function isLate(s: SpanRecord): boolean {
  return s.attrs["hoplens.late"] === true;
}

/** One stretch of time the request's end waited on `spanId`'s own work (or its idle time). */
export interface CriticalSegment {
  spanId: string;
  start: number;
  end: number;
}

export interface CriticalPath {
  /** Contiguous, in time order: together they cover [root.start, root.end]. */
  segments: CriticalSegment[];
  /** Every span on the chain, including ones whose whole time is covered by a child. */
  spanIds: ReadonlySet<string>;
  /** Critical ms per span: the time the end of the request was waiting on that span itself. */
  ms: ReadonlyMap<string, number>;
  /** Segments grouped by span, for drawing. */
  bySpan: ReadonlyMap<string, CriticalSegment[]>;
}

const EMPTY_PATH: CriticalPath = { segments: [], spanIds: new Set(), ms: new Map(), bySpan: new Map() };

/**
 * The chain of spans that determines when the request ended. Walking back from the root's end
 * with a cursor: the child running latest before the cursor (its end clipped to the cursor) is the
 * one the parent was waiting on; recurse into it, then move the cursor to its start and repeat.
 * Wherever no child runs before the cursor, the parent itself is on the path (self time or, for
 * the request root, idle time). Children that overlap the chosen one are parallel work the end did
 * not wait for. Markers (zero duration) and late spans are ignored.
 */
export function criticalPath(spans: readonly SpanRecord[]): CriticalPath {
  const timed = spans.filter((s) => !isMarker(s) && !isLate(s));
  if (timed.length === 0) return EMPTY_PATH;
  const ids = new Set(timed.map((s) => s.id));
  const roots: SpanRecord[] = [];
  const children = new Map<string, SpanRecord[]>();
  for (const s of timed) {
    if (s.parentId && s.parentId !== s.id && ids.has(s.parentId)) {
      const list = children.get(s.parentId);
      if (list) list.push(s);
      else children.set(s.parentId, [s]);
    } else roots.push(s);
  }
  const root = roots.reduce((best, s) => (s.end > best.end || (s.end === best.end && s.start < best.start) ? s : best));

  const reversed: CriticalSegment[] = [];
  const onPath = new Set<string>();
  const push = (spanId: string, start: number, end: number) => {
    if (end > start) reversed.push({ spanId, start, end });
  };

  const walk = (span: SpanRecord, until: number, depth: number) => {
    onPath.add(span.id);
    let cursor = Math.min(until, span.end);
    const kids = depth < 200 ? (children.get(span.id) ?? []) : [];
    const used = new Set<string>();
    while (cursor > span.start) {
      let pick: SpanRecord | undefined;
      let pickEnd = Number.NEGATIVE_INFINITY;
      for (const c of kids) {
        if (used.has(c.id) || c.start >= cursor || c.end <= span.start) continue;
        const ce = Math.min(c.end, cursor);
        // Latest (clipped) end wins; on a tie, the one that ends latest overall, then the longest.
        if (
          !pick ||
          ce > pickEnd ||
          (ce === pickEnd && (c.end > pick.end || (c.end === pick.end && c.start < pick.start)))
        ) {
          pick = c;
          pickEnd = ce;
        }
      }
      if (!pick) break;
      used.add(pick.id);
      push(span.id, pickEnd, cursor);
      walk(pick, pickEnd, depth + 1);
      cursor = Math.max(pick.start, span.start);
    }
    push(span.id, span.start, cursor);
  };
  walk(root, root.end, 0);

  const segments = reversed.reverse();
  const ms = new Map<string, number>();
  const bySpan = new Map<string, CriticalSegment[]>();
  for (const seg of segments) {
    ms.set(seg.spanId, (ms.get(seg.spanId) ?? 0) + (seg.end - seg.start));
    const list = bySpan.get(seg.spanId);
    if (list) list.push(seg);
    else bySpan.set(seg.spanId, [seg]);
  }
  return { segments, spanIds: onPath, ms, bySpan };
}

export interface LookHere {
  span: SpanRecord;
  /** Critical ms: time the request's end waited on this span's own work. */
  self: number;
  /** Share of the trace duration, 0..1. */
  share: number;
}

/**
 * "Where to look": the spans the end of the request waited on longest (their critical ms).
 * The request root's own (idle) time and framework glue under 0.5 ms are skipped.
 */
export function whereToLook(spans: readonly SpanRecord[], limit = 3, path = criticalPath(spans)): LookHere[] {
  if (path.segments.length === 0) return [];
  const byId = new Map(spans.map((s) => [s.id, s]));
  let total = 1;
  for (const s of spans) if (!isLate(s) && s.end > total) total = s.end;
  const out: LookHere[] = [];
  for (const [id, ms] of path.ms) {
    const span = byId.get(id);
    if (!span || span.kind === "request" || ms < 0.5) continue;
    out.push({ span, self: ms, share: ms / total });
  }
  return out.sort((a, b) => b.self - a.self).slice(0, limit);
}

/**
 * Idle gaps: stretches inside the request root(s) where no other span runs (the facts' "idle"
 * bucket). Gaps shorter than `minMs` are dropped so the canvas isn't sprinkled with slivers.
 */
export function idleGaps(spans: readonly SpanRecord[], minMs = 0.5): Array<[number, number]> {
  const roots = spans.filter((s) => s.kind === "request" && !isMarker(s));
  if (roots.length === 0) return [];
  const busy = spans
    .filter((s) => s.kind !== "request" && !isMarker(s))
    .map((s): [number, number] => [s.start, s.end])
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of roots) {
    let cursor = r.start;
    for (const [a, b] of busy) {
      if (b <= cursor) continue;
      if (a >= r.end) break;
      if (a > cursor && Math.min(a, r.end) - cursor >= minMs) out.push([cursor, Math.min(a, r.end)]);
      cursor = Math.max(cursor, b);
      if (cursor >= r.end) break;
    }
    if (r.end - cursor >= minMs) out.push([cursor, r.end]);
  }
  return out;
}

/* ------------------------------------------------------------- display tree */

/** Next.js plumbing folded into the "Next.js" band unless it is expanded. */
export const FRAMEWORK_KINDS: ReadonlySet<HopKind> = new Set<HopKind>([
  "request",
  "router",
  "render",
  "response",
  "compile",
]);

export function isFramework(s: SpanRecord): boolean {
  return FRAMEWORK_KINDS.has(s.kind);
}

export const BAND_KEY = "band";

/** Overlap (ms) the Flame lane packer ignores between siblings: span starts are whole-ms (see layout). */
export const LANE_SLOP_MS = 1;

export function groupKey(gid: string): string {
  return `g:${gid}`;
}

export interface BandInfo {
  spans: SpanRecord[];
  start: number;
  end: number;
  /** Wall time the framework spans cover (union). */
  wallMs: number;
}

export type ViewNode =
  | { type: "span"; key: string; start: number; end: number; span: SpanRecord; children: ViewNode[] }
  | { type: "group"; key: string; start: number; end: number; group: SpanGroup; open: boolean; children: ViewNode[] }
  | { type: "band"; key: string; start: number; end: number; band: BandInfo; open: boolean; children: ViewNode[] };

export interface ViewOptions {
  /** Show the framework spans inside the band (false = fold them, lift their children). */
  frameworkOpen: boolean;
  /** Expanded group ids (SpanTree group ids, not node keys). */
  groupsOpen: ReadonlySet<string>;
}

const byStart = (a: SpanRecord, b: SpanRecord) => a.start - b.start || b.end - a.end;

/**
 * Build the display tree. With framework spans present everything hangs under one band node;
 * folded, the band hides the framework spans and their non-framework descendants are lifted to
 * the nearest shown ancestor, so the user's code reads as one tree under "Next.js".
 */
export function buildView(tree: SpanTree, opts: ViewOptions): ViewNode[] {
  const fold = !opts.frameworkOpen;
  const lift = (list: readonly SpanRecord[]): SpanRecord[] => {
    if (!fold || !list.some(isFramework)) return list as SpanRecord[];
    const out: SpanRecord[] = [];
    const visit = (l: readonly SpanRecord[], depth: number) => {
      for (const s of l) {
        if (isFramework(s) && depth < 200) visit(tree.children.get(s.id) ?? [], depth + 1);
        else out.push(s);
      }
    };
    visit(list, 0);
    return out.sort(byStart);
  };

  const list = (spans: readonly SpanRecord[], depth: number): ViewNode[] => {
    const out: ViewNode[] = [];
    const emitted = new Set<string>();
    for (const s of lift(spans)) {
      const gid = tree.memberOf.get(s.id);
      const group = gid ? tree.groups.get(gid) : undefined;
      if (gid && group) {
        if (emitted.has(gid)) continue;
        emitted.add(gid);
        const open = opts.groupsOpen.has(gid);
        out.push({
          type: "group",
          key: groupKey(gid),
          start: group.start,
          end: group.end,
          group,
          open,
          children: open ? group.members.map((m) => spanNode(m, depth + 1)) : [],
        });
        continue;
      }
      out.push(spanNode(s, depth));
    }
    return out;
  };
  const spanNode = (s: SpanRecord, depth: number): ViewNode => ({
    type: "span",
    key: s.id,
    start: s.start,
    end: s.end,
    span: s,
    children: depth < 200 ? list(tree.children.get(s.id) ?? [], depth + 1) : [],
  });

  const fw = [...tree.byId.values()].filter(isFramework);
  if (fw.length === 0) return list(tree.roots, 0);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const s of fw) {
    start = Math.min(start, s.start);
    end = Math.max(end, s.end);
  }
  const band: BandInfo = {
    spans: fw.sort(byStart),
    start,
    end,
    wallMs: unionLength(fw.map((s): [number, number] => [s.start, s.end])),
  };
  return [{ type: "band", key: BAND_KEY, start, end, band, open: opts.frameworkOpen, children: list(tree.roots, 0) }];
}

/** True when the node has something to expand or collapse. */
export function isExpandable(n: ViewNode): boolean {
  if (n.type === "span") return n.children.length > 0;
  return true;
}

/** Whether the node shows its children, given the Tree's collapsed set (spans only). */
export function isOpen(n: ViewNode, collapsed: ReadonlySet<string>): boolean {
  if (n.type === "span") return n.children.length > 0 && !collapsed.has(n.key);
  // The band's children are always the lifted tree; "open" only says whether the framework spans show.
  return n.type === "band" ? true : n.open;
}

export interface ViewRow {
  node: ViewNode;
  depth: number;
}

/** Depth-first rows for Tree mode. A collapsed span hides its subtree. */
export function flattenView(nodes: readonly ViewNode[], collapsed: ReadonlySet<string>): ViewRow[] {
  const out: ViewRow[] = [];
  const visit = (list: readonly ViewNode[], depth: number) => {
    for (const n of list) {
      out.push({ node: n, depth });
      if (n.type === "span" && collapsed.has(n.key)) continue;
      visit(n.children, depth + 1);
    }
  };
  visit(nodes, 0);
  return out;
}

export interface FlameRect {
  node: ViewNode;
  /** Row index from the top. */
  row: number;
}

/**
 * Icicle layout: a node's children go in the rows under it. Siblings that overlap in time
 * (parallel work) are packed into extra lanes (greedy interval partitioning), and each lane gets
 * the height of its deepest subtree, so nothing overlaps and nesting stays readable.
 *
 * Lanes pack by a node's whole visible subtree extent, not its own [start, end]: a child can outlive
 * its parent (an un-awaited fetch under a function span) and is drawn at its real times, so packing
 * by the parent alone would let it collide with the next sibling's subtree in the same lane.
 */
export function layoutFlame(
  nodes: readonly ViewNode[],
  collapsed: ReadonlySet<string>,
): { rects: FlameRect[]; rows: number } {
  const rects: FlameRect[] = [];
  const extents = new Map<ViewNode, { start: number; end: number }>();
  const extent = (n: ViewNode): { start: number; end: number } => {
    let x = extents.get(n);
    if (x) return x;
    x = { start: n.start, end: n.end };
    if (!(n.type === "span" && collapsed.has(n.key))) {
      for (const c of n.children) {
        const cx = extent(c);
        if (cx.start < x.start) x.start = cx.start;
        if (cx.end > x.end) x.end = cx.end;
      }
    }
    extents.set(n, x);
    return x;
  };
  const place = (list: readonly ViewNode[], row0: number): number => {
    if (list.length === 0) return 0;
    const sorted = [...list].sort((a, b) => extent(a).start - extent(b).start || extent(b).end - extent(a).end);
    const lanes: Array<{ end: number; nodes: ViewNode[] }> = [];
    for (const n of sorted) {
      const { start, end } = extent(n);
      // OTel stamps span starts with whole-ms Date.now() while ends carry the fraction, so back-to-back
      // siblings can overlap by under 1ms; that must not open a new lane.
      const lane = lanes.find((l) => l.end <= start + LANE_SLOP_MS);
      if (lane) {
        lane.nodes.push(n);
        lane.end = Math.max(lane.end, end);
      } else lanes.push({ end, nodes: [n] });
    }
    let row = row0;
    for (const lane of lanes) {
      let h = 1;
      for (const n of lane.nodes) {
        rects.push({ node: n, row });
        const hidden = n.type === "span" && collapsed.has(n.key);
        if (!hidden) h = Math.max(h, 1 + place(n.children, row + 1));
      }
      row += h;
    }
    return row - row0;
  };
  const rows = place(nodes, 0);
  return { rects, rows };
}

/* ------------------------------------------------------------- ownership */

/**
 * The visible node that stands for `spanId`: the span's own row, else its folded group, else the
 * band (a folded framework span), else the nearest visible ancestor (a collapsed span).
 */
export function ownerKey(
  tree: SpanTree,
  spanId: string,
  visible: ReadonlySet<string>,
  frameworkOpen: boolean,
): string | undefined {
  let cur = tree.byId.get(spanId);
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (visible.has(cur.id)) return cur.id;
    const gid = tree.memberOf.get(cur.id);
    if (gid && visible.has(groupKey(gid))) return groupKey(gid);
    if (!frameworkOpen && isFramework(cur) && visible.has(BAND_KEY)) return BAND_KEY;
    cur = cur.parentId ? tree.byId.get(cur.parentId) : undefined;
  }
  return visible.has(BAND_KEY) ? BAND_KEY : undefined;
}

/** Map span ids to the visible node keys that show them. */
export function ownersOf(
  tree: SpanTree,
  ids: Iterable<string>,
  visible: ReadonlySet<string>,
  frameworkOpen: boolean,
): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const k = ownerKey(tree, id, visible, frameworkOpen);
    if (k) out.add(k);
  }
  return out;
}

/** Collapsed span keys that hide `spanId` (its ancestors in the collapsed set). */
export function collapsedAncestors(tree: SpanTree, spanId: string, collapsed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let cur = tree.byId.get(spanId);
  let guard = 0;
  while (cur?.parentId && guard++ < 1000) {
    if (collapsed.has(cur.parentId)) out.push(cur.parentId);
    cur = tree.byId.get(cur.parentId);
  }
  return out;
}

/* --------------------------------------------------------------- log ticks */

export interface LogTick {
  t: number;
  level: "warn" | "error";
  text: string;
}

/**
 * warn/error logs as ticks on the span they belong to: the log's own spanId, else the innermost
 * span running at that instant. Returns span id → ticks.
 */
export function logTicks(spans: readonly SpanRecord[], logs: readonly LogRecord[]): Map<string, LogTick[]> {
  const out = new Map<string, LogTick[]>();
  const byId = new Map(spans.map((s) => [s.id, s]));
  for (const l of logs) {
    if (l.level !== "warn" && l.level !== "error") continue;
    let owner = l.spanId ? byId.get(l.spanId) : undefined;
    if (!owner) {
      for (const s of spans) {
        if (s.start <= l.t && l.t <= s.end && (!owner || s.end - s.start < owner.end - owner.start)) owner = s;
      }
    }
    if (!owner) continue;
    const tick: LogTick = { t: l.t, level: l.level, text: l.text };
    const list = out.get(owner.id);
    if (list) list.push(tick);
    else out.set(owner.id, [tick]);
  }
  return out;
}
