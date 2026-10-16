import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { HopKind, LogRecord, SpanRecord, TimeBucket, TraceRecord } from "../api/types";
import {
  canvasMode,
  clearHighlight,
  highlight,
  setHighlight,
  setViewport,
  showCritical,
  viewport,
  zoomRequest,
  zoomTo,
} from "../state/canvas";
import {
  COLD_GAP_LABEL,
  type ColdWait,
  type CriticalSegment,
  type FlameRect,
  type FoldSummary,
  type LogTick,
  type Range,
  type TimeScale,
  type ViewNode,
  type ViewRow,
  buildView,
  clampRange,
  coldWait,
  collapsedAncestors,
  criticalPath,
  flattenView,
  foldSummary,
  handlerRange,
  idleGaps,
  isFramework,
  isLate,
  layoutFlame,
  logTicks,
  makeScale,
  ownerKey,
  ownersOf,
  panRange,
  revealRange,
  searchSpans,
  spanRange,
  zoomRange,
} from "../state/flame";
import { highlightNonce, highlightedSpanIds, selectHop, selectedHopId } from "../state/journey";
import { register } from "../state/keymap";
import { BUCKET_LABELS, fmtMs } from "../state/stats";
import { selectedTrace } from "../state/store";
import { type SpanGroup, bucketOf, buildSpanTree, hidingGroups, selfTimes } from "../state/traceview";
import { Minimap } from "./Minimap";

/**
 * The single-request canvas, in two modes over one display tree (nested by parentId):
 *  - Tree: one indented, collapsible row per span with a time-proportional bar;
 *  - Flame: an icicle where width is duration and children sit in the rows below their parent.
 * Next.js plumbing (request/router/render/response/compile) folds into one "Next.js" band, five or
 * more same-shape siblings fold into an "xN" group striped with the bucket its subtree spends most
 * time in, the critical path is outlined (toggle), idle gaps are hatched and warn/error logs show as
 * ticks. Above the canvas: span search (`/`, n/N), zoom (z, 0, [ ], Ctrl+wheel) and a minimap with
 * a brush. The viewport is a time range (state/canvas `viewport`); a cold trace opens zoomed to the
 * handler, and its untraced wait is drawn compressed when the full range shows.
 * `highlight` (state/canvas) dims every other span to 30% without hiding it.
 */

export function JourneyWaterfall() {
  const trace = selectedTrace.value;
  if (!trace) {
    return (
      <section class="journey-empty" aria-label="Journey waterfall">
        <b>Pick a request from the list</b>
        Then its full waterfall shows up here.
      </section>
    );
  }
  if (trace.spans.length === 0) {
    return (
      <section class="journey-empty" aria-label="Journey waterfall">
        <b>No spans captured yet</b>
        {trace.done
          ? "This request finished without any traced work."
          : "This trace is still streaming — spans will appear as they close."}
      </section>
    );
  }
  // Keyed by trace id so expand/collapse state never leaks between traces.
  return <Canvas key={trace.id} trace={trace} />;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** One `[` / `]` press pans this share of the viewport. */
const PAN_STEP = 0.25;

function Canvas({ trace }: { trace: TraceRecord }) {
  // Every hook is declared here, before any branch, in a fixed order.
  const selected = selectedHopId.value;
  const highlighted = highlightedSpanIds.value;
  const hl = highlight.value;
  const nonce = highlightNonce.value;
  const mode = canvasMode.value;
  const crit = showCritical.value;
  const vpState = viewport.value;
  const zreq = zoomRequest.value;
  const rootRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [groupsOpen, setGroupsOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [frameworkOpen, setFrameworkOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [coldFolded, setColdFolded] = useState(true);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  // Set by n/N: reveal the picked span even inside the one group that holds every match.
  const forceReveal = useRef(false);
  // What the post-render scroll follows: the first highlighted row, or the selection (n/N).
  const scrollTo = useRef<"hl" | "sel">("hl");

  // Span-derived models: rebuilt only when the spans change (a late-span reload replaces the array).
  const tree = useMemo(() => buildSpanTree(trace.spans), [trace.spans]);
  const path = useMemo(() => criticalPath(trace.spans), [trace.spans]);
  const gaps = useMemo(() => idleGaps(trace.spans), [trace.spans]);
  const ticks = useMemo(() => logTicks(trace.spans, trace.logs), [trace.spans, trace.logs]);
  const self = useMemo(() => selfTimes(trace.spans), [trace.spans]);
  const folds = useMemo(() => {
    const out = new Map<string, FoldSummary>();
    for (const g of tree.groups.values()) out.set(g.id, foldSummary(tree, g, self));
    return out;
  }, [tree, self]);
  const total = tree.total;
  const cold = useMemo(() => coldWait(trace.spans, gaps, total), [trace.spans, gaps, total]);
  const handler = useMemo(() => handlerRange(trace.spans, total), [trace.spans, total]);
  const matches = useMemo(() => searchSpans(trace.spans, query), [trace.spans, query]);
  // View-derived models: rebuilt on expand/collapse.
  const view = useMemo(() => buildView(tree, { frameworkOpen, groupsOpen }), [tree, frameworkOpen, groupsOpen]);
  const rows = useMemo(() => flattenView(view, collapsed), [view, collapsed]);
  const visible = useMemo(() => new Set(rows.map((r) => r.node.key)), [rows]);
  const flame = useMemo(() => (mode === "flame" ? layoutFlame(view, collapsed) : null), [mode, view, collapsed]);
  // The minimap always shows the flame shape of the whole trace (Tree mode included).
  const mini = useMemo(() => flame ?? layoutFlame(view, EMPTY_KEYS), [flame, view]);
  const hlKeys = useMemo(
    () => (highlighted.size ? ownersOf(tree, highlighted, visible, frameworkOpen) : EMPTY_KEYS),
    [tree, highlighted, visible, frameworkOpen],
  );
  const miniHl = useMemo(() => {
    if (!highlighted.size) return EMPTY_KEYS;
    const keys = new Set<string>(mini.rects.map((r) => r.node.key));
    return ownersOf(tree, highlighted, keys, frameworkOpen);
  }, [tree, highlighted, mini, frameworkOpen]);
  const critKeys = useMemo(
    () => (crit ? ownersOf(tree, path.spanIds, visible, frameworkOpen) : EMPTY_KEYS),
    [crit, tree, path, visible, frameworkOpen],
  );
  // Critical segments and log ticks are drawn on whichever visible node stands for their span.
  const segsByKey = useMemo(() => {
    const out = new Map<string, CriticalSegment[]>();
    if (!crit) return out;
    for (const seg of path.segments) {
      const k = ownerKey(tree, seg.spanId, visible, frameworkOpen);
      if (!k) continue;
      const list = out.get(k);
      if (list) list.push(seg);
      else out.set(k, [seg]);
    }
    return out;
  }, [crit, path, tree, visible, frameworkOpen]);
  const ticksByKey = useMemo(() => {
    const out = new Map<string, LogTick[]>();
    for (const [spanId, list] of ticks) {
      const k = ownerKey(tree, spanId, visible, frameworkOpen);
      if (!k) continue;
      const cur = out.get(k);
      out.set(k, cur ? cur.concat(list) : list);
    }
    return out;
  }, [ticks, tree, visible, frameworkOpen]);
  // The row that carries the hatched idle gaps in Tree mode: whatever shows the request root.
  const gapKey = useMemo(() => {
    const root = trace.spans.find((s) => s.kind === "request");
    return root ? ownerKey(tree, root.id, visible, frameworkOpen) : undefined;
  }, [trace.spans, tree, visible, frameworkOpen]);

  // Viewport: this trace's stored range, else its default (cold: the handler; otherwise everything).
  const own = vpState?.traceId === trace.id ? vpState : null;
  const range: Range = own ? clampRange(own.range ?? [0, total], total) : cold && handler ? handler : [0, total];
  const zoomed = range[0] > 0 || range[1] < total;
  const fold = cold?.gap && coldFolded ? cold.gap : undefined;
  const scale = makeScale(range[0], range[1], fold);
  const fullScale = makeScale(0, total, fold);

  const setRange = (r: Range | null) => {
    const c = r ? clampRange(r, total) : null;
    setViewport(trace.id, c && (c[0] > 0 || c[1] < total) ? c : undefined);
  };

  const toggleNode = (n: ViewNode, open?: boolean) => {
    if (n.type === "band") {
      setFrameworkOpen((v) => open ?? !v);
      return;
    }
    if (n.type === "group") {
      if (open === undefined || open !== n.open) setGroupsOpen((prev) => toggled(prev, n.group.id));
      return;
    }
    if (n.children.length === 0) return;
    if (open === undefined || open === collapsed.has(n.key)) setCollapsed((prev) => toggled(prev, n.key));
  };

  // A span picked elsewhere (Inspector, finding chip) that is hidden gets revealed: its folded
  // group opens, the band opens for a framework span, collapsed ancestors expand. Exception: when
  // every highlighted span is in that one group (the N+1 case), the group row itself is the answer
  // (unless n/N picked the span). Only selection changes trigger this, so a user folding things
  // again is respected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state is read, not a trigger
  useEffect(() => {
    const force = forceReveal.current;
    forceReveal.current = false;
    if (!selected || visible.has(selected)) return;
    const hiding = hidingGroups(tree, selected).filter((g) => !groupsOpen.has(g));
    if (
      !force &&
      highlighted.size > 1 &&
      hiding.length > 0 &&
      hiding.every((g) => groupCoversAll(tree.groups.get(g), highlighted))
    )
      return;
    if (hiding.length > 0) setGroupsOpen((prev) => new Set([...prev, ...hiding]));
    const span = tree.byId.get(selected);
    if (span && isFramework(span) && !frameworkOpen) setFrameworkOpen(true);
    const anc = collapsedAncestors(tree, selected, collapsed);
    if (anc.length > 0)
      setCollapsed((prev) => {
        const next = new Set(prev);
        for (const k of anc) next.delete(k);
        return next;
      });
  }, [selected, tree]);

  // Scroll the first highlighted row into view after a highlight request (finding chip, verdict,
  // search). A group that opens in response re-renders the rows, so keep following for a short
  // window, then stop so later manual expands don't yank the scroll position.
  const scrollUntil = useRef(0);
  useEffect(() => {
    if (nonce > 0 || hl) {
      scrollTo.current = "hl";
      scrollUntil.current = Date.now() + 500;
    }
  }, [nonce, hl]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when rows change, read the DOM
  useEffect(() => {
    if (Date.now() > scrollUntil.current) return;
    const sel = scrollTo.current === "sel" ? ".selected" : ".wf-hl";
    const el = rootRef.current?.querySelector<HTMLElement>(`.waterfall-rows ${sel}, .fl-canvas ${sel}`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [nonce, hl, rows, mode, selected, range[0], range[1]]);

  // zoomTo() (contract 4.1): requests made after this canvas mounted.
  const seenSeq = useRef(zreq.seq);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request is a trigger
  useEffect(() => {
    if (zreq.seq === seenSeq.current) return;
    seenSeq.current = zreq.seq;
    const t = zreq.target;
    if (t === null) setRange(null);
    else if (t === "handler") setRange(handler);
    else {
      const r = spanRange(tree, t, total);
      if (r) setRange(r);
    }
  }, [zreq]);

  // Span search: matches are the highlight while a query is typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: matches already depends on query
  useEffect(() => {
    const q = query.trim();
    if (q) setHighlight(matches, `search:${q}`);
    else if (highlight.peek()?.reason.startsWith("search:")) clearHighlight();
  }, [matches]);
  // Another highlight (finding, verdict) replaces the search: drop the stale query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the highlight is a trigger
  useEffect(() => {
    if (hl && !hl.reason.startsWith("search:") && query) {
      setQuery("");
      setCursor(-1);
    }
  }, [hl]);

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    const i = cursor < 0 ? (dir > 0 ? 0 : matches.length - 1) : (cursor + dir + matches.length) % matches.length;
    const id = matches[i] as string;
    setCursor(i);
    forceReveal.current = true;
    scrollTo.current = "sel";
    scrollUntil.current = Date.now() + 500;
    selectHop(id);
    const s = tree.byId.get(id);
    if (s && zoomed) {
      const r = revealRange(range, s.start, s.end, total);
      if (r[0] !== range[0] || r[1] !== range[1]) setRange(r);
    }
  };

  // Keys (plan 3.9). Handlers read the latest render through a ref, so they register once.
  const live = useRef({ step, setRange, range, total, selected });
  live.current = { step, setRange, range, total, selected };
  useEffect(() => {
    const L = () => live.current;
    const hasQuery = () => !!searchRef.current?.value.trim();
    const offs = [
      register("trace", "z", "Zoom to the selected span (or the handler)", () => zoomTo(L().selected ?? "handler")),
      register("trace", "0", "Reset zoom: full range", () => zoomTo(null)),
      register("canvas", "[", "Pan the canvas earlier", () => L().setRange(panRange(L().range, -PAN_STEP, L().total))),
      register("canvas", "]", "Pan the canvas later", () => L().setRange(panRange(L().range, PAN_STEP, L().total))),
      register("canvas", "/", "Search spans", () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      }),
      register("canvas", "n", "Next span match", () => L().step(1), { when: hasQuery }),
      register("canvas", "N", "Previous span match", () => L().step(-1), { when: hasQuery }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  // Keyboard: Up/Down move between nodes (depth-first, both modes) and select spans; Right/Left
  // expand/collapse the focused node. Focus moves with the selection so screen readers follow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: toggleNode closes over the current state
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      if ((ev.target as HTMLElement | null)?.tagName === "INPUT") return;
      const active = document.activeElement as HTMLElement | null;
      const focusedKey = active?.closest<HTMLElement>("[data-key]")?.dataset.key;
      const order = rows.map((r) => r.node);
      const current = order.findIndex((n) => n.key === (focusedKey ?? selected));
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        const node = order[current];
        if (!node) return;
        ev.preventDefault();
        toggleNode(node, ev.key === "ArrowRight");
        return;
      }
      const next = ev.key === "ArrowDown" ? Math.min(order.length - 1, current + 1) : Math.max(0, current - 1);
      const node = order[next];
      if (!node || next === current) return;
      ev.preventDefault();
      if (node.type === "span") selectHop(node.span.id);
      focusKey(el, node.key);
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [rows, selected, collapsed]);

  // Ctrl/Cmd + wheel zooms around the pointer; a plain wheel still scrolls.
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const col = (e.target as HTMLElement | null)?.closest<HTMLElement>(".waterfall-bar-col, .fl-canvas");
    if (!col) return;
    e.preventDefault();
    const r = col.getBoundingClientRect();
    const f = (e.clientX - r.left) / Math.max(1, r.width);
    setRange(zoomRange(range, e.deltaY > 0 ? 1.25 : 0.8, scale.invert(f), total));
  };

  const ttfb = trace.facts?.ttfb;
  const fill = (n: ViewNode): TimeBucket => nodeFill(n, folds);
  const ctx: DrawCtx = {
    scale,
    selected,
    hlKeys,
    critKeys,
    segsByKey,
    ticksByKey,
    gapKey,
    gaps,
    cold,
    folds,
    critMs: path.ms,
    onToggle: toggleNode,
  };
  const hlOn = highlighted.size > 0;

  return (
    <section
      ref={rootRef}
      class={`waterfall tc-${mode} ${crit ? "tc-crit-on" : ""} ${hlOn ? "tc-hl-on" : ""}`}
      aria-label={mode === "flame" ? "Flame graph" : "Span tree"}
      data-key-scope="canvas"
      onWheel={onWheel}
    >
      <div class="tc-sticky">
        <div class="tc-toolbar">
          <label class="tc-search">
            <span class="sr-only">Search spans</span>
            <input
              ref={searchRef}
              type="search"
              class="tc-search-input mono"
              placeholder="Search spans  /"
              value={query}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setCursor(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  step(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                  setCursor(-1);
                  e.currentTarget.blur();
                }
              }}
            />
          </label>
          {query.trim() && (
            <span class="tc-search-count mono" aria-live="polite">
              {matches.length === 0
                ? "no match"
                : `${cursor >= 0 ? cursor + 1 : "–"}/${matches.length} match${matches.length === 1 ? "" : "es"}`}
            </span>
          )}
          {query.trim() && matches.length > 0 && (
            <span class="tc-btns">
              <button
                type="button"
                class="chip tc-btn"
                onClick={() => step(-1)}
                title="Previous match (N, Shift+Enter)"
              >
                ↑
              </button>
              <button type="button" class="chip tc-btn" onClick={() => step(1)} title="Next match (n, Enter)">
                ↓
              </button>
            </span>
          )}
          {cold && (
            <ColdNote
              cold={cold}
              zoomed={zoomed}
              folded={coldFolded}
              range={range}
              onShowAll={() => setRange(null)}
              onToggleFold={() => setColdFolded((v) => !v)}
            />
          )}
          <span class="tc-btns tc-zoom">
            {zoomed && (
              <span class="tc-zoom-range mono dim">
                {fmtMs(range[0])}–{fmtMs(range[1])}
              </span>
            )}
            <button
              type="button"
              class="chip tc-btn"
              onClick={() => setRange(panRange(range, -PAN_STEP, total))}
              disabled={range[0] <= 0}
              title="Pan earlier ([)"
            >
              <kbd>[</kbd>
            </button>
            <button
              type="button"
              class="chip tc-btn"
              onClick={() => setRange(panRange(range, PAN_STEP, total))}
              disabled={range[1] >= total}
              title="Pan later (])"
            >
              <kbd>]</kbd>
            </button>
            <button
              type="button"
              class="chip tc-btn"
              onClick={() => zoomTo(selected ?? "handler")}
              title="Zoom to the selected span, or the handler (z). Ctrl+wheel zooms too."
            >
              <kbd>z</kbd> Zoom
            </button>
            <button
              type="button"
              class={`chip tc-btn ${zoomed ? "" : "chip-active"}`}
              onClick={() => zoomTo(null)}
              aria-pressed={!zoomed}
              title="Full range (0)"
            >
              <kbd>0</kbd> All
            </button>
          </span>
        </div>
        <Minimap
          rects={mini.rects}
          rows={mini.rows}
          scale={fullScale}
          view={range}
          total={total}
          hlKeys={miniHl}
          fill={fill}
          onRange={setRange}
        />
        {mode === "flame" ? (
          <header class="waterfall-head fl-head">
            <div class="waterfall-bar-col">
              <Axis scale={scale} ttfb={ttfb} />
            </div>
          </header>
        ) : (
          <header class="waterfall-head">
            <div class="waterfall-name-col">Span</div>
            <div class="waterfall-bar-col">
              <Axis scale={scale} ttfb={ttfb} />
            </div>
          </header>
        )}
      </div>
      {mode === "flame" && flame ? (
        <>
          <FlameCanvas rects={flame.rects} rows={flame.rows} ctx={ctx} />
          <FlameSelection trace={trace} />
        </>
      ) : (
        <ul class="waterfall-rows">
          {rows.map((r) => (
            <TreeRow key={r.node.key} row={r} ctx={ctx} logs={trace.logs} collapsed={collapsed} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface DrawCtx {
  scale: TimeScale;
  selected: string | null;
  hlKeys: ReadonlySet<string>;
  critKeys: ReadonlySet<string>;
  segsByKey: ReadonlyMap<string, CriticalSegment[]>;
  ticksByKey: ReadonlyMap<string, LogTick[]>;
  gapKey: string | undefined;
  gaps: ReadonlyArray<Range>;
  cold: ColdWait | null;
  folds: ReadonlyMap<string, FoldSummary>;
  critMs: ReadonlyMap<string, number>;
  onToggle: (n: ViewNode, open?: boolean) => void;
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function focusKey(root: HTMLElement, key: string): void {
  const host = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  const target = host instanceof HTMLButtonElement ? host : host?.querySelector<HTMLElement>(":scope > button");
  target?.focus();
  target?.scrollIntoView({ block: "nearest" });
}

function groupCoversAll(g: SpanGroup | undefined, ids: ReadonlySet<string>): boolean {
  if (!g) return false;
  const members = new Set(g.members.map((m) => m.id));
  for (const id of ids) if (!members.has(id)) return false;
  return true;
}

/* ------------------------------------------------------------- placement */

/** A box's visible extent across the viewport (0..1), or null when it is entirely outside. */
interface Box {
  x0: number;
  x1: number;
}

function boxOf(scale: TimeScale, a: number, b: number): Box | null {
  const x0 = scale.x(a);
  const x1 = scale.x(Math.max(a, b));
  if (x1 < 0 || x0 > 1) return null;
  return { x0: Math.max(0, x0), x1: Math.min(1, x1) };
}

function boxStyle(b: Box, minPct = 0.3) {
  return { left: `${b.x0 * 100}%`, width: `${Math.max(minPct, (b.x1 - b.x0) * 100)}%` };
}

/** left/width of [a, b] inside `box` (percent of the box), or null when outside it. */
function relStyle(scale: TimeScale, box: Box, a: number, b: number, minPct = 0.4) {
  const w = Math.max(1e-9, box.x1 - box.x0);
  const l = (scale.x(a) - box.x0) / w;
  const r = (scale.x(Math.max(a, b)) - box.x0) / w;
  if (r < 0 || l > 1) return null;
  const cl = Math.max(0, l);
  return { left: `${cl * 100}%`, width: `${Math.max(minPct, (Math.min(1, r) - cl) * 100)}%` };
}

/** left of instant `t` inside `box` (percent of the box), clamped to its edges. */
function relLeft(scale: TimeScale, box: Box, t: number): string {
  const w = Math.max(1e-9, box.x1 - box.x0);
  const f = (scale.x(t) - box.x0) / w;
  return `${Math.min(1, Math.max(0, f)) * 100}%`;
}

const FULL_BOX: Box = { x0: 0, x1: 1 };

function indentPx(depth: number): string {
  return `${12 + Math.min(depth, 10) * 14}px`;
}

/** Fill bucket: folded groups take the bucket their subtree spends most time in. */
function nodeFill(n: ViewNode, folds: ReadonlyMap<string, FoldSummary>): TimeBucket {
  if (n.type === "band") return "framework";
  if (n.type === "group") return folds.get(n.group.id)?.bucket ?? bucketOf(n.group.members[0] as SpanRecord);
  return bucketOf(n.span);
}

function nodeKind(n: ViewNode): HopKind | "next" {
  if (n.type === "band") return "next";
  return n.type === "span" ? n.span.kind : n.group.kind;
}

/** "→ pg.query" when a folded group's time is mostly in its children (the ms are in the tooltip). */
function foldNote(f: FoldSummary | undefined): string | undefined {
  if (!f?.top) return undefined;
  return `→ ${f.top}`;
}

function nodeTitle(n: ViewNode, ctx: DrawCtx): string {
  if (n.type === "band") {
    const k = n.band.spans.length;
    return `Next.js: ${k} framework span${k === 1 ? "" : "s"} (request, routing, compile, render, response), ${fmtMs(n.band.wallMs)} wall.\nClick to ${n.open ? "fold them" : "show them"}.`;
  }
  if (n.type === "group") {
    const g = n.group;
    const f = ctx.folds.get(g.id);
    const mostly = f ? `\nMostly ${BUCKET_LABELS[f.bucket]}: ${fmtMs(f.ms)}${f.top ? ` in ${f.top}` : ""}` : "";
    return `${g.members.length} calls with the same shape. Sum ${fmtMs(g.sumMs)}, wall ${fmtMs(g.wallMs)}.${mostly}\n${g.label}\nClick to ${n.open ? "collapse" : "expand"}.`;
  }
  const s = n.span;
  const c = ctx.critMs.get(s.id);
  const crit = c ? `\nCritical path: the end waited ${fmtMs(c)} on this span itself` : "";
  const late = isLate(s) ? "\nLate: ended after the response finished" : "";
  return `${s.name}\n${BUCKET_LABELS[bucketOf(s)]} · ${fmtMs(s.end - s.start)} at +${fmtMs(s.start)}${crit}${late}`;
}

/* ------------------------------------------------------------- toolbar */

function ColdNote({
  cold,
  zoomed,
  folded,
  range,
  onShowAll,
  onToggleFold,
}: {
  cold: ColdWait;
  zoomed: boolean;
  folded: boolean;
  range: Range;
  onShowAll: () => void;
  onToggleFold: () => void;
}) {
  const wait = cold.handlerStart - cold.start;
  const gapMs = cold.gap ? cold.gap[1] - cold.gap[0] : 0;
  // Zoomed past most of the wait (the cold default view): say what is hidden.
  if (zoomed && range[0] > cold.start + wait / 2) {
    return (
      <span class="tc-cold-note" title={`Cold request: ${fmtMs(gapMs)} of the wait is ${COLD_GAP_LABEL}`}>
        <span class="tc-cold-swatch" aria-hidden="true" />
        From the handler: {fmtMs(wait)} wait before it hidden
        <button type="button" class="chip tc-btn" onClick={onShowAll}>
          Show all
        </button>
      </span>
    );
  }
  if (!cold.gap || zoomed) return null;
  return (
    <span class="tc-cold-note" title={COLD_GAP_LABEL}>
      <span class="tc-cold-swatch" aria-hidden="true" />
      {fmtMs(gapMs)} untraced wait {folded ? "drawn compressed" : "at true scale"}
      <button type="button" class="chip tc-btn" onClick={onToggleFold} aria-pressed={!folded}>
        {folded ? "True scale" : "Compress"}
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ axis */

function Axis({ scale, ttfb }: { scale: TimeScale; ttfb: number | undefined }) {
  // The dashed TTFB mark would strike through a tick label it lands on (usually the end one: an API
  // route's TTFB is ~100% of the trace). Hide that label; the mark's tooltip carries the time.
  const f = ttfb !== undefined ? scale.x(ttfb) : -1;
  const showTtfb = ttfb !== undefined && f >= 0 && f <= 1;
  const hideMid = showTtfb && Math.abs(f - 0.5) < 0.06;
  const hideEnd = showTtfb && f >= 0.85;
  const fold = scale.fold;
  return (
    <>
      <span class="waterfall-tick">{scale.start <= 0 ? "0" : fmtMs(scale.start)}</span>
      <span class="waterfall-tick" style={hideMid ? { visibility: "hidden" } : undefined}>
        {fmtMs(scale.invert(0.5))}
      </span>
      <span class="waterfall-tick" style={hideEnd ? { visibility: "hidden" } : undefined}>
        {fmtMs(scale.end)}
      </span>
      {fold && (
        <span
          class="tc-axis-break"
          style={{ left: `${scale.x(fold.a) * 100}%`, width: `${fold.share * 100}%` }}
          title={`${fmtMs(fold.b - fold.a)} drawn compressed: ${COLD_GAP_LABEL}`}
        />
      )}
      {showTtfb && ttfb !== undefined && (
        <span class="wf-ttfb-mark" style={{ left: `${f * 100}%` }} title={`TTFB ${fmtMs(ttfb)}`} />
      )}
    </>
  );
}

/* ------------------------------------------------------------- overlays */

function GapHatches({
  gaps,
  scale,
  cold,
  labelled,
}: {
  gaps: ReadonlyArray<Range>;
  scale: TimeScale;
  cold: ColdWait | null;
  /** Spell out the cold label (Flame: the overlay has the height for it). */
  labelled?: boolean;
}) {
  return (
    <>
      {gaps.map(([a, b]) => {
        const box = boxOf(scale, a, b);
        if (!box) return null;
        const isCold = !!cold?.gap && a <= cold.gap[0] && b >= cold.gap[1] - 1e-6;
        if (isCold) {
          return (
            <span
              key={`${a}-${b}`}
              class="tc-gap tc-cold"
              style={boxStyle(box)}
              title={`${fmtMs(b - a)} before the handler: ${COLD_GAP_LABEL}. Nothing traced ran here.`}
            >
              <span class="tc-cold-label">
                <b>{fmtMs(b - a)} untraced</b>
                {labelled && <span> {COLD_GAP_LABEL}</span>}
              </span>
            </span>
          );
        }
        return (
          <span
            key={`${a}-${b}`}
            class="tc-gap"
            style={boxStyle(box)}
            title={`Idle ${fmtMs(b - a)}: no captured span was running`}
          />
        );
      })}
    </>
  );
}

/** Critical segments as a strip inside `box`. */
function CritStrip({ segs, scale, box }: { segs: readonly CriticalSegment[]; scale: TimeScale; box: Box }) {
  return (
    <>
      {segs.map((s) => {
        const st = relStyle(scale, box, s.start, s.end, 0.3);
        return st ? <span key={`${s.spanId}-${s.start}`} class="tc-crit-seg" style={st} /> : null;
      })}
    </>
  );
}

function Ticks({ ticks, scale, box }: { ticks: readonly LogTick[]; scale: TimeScale; box: Box }) {
  return (
    <>
      {ticks.slice(0, 50).map((t, i) => {
        const x = scale.x(t.t);
        if (x < box.x0 - 1e-9 || x > box.x1 + 1e-9) return null;
        return (
          <span
            key={`${t.t}-${i}`}
            class={`tc-tick tc-tick-${t.level}`}
            style={{ left: relLeft(scale, box, t.t) }}
            title={`${t.level} at +${fmtMs(t.t)}: ${t.text.slice(0, 200)}`}
          />
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------- tree mode */

function TreeRow({
  row,
  ctx,
  logs,
  collapsed,
}: {
  row: ViewRow;
  ctx: DrawCtx;
  logs: LogRecord[];
  collapsed: ReadonlySet<string>;
}) {
  const { node: n, depth } = row;
  const { scale } = ctx;
  const span = n.type === "span" ? n.span : undefined;
  const selected = !!span && ctx.selected === n.key;
  const hasError = span ? !!span.error : n.type === "group" ? n.group.errored > 0 : false;
  const late = !!span && isLate(span);
  const expandable = n.type !== "span" || n.children.length > 0;
  const open = n.type === "span" ? !collapsed.has(n.key) : n.open;
  const segs = ctx.segsByKey.get(n.key);
  const ticks = ctx.ticksByKey.get(n.key);
  const kind = nodeKind(n);
  const fold = n.type === "group" ? ctx.folds.get(n.group.id) : undefined;
  const note = foldNote(fold);
  const spanBox = span ? boxOf(scale, span.start, span.end) : null;

  const scoped =
    span && hasError ? logs.filter((l) => l.spanId === span.id || (l.t >= span.start && l.t <= span.end)) : [];

  const cls = [
    "waterfall-row",
    n.type === "group" ? "wf-group" : "",
    n.type === "band" ? "tc-band-row" : "",
    selected ? "selected" : "",
    hasError ? "jw-row-err" : "",
    ctx.hlKeys.has(n.key) ? "wf-hl" : "",
    ctx.critKeys.has(n.key) ? "tc-crit" : "",
    late ? "tc-late" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li class="waterfall-row-li" data-key={n.key} data-span-id={span?.id}>
      <button
        type="button"
        class={cls}
        aria-pressed={span ? selected : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={() => (span ? selectHop(span.id) : ctx.onToggle(n))}
        title={nodeTitle(n, ctx)}
      >
        <div class="waterfall-name-col" style={{ paddingLeft: indentPx(depth) }}>
          {expandable ? (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users expand with ArrowRight/ArrowLeft on the row
            <span
              class="wf-group-caret tc-caret"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                ctx.onToggle(n);
              }}
            >
              {open ? "▾" : "▸"}
            </span>
          ) : (
            <span class="tc-caret-pad" aria-hidden="true" />
          )}
          <span class={`jw-kind-pill jw-kind-${kind}`}>{kindLabel(kind)}</span>
          {n.type === "group" && <span class="wf-group-count mono">×{n.group.members.length}</span>}
          <span class="jw-span-name">{span ? span.name : n.type === "group" ? n.group.label : "Next.js"}</span>
          {note && <span class={`tc-fold-note mono fold-${fold?.bucket}`}>{note}</span>}
          {n.type === "band" && (
            <span class="tc-band-note dim">
              {n.band.spans.length} span{n.band.spans.length === 1 ? "" : "s"}
              {n.open ? "" : ", folded"}
            </span>
          )}
          {late && <span class="tc-late-tag">late</span>}
        </div>
        <div class="waterfall-bar-col tc-clip">
          {ctx.gapKey === n.key && <GapHatches gaps={ctx.gaps} scale={scale} cold={ctx.cold} />}
          {span && spanBox && (
            <div class={`jw-bar b-${bucketOf(span)}`} style={boxStyle(spanBox)}>
              <span class="jw-bar-label">{fmtMs(span.end - span.start)}</span>
            </div>
          )}
          {n.type === "group" && <GroupTrack group={n.group} fold={fold} scale={scale} />}
          {n.type === "band" && <BandTrack node={n} scale={scale} />}
          {segs && (
            <span class="tc-crit-track" aria-hidden="true">
              <CritStrip segs={segs} scale={scale} box={FULL_BOX} />
            </span>
          )}
          {ticks && <Ticks ticks={ticks} scale={scale} box={FULL_BOX} />}
        </div>
      </button>
      {scoped.length > 0 && (
        <fieldset class="wf-logs">
          <legend class="wf-logs-head">Logs during this failing step ({scoped.length})</legend>
          {scoped.map((log, i) => (
            <div key={`${log.t}-${i}`} class={`wf-log-line level-${log.level}`}>
              <span class="wf-log-time">+{Math.round(log.t)}ms</span>
              <span class={`console-level level-${log.level}`}>{log.level}</span>
              <span class="wf-log-text">{log.text}</span>
            </div>
          ))}
        </fieldset>
      )}
    </li>
  );
}

/** At most this many member ticks are drawn inside a group or band bar. */
const MAX_TICKS = 200;

function GroupTrack({ group: g, fold, scale }: { group: SpanGroup; fold: FoldSummary | undefined; scale: TimeScale }) {
  const box = boxOf(scale, g.start, g.end);
  if (!box) return null;
  const bucket = fold?.bucket ?? bucketOf(g.members[0] as SpanRecord);
  return (
    <div class="wf-group-track" style={boxStyle(box)}>
      {g.members.slice(0, MAX_TICKS).map((m) => {
        const st = relStyle(scale, box, m.start, m.end);
        return st ? <span key={m.id} class={`wf-group-tick tc-fold b-${bucket}`} style={st} /> : null;
      })}
      <span
        class="jw-bar-label wf-group-label"
        title={`${fmtMs(g.wallMs)} from the first call's start to the last call's end; ${fmtMs(g.sumMs)} summed over the ${g.members.length} calls`}
      >
        {fmtMs(g.wallMs)}
        {g.sumMs > g.wallMs * 1.1 ? ` (${fmtMs(g.sumMs)} summed, overlapping)` : ""}
      </span>
    </div>
  );
}

function BandTrack({ node, scale }: { node: Extract<ViewNode, { type: "band" }>; scale: TimeScale }) {
  const b = node.band;
  const box = boxOf(scale, b.start, b.end);
  if (!box) return null;
  return (
    <div class="wf-group-track tc-band-track" style={boxStyle(box)}>
      {b.spans.slice(0, MAX_TICKS).map((s) => {
        const st = relStyle(scale, box, s.start, s.end);
        return st ? <span key={s.id} class={`wf-group-tick b-${bucketOf(s)}`} style={st} /> : null;
      })}
    </div>
  );
}

/* ------------------------------------------------------------ flame mode */

const ROW_H = 22;

function FlameCanvas({ rects, rows, ctx }: { rects: FlameRect[]; rows: number; ctx: DrawCtx }) {
  return (
    <div class="fl-canvas" style={{ height: `${Math.max(1, rows) * ROW_H}px` }}>
      {/* Idle gaps run the full height under the top row: nothing captured ran there. */}
      <div class="fl-gaps" style={{ top: `${ROW_H}px` }}>
        <GapHatches gaps={ctx.gaps} scale={ctx.scale} cold={ctx.cold} labelled />
      </div>
      {rects.map((r) => (
        <FlameBox key={r.node.key} rect={r} ctx={ctx} />
      ))}
    </div>
  );
}

function FlameBox({ rect, ctx }: { rect: FlameRect; ctx: DrawCtx }) {
  const n = rect.node;
  const box = boxOf(ctx.scale, n.start, n.end);
  // Culled: nothing of it is inside the viewport.
  if (!box) return null;
  const span = n.type === "span" ? n.span : undefined;
  const selected = !!span && ctx.selected === n.key;
  const hasError = span ? !!span.error : n.type === "group" ? n.group.errored > 0 : false;
  const segs = ctx.segsByKey.get(n.key);
  const ticks = ctx.ticksByKey.get(n.key);
  const fold = n.type === "group" ? ctx.folds.get(n.group.id) : undefined;
  const note = foldNote(fold);
  const label = span
    ? span.name
    : n.type === "group"
      ? `×${n.group.members.length} ${n.group.label}${note ? ` ${note}` : ""}`
      : "Next.js";
  const cls = [
    "fl-rect",
    `b-${nodeFill(n, ctx.folds)}`,
    n.type === "group" ? "fl-group tc-fold" : "",
    n.type === "band" ? "fl-band" : "",
    selected ? "selected" : "",
    hasError ? "fl-err" : "",
    ctx.hlKeys.has(n.key) ? "wf-hl" : "",
    ctx.critKeys.has(n.key) ? "tc-crit" : "",
    span && isLate(span) ? "tc-late" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      data-key={n.key}
      data-span-id={span?.id}
      class={cls}
      style={{ ...boxStyle(box), top: `${rect.row * ROW_H}px`, height: `${ROW_H - 2}px` }}
      aria-pressed={span ? selected : undefined}
      aria-expanded={n.type === "span" ? undefined : n.open}
      aria-label={`${label}, ${fmtMs(n.end - n.start)}`}
      title={nodeTitle(n, ctx)}
      onClick={() => (span ? selectHop(span.id) : ctx.onToggle(n))}
    >
      <span class="fl-label">
        {label} <span class="fl-ms">{fmtMs(n.end - n.start)}</span>
      </span>
      {segs && <CritStrip segs={segs} scale={ctx.scale} box={box} />}
      {ticks && <Ticks ticks={ticks} scale={ctx.scale} box={box} />}
    </button>
  );
}

/** Flame mode has no rows to hang the snippet on: show the selected span's code under the canvas. */
function FlameSelection({ trace }: { trace: TraceRecord }) {
  const id = selectedHopId.value;
  const span = id ? trace.spans.find((s) => s.id === id) : undefined;
  if (!span)
    return (
      <p class="fl-hint dim">
        Click a box: its details open in the Span tab below. Arrow keys move between spans; z zooms, 0 resets.
      </p>
    );
  return (
    <div class="fl-selection">
      <div class="fl-selection-head">
        <span class={`jw-kind-pill jw-kind-${span.kind}`}>{kindLabel(span.kind)}</span>
        <span class="jw-span-name mono">{span.name}</span>
        <span class="dim mono">
          {fmtMs(span.end - span.start)} at +{fmtMs(span.start)}
        </span>
      </div>
    </div>
  );
}

const KIND_LABELS: Record<HopKind | "next", string> = {
  request: "REQ",
  proxy: "PRX",
  router: "ROU",
  handler: "HDL",
  response: "RES",
  function: "FN",
  fetch: "FTC",
  db: "DB",
  render: "RND",
  custom: "·",
  compile: "CMP",
  next: "NEXT",
};

function kindLabel(k: HopKind | "next"): string {
  return KIND_LABELS[k] ?? "·";
}
