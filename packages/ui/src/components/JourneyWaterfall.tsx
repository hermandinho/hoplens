import { useEffect, useRef } from "preact/hooks";
import type { HopKind, SpanRecord } from "../api/types";
import { selectHop, selectedHopId } from "../state/journey";
import { selectedTrace } from "../state/store";

/**
 * Classic trace-waterfall layout — one row per span, indented by depth in the
 * parent-child tree, time-proportional bars on the right. Replaces the
 * horizontal-flow view's overlapping-label layout with a familiar Jaeger /
 * Chrome DevTools pattern.
 *
 * Each row is a flex container: fixed left column (name + kind pill) that
 * never clips, flex-1 right column that paints the timing bar at
 * `left: start/duration%; width: (end-start)/duration%`.
 */

interface WaterfallRow {
  span: SpanRecord;
  depth: number;
  leftPct: number;
  widthPct: number;
}

function computeRows(spans: SpanRecord[]): WaterfallRow[] {
  if (spans.length === 0) return [];

  const total = Math.max(1, ...spans.map((s) => s.end));
  // depth lookup: parent id -> depth; roots are 0.
  const depths = new Map<string, number>();
  // Topological ordering by start time keeps depth lookups cheap: a child's
  // parent always has an earlier start (barring instrumentation bugs).
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (const s of ordered) {
    const parentDepth = s.parentId ? (depths.get(s.parentId) ?? 0) : 0;
    depths.set(s.id, s.parentId ? parentDepth + 1 : 0);
  }

  return ordered.map((s) => ({
    span: s,
    depth: depths.get(s.id) ?? 0,
    leftPct: (s.start / total) * 100,
    widthPct: Math.max(0.5, ((s.end - s.start) / total) * 100),
  }));
}

export function JourneyWaterfall() {
  const trace = selectedTrace.value;
  const selected = selectedHopId.value;
  const listRef = useRef<HTMLUListElement | null>(null);

  if (!trace) {
    return (
      <section class="journey-empty" aria-label="Journey waterfall">
        <b>Pick a request from the sidebar</b>
        Then its full waterfall shows up here.
      </section>
    );
  }

  const rows = computeRows(trace.spans);
  if (rows.length === 0) {
    return (
      <section class="journey-empty" aria-label="Journey waterfall">
        <b>No spans captured yet</b>
        This trace is still streaming — spans will appear as they close.
      </section>
    );
  }

  const total = Math.max(1, ...trace.spans.map((s) => s.end));

  // Arrow-key navigation between rows.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const handler = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      const current = rows.findIndex((r) => r.span.id === selected);
      const next = ev.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
      if (next !== current && rows[next]) {
        ev.preventDefault();
        selectHop(rows[next].span.id);
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [rows, selected]);

  return (
    <section class="waterfall" aria-label="Journey waterfall">
      <header class="waterfall-head">
        <div class="waterfall-name-col">Span</div>
        <div class="waterfall-bar-col">
          <span class="waterfall-tick">0</span>
          <span class="waterfall-tick">{Math.round(total / 2)}ms</span>
          <span class="waterfall-tick">{Math.round(total)}ms</span>
        </div>
      </header>
      <ul ref={listRef} class="waterfall-rows">
        {rows.map((row) => (
          <Row key={row.span.id} row={row} selected={selected === row.span.id} />
        ))}
      </ul>
    </section>
  );
}

function Row({ row, selected }: { row: WaterfallRow; selected: boolean }) {
  const { span, depth, leftPct, widthPct } = row;
  const duration = span.end - span.start;
  const hasError = !!span.error;
  const kindClass = `jw-kind-${span.kind}`;
  const indent = Math.min(depth, 6) * 16;

  return (
    <li class="waterfall-row-li">
      <button
        type="button"
        class={`waterfall-row ${selected ? "selected" : ""} ${hasError ? "jw-row-err" : ""}`}
        onClick={() => selectHop(span.id)}
      >
        <div class="waterfall-name-col" style={{ paddingLeft: `${12 + indent}px` }}>
          <span class={`jw-kind-pill ${kindClass}`}>{kindLabel(span.kind)}</span>
          <span class="jw-span-name" title={span.name}>
            {span.name}
          </span>
        </div>
        <div class="waterfall-bar-col">
          <div class={`jw-bar ${kindClass}`} style={{ left: `${leftPct}%`, width: `${widthPct}%` }}>
            <span class="jw-bar-label">{duration}ms</span>
          </div>
        </div>
      </button>
    </li>
  );
}

const KIND_LABELS: Record<HopKind, string> = {
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
};

function kindLabel(k: HopKind): string {
  return KIND_LABELS[k] ?? "·";
}
