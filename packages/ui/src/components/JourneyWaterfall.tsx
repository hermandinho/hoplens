import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { HopKind, LogRecord, SpanRecord, TimeBucket, TraceRecord } from "../api/types";
import { canvasMode, showCritical } from "../state/canvas";
import {
  type CriticalSegment,
  type FlameRect,
  type LogTick,
  type ViewNode,
  type ViewRow,
  buildView,
  collapsedAncestors,
  criticalPath,
  flattenView,
  idleGaps,
  isFramework,
  isLate,
  layoutFlame,
  logTicks,
  ownerKey,
  ownersOf,
} from "../state/flame";
import { highlightNonce, highlightedSpanIds, selectHop, selectedHopId } from "../state/journey";
import { BUCKET_LABELS, fmtMs } from "../state/stats";
import { selectedTrace } from "../state/store";
import { type SpanGroup, bucketOf, buildSpanTree, hidingGroups } from "../state/traceview";
import { SpanSnippet } from "./SpanSnippet";

/**
 * The single-request canvas, in two modes over one display tree (nested by parentId):
 *  - Tree: one indented, collapsible row per span with a time-proportional bar;
 *  - Flame: an icicle where width is duration and children sit in the rows below their parent.
 * Next.js plumbing (request/router/render/response/compile) folds into one "Next.js" band, five or
 * more same-shape siblings fold into an "xN" group, the critical path is outlined (toggle), idle
 * gaps are hatched and warn/error logs show as ticks. Finding chips highlight their spans here.
 */

export function JourneyWaterfall() {
  const trace = selectedTrace.value;
  if (!trace) {
    return (
      <section class="journey-empty" aria-label="Journey waterfall">
        <b>Pick a request from the sidebar</b>
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

function Canvas({ trace }: { trace: TraceRecord }) {
  // Every hook is declared here, before any branch, in a fixed order.
  const selected = selectedHopId.value;
  const highlighted = highlightedSpanIds.value;
  const nonce = highlightNonce.value;
  const mode = canvasMode.value;
  const crit = showCritical.value;
  const rootRef = useRef<HTMLElement | null>(null);
  const [groupsOpen, setGroupsOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [frameworkOpen, setFrameworkOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // Span-derived models: rebuilt only when the spans change (a late-span reload replaces the array).
  const tree = useMemo(() => buildSpanTree(trace.spans), [trace.spans]);
  const path = useMemo(() => criticalPath(trace.spans), [trace.spans]);
  const gaps = useMemo(() => idleGaps(trace.spans), [trace.spans]);
  const ticks = useMemo(() => logTicks(trace.spans, trace.logs), [trace.spans, trace.logs]);
  // View-derived models: rebuilt on expand/collapse.
  const view = useMemo(() => buildView(tree, { frameworkOpen, groupsOpen }), [tree, frameworkOpen, groupsOpen]);
  const rows = useMemo(() => flattenView(view, collapsed), [view, collapsed]);
  const visible = useMemo(() => new Set(rows.map((r) => r.node.key)), [rows]);
  const flame = useMemo(() => (mode === "flame" ? layoutFlame(view, collapsed) : null), [mode, view, collapsed]);
  const hlKeys = useMemo(
    () => (highlighted.size ? ownersOf(tree, highlighted, visible, frameworkOpen) : EMPTY_KEYS),
    [tree, highlighted, visible, frameworkOpen],
  );
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
  // every highlighted span is in that one group (the N+1 case), the group row itself is the answer.
  // Only selection changes trigger this, so a user folding things again is respected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state is read, not a trigger
  useEffect(() => {
    if (!selected || visible.has(selected)) return;
    const hiding = hidingGroups(tree, selected).filter((g) => !groupsOpen.has(g));
    if (
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

  // Scroll the first highlighted row into view after a finding chip click. A group that opens in
  // response re-renders the rows, so keep following for a short window, then stop so later manual
  // expands don't yank the scroll position.
  const scrollUntil = useRef(0);
  useEffect(() => {
    if (nonce > 0) scrollUntil.current = Date.now() + 500;
  }, [nonce]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when rows change, read the DOM
  useEffect(() => {
    if (Date.now() > scrollUntil.current) return;
    const el = rootRef.current?.querySelector<HTMLElement>(".wf-hl");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [nonce, rows, mode]);

  // Keyboard: Up/Down move between nodes (depth-first, both modes) and select spans; Right/Left
  // expand/collapse the focused node. Focus moves with the selection so screen readers follow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: toggleNode closes over the current state
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
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

  const total = tree.total;
  const ttfb = trace.facts?.ttfb;
  const ctx: DrawCtx = {
    total,
    selected,
    hlKeys,
    critKeys,
    segsByKey,
    ticksByKey,
    gapKey,
    gaps,
    critMs: path.ms,
    onToggle: toggleNode,
  };

  return (
    <section
      ref={rootRef}
      class={`waterfall tc-${mode} ${crit ? "tc-crit-on" : ""}`}
      aria-label={mode === "flame" ? "Flame graph" : "Span tree"}
    >
      {mode === "flame" && flame ? (
        <>
          <header class="waterfall-head fl-head">
            <div class="waterfall-bar-col">
              <Axis total={total} ttfb={ttfb} />
            </div>
          </header>
          <FlameCanvas rects={flame.rects} rows={flame.rows} ctx={ctx} />
          <FlameSelection trace={trace} />
        </>
      ) : (
        <>
          <header class="waterfall-head">
            <div class="waterfall-name-col">Span</div>
            <div class="waterfall-bar-col">
              <Axis total={total} ttfb={ttfb} />
            </div>
          </header>
          <ul class="waterfall-rows">
            {rows.map((r) => (
              <TreeRow key={r.node.key} row={r} ctx={ctx} logs={trace.logs} collapsed={collapsed} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface DrawCtx {
  total: number;
  selected: string | null;
  hlKeys: ReadonlySet<string>;
  critKeys: ReadonlySet<string>;
  segsByKey: ReadonlyMap<string, CriticalSegment[]>;
  ticksByKey: ReadonlyMap<string, LogTick[]>;
  gapKey: string | undefined;
  gaps: ReadonlyArray<[number, number]>;
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

function pct(v: number, total: number): string {
  return `${(v / total) * 100}%`;
}

function barStyle(start: number, end: number, total: number) {
  return { left: pct(start, total), width: `${Math.max(0.3, ((end - start) / total) * 100)}%` };
}

function indentPx(depth: number): string {
  return `${12 + Math.min(depth, 10) * 14}px`;
}

function nodeBucket(n: ViewNode): TimeBucket {
  if (n.type === "band") return "framework";
  return bucketOf(n.type === "span" ? n.span : (n.group.members[0] as SpanRecord));
}

function nodeKind(n: ViewNode): HopKind | "next" {
  if (n.type === "band") return "next";
  return n.type === "span" ? n.span.kind : n.group.kind;
}

function nodeTitle(n: ViewNode, ctx: DrawCtx): string {
  if (n.type === "band") {
    const k = n.band.spans.length;
    return `Next.js: ${k} framework span${k === 1 ? "" : "s"} (request, routing, compile, render, response), ${fmtMs(n.band.wallMs)} wall.\nClick to ${n.open ? "fold them" : "show them"}.`;
  }
  if (n.type === "group") {
    const g = n.group;
    return `${g.members.length} calls with the same shape. Sum ${fmtMs(g.sumMs)}, wall ${fmtMs(g.wallMs)}.\n${g.label}\nClick to ${n.open ? "collapse" : "expand"}.`;
  }
  const s = n.span;
  const c = ctx.critMs.get(s.id);
  const crit = c ? `\nCritical path: the end waited ${fmtMs(c)} on this span itself` : "";
  const late = isLate(s) ? "\nLate: ended after the response finished" : "";
  return `${s.name}\n${BUCKET_LABELS[bucketOf(s)]} · ${fmtMs(s.end - s.start)} at +${fmtMs(s.start)}${crit}${late}`;
}

/* ------------------------------------------------------------------ axis */

function Axis({ total, ttfb }: { total: number; ttfb: number | undefined }) {
  // The dashed TTFB mark would strike through a tick label it lands on (usually the end one: an API
  // route's TTFB is ~100% of the trace). Hide that label; the mark's tooltip carries the time.
  const f = ttfb !== undefined && ttfb <= total && total > 0 ? ttfb / total : -1;
  const hideMid = Math.abs(f - 0.5) < 0.06;
  const hideEnd = f >= 0.85;
  return (
    <>
      <span class="waterfall-tick">0</span>
      <span class="waterfall-tick" style={hideMid ? { visibility: "hidden" } : undefined}>
        {fmtMs(total / 2)}
      </span>
      <span class="waterfall-tick" style={hideEnd ? { visibility: "hidden" } : undefined}>
        {fmtMs(total)}
      </span>
      {ttfb !== undefined && ttfb <= total && (
        <span
          class="wf-ttfb-mark"
          style={{ left: pct(ttfb, total) }}
          title={`TTFB ${fmtMs(ttfb)} of ${fmtMs(total)}`}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------- overlays */

function GapHatches({ gaps, total }: { gaps: ReadonlyArray<[number, number]>; total: number }) {
  return (
    <>
      {gaps.map(([a, b]) => (
        <span
          key={`${a}-${b}`}
          class="tc-gap"
          style={barStyle(a, b, total)}
          title={`Idle ${fmtMs(b - a)}: no captured span was running`}
        />
      ))}
    </>
  );
}

/** Critical segments as a strip; `from`/`span` map times into the containing box (0..100%). */
function CritStrip({ segs, from, span }: { segs: readonly CriticalSegment[]; from: number; span: number }) {
  return (
    <>
      {segs.map((s) => (
        <span
          key={`${s.spanId}-${s.start}`}
          class="tc-crit-seg"
          style={{ left: pct(s.start - from, span), width: `${Math.max(0.3, ((s.end - s.start) / span) * 100)}%` }}
        />
      ))}
    </>
  );
}

function Ticks({ ticks, from, span }: { ticks: readonly LogTick[]; from: number; span: number }) {
  return (
    <>
      {ticks.slice(0, 50).map((t, i) => (
        <span
          key={`${t.t}-${i}`}
          class={`tc-tick tc-tick-${t.level}`}
          style={{ left: pct(Math.min(Math.max(t.t - from, 0), span), span) }}
          title={`${t.level} at +${fmtMs(t.t)}: ${t.text.slice(0, 200)}`}
        />
      ))}
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
  const { total } = ctx;
  const span = n.type === "span" ? n.span : undefined;
  const selected = !!span && ctx.selected === n.key;
  const hasError = span ? !!span.error : n.type === "group" ? n.group.errored > 0 : false;
  const late = !!span && isLate(span);
  const expandable = n.type !== "span" || n.children.length > 0;
  const open = n.type === "span" ? !collapsed.has(n.key) : n.open;
  const segs = ctx.segsByKey.get(n.key);
  const ticks = ctx.ticksByKey.get(n.key);
  const kind = nodeKind(n);

  // Only the selected row (or an errored one) renders the code preview; otherwise a page with
  // 40 spans would fire 40 /source requests. Moving the selection closes the previous one.
  const showSnippet = !!span && (selected || hasError);
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
          {n.type === "band" && (
            <span class="tc-band-note dim">
              {n.band.spans.length} span{n.band.spans.length === 1 ? "" : "s"}
              {n.open ? "" : ", folded"}
            </span>
          )}
          {late && <span class="tc-late-tag">late</span>}
        </div>
        <div class="waterfall-bar-col">
          {ctx.gapKey === n.key && <GapHatches gaps={ctx.gaps} total={total} />}
          {span && (
            <div class={`jw-bar b-${bucketOf(span)}`} style={barStyle(span.start, span.end, total)}>
              <span class="jw-bar-label">{fmtMs(span.end - span.start)}</span>
            </div>
          )}
          {n.type === "group" && <GroupTrack group={n.group} total={total} />}
          {n.type === "band" && <BandTrack node={n} total={total} />}
          {segs && (
            <span class="tc-crit-track" aria-hidden="true">
              <CritStrip segs={segs} from={0} span={total} />
            </span>
          )}
          {ticks && <Ticks ticks={ticks} from={0} span={total} />}
        </div>
      </button>
      {showSnippet && span && <SpanSnippet span={span} />}
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

function GroupTrack({ group: g, total }: { group: SpanGroup; total: number }) {
  const w = Math.max(1e-6, g.end - g.start);
  const bucket = bucketOf(g.members[0] as SpanRecord);
  return (
    <div class="wf-group-track" style={barStyle(g.start, g.end, total)}>
      {g.members.slice(0, MAX_TICKS).map((m) => (
        <span
          key={m.id}
          class={`wf-group-tick b-${bucket}`}
          style={{ left: pct(m.start - g.start, w), width: `${Math.max(0.4, ((m.end - m.start) / w) * 100)}%` }}
        />
      ))}
      <span class="jw-bar-label wf-group-label">
        {fmtMs(g.wallMs)} wall · Σ {fmtMs(g.sumMs)}
      </span>
    </div>
  );
}

function BandTrack({ node, total }: { node: Extract<ViewNode, { type: "band" }>; total: number }) {
  const b = node.band;
  const w = Math.max(1e-6, b.end - b.start);
  return (
    <div class="wf-group-track tc-band-track" style={barStyle(b.start, b.end, total)}>
      {b.spans.slice(0, MAX_TICKS).map((s) => (
        <span
          key={s.id}
          class={`wf-group-tick b-${bucketOf(s)}`}
          style={{ left: pct(s.start - b.start, w), width: `${Math.max(0.4, ((s.end - s.start) / w) * 100)}%` }}
        />
      ))}
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
        <GapHatches gaps={ctx.gaps} total={ctx.total} />
      </div>
      {rects.map((r) => (
        <FlameBox key={r.node.key} rect={r} ctx={ctx} />
      ))}
    </div>
  );
}

function FlameBox({ rect, ctx }: { rect: FlameRect; ctx: DrawCtx }) {
  const n = rect.node;
  const span = n.type === "span" ? n.span : undefined;
  const selected = !!span && ctx.selected === n.key;
  const hasError = span ? !!span.error : n.type === "group" ? n.group.errored > 0 : false;
  const width = Math.max(1e-6, n.end - n.start);
  const segs = ctx.segsByKey.get(n.key);
  const ticks = ctx.ticksByKey.get(n.key);
  const label = span ? span.name : n.type === "group" ? `×${n.group.members.length} ${n.group.label}` : "Next.js";
  const cls = [
    "fl-rect",
    `b-${nodeBucket(n)}`,
    n.type === "group" ? "fl-group" : "",
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
      style={{ ...barStyle(n.start, n.end, ctx.total), top: `${rect.row * ROW_H}px`, height: `${ROW_H - 2}px` }}
      aria-pressed={span ? selected : undefined}
      aria-expanded={n.type === "span" ? undefined : n.open}
      aria-label={`${label}, ${fmtMs(n.end - n.start)}`}
      title={nodeTitle(n, ctx)}
      onClick={() => (span ? selectHop(span.id) : ctx.onToggle(n))}
    >
      <span class="fl-label">
        {label} <span class="fl-ms">{fmtMs(n.end - n.start)}</span>
      </span>
      {segs && <CritStrip segs={segs} from={n.start} span={width} />}
      {ticks && <Ticks ticks={ticks} from={n.start} span={width} />}
    </button>
  );
}

/** Flame mode has no rows to hang the snippet on: show the selected span's code under the canvas. */
function FlameSelection({ trace }: { trace: TraceRecord }) {
  const id = selectedHopId.value;
  const span = id ? trace.spans.find((s) => s.id === id) : undefined;
  if (!span) return <p class="fl-hint dim">Click a box to inspect it. Arrow keys move between spans.</p>;
  return (
    <div class="fl-selection">
      <div class="fl-selection-head">
        <span class={`jw-kind-pill jw-kind-${span.kind}`}>{kindLabel(span.kind)}</span>
        <span class="jw-span-name mono">{span.name}</span>
        <span class="dim mono">
          {fmtMs(span.end - span.start)} at +{fmtMs(span.start)}
        </span>
      </div>
      <SpanSnippet span={span} />
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
