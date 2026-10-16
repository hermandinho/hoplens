import { useEffect, useRef } from "preact/hooks";
import type { SpanRecord, TraceRecord } from "../api/types";
import { type FlowModel, type ResourceGroup, type ResourceItem, flowModel } from "../state/flow";
import {
  SPEED_OPTIONS,
  currentTime,
  journey,
  normalisedTime,
  pause,
  playing,
  resetPlayback,
  seekTo,
  selectHop,
  selectedHopId,
  setSpeed,
  speed,
  stepBy,
  togglePlay,
} from "../state/journey";
import { selectedTrace } from "../state/store";

/**
 * Flow view — a diagram of what the request actually did, not a straight
 * timeline. The top row renders the request *pipeline* (what Next.js did to
 * route the call), and the grid below groups everything the handler
 * *touched* — DB queries by table, Redis commands by key, external APIs by
 * host, internal functions by directory, RSC renders. Each item links back
 * to the span in the inspector.
 */

export function Journey() {
  const trace = selectedTrace.value;
  const j = journey.value;
  const flow = flowModel.value;
  const t = currentTime.value;
  const isPlaying = playing.value;
  const spd = speed.value;
  const selected = selectedHopId.value;

  const traceId = trace?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: traceId is intentionally the sole trigger
  useEffect(() => {
    resetPlayback();
  }, [traceId]);

  // rAF loop advances currentTime at `speed` × wall-clock when playing.
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastRef.current = null;
      return;
    }
    const tick = (now: number) => {
      const last = lastRef.current;
      lastRef.current = now;
      if (last === null) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = (now - last) * spd;
      const j2 = journey.value;
      if (!j2) {
        pause();
        return;
      }
      const next = Math.min(j2.duration, currentTime.value + dt);
      currentTime.value = next;
      if (next >= j2.duration) {
        pause();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, spd]);

  // Keyboard controls (space / arrows / Home / End).
  useEffect(() => {
    if (!j) return;
    const handler = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (ev.key === " ") {
        ev.preventDefault();
        togglePlay();
      } else if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        stepBy(ev.shiftKey ? -100 : -20);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        stepBy(ev.shiftKey ? 100 : 20);
      } else if (ev.key === "Home") {
        ev.preventDefault();
        seekTo(0);
      } else if (ev.key === "End") {
        ev.preventDefault();
        seekTo(j.duration);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [j]);

  if (!trace || !j || !flow) {
    return (
      <div class="journey-empty">
        <b>No trace selected</b>
        Pick one from the Traffic sidebar, or send a request to light up the journey.
      </div>
    );
  }

  const totalMs = Math.round(j.duration);
  const progressMs = Math.round(t);

  return (
    <section class="flow" aria-label="Request flow">
      <header class="flow-head">
        <h3 class="flow-title">
          Flow <span class="dim mono">{totalMs}ms</span>
        </h3>
        <div class="flow-controls" role="toolbar" aria-label="Playback">
          <button
            type="button"
            class="pbtn"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            title={isPlaying ? "Pause (space)" : "Play (space)"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button type="button" class="pbtn" onClick={() => stepBy(-50)} aria-label="Step back" title="Step back (←)">
            ◀◀
          </button>
          <button
            type="button"
            class="pbtn"
            onClick={() => stepBy(50)}
            aria-label="Step forward"
            title="Step forward (→)"
          >
            ▶▶
          </button>
          <input
            class="scrubber"
            type="range"
            min={0}
            max={j.duration}
            step={1}
            value={t}
            onInput={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
            aria-label="Scrub playback"
          />
          <label class="speed-label" for="flow-speed">
            Speed
          </label>
          <select
            id="flow-speed"
            class="speed-select"
            value={spd}
            onChange={(e) => setSpeed(Number((e.target as HTMLSelectElement).value) as (typeof SPEED_OPTIONS)[number])}
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
          <span class="time-indicator mono">{progressMs}ms</span>
        </div>
      </header>

      <TotalsStrip flow={flow} />

      <div class="flow-body">
        <Pipeline flow={flow} trace={trace} selected={selected} progress={normalisedTime.value} />
        <TouchedGrid flow={flow} selected={selected} />
      </div>
    </section>
  );
}

/* -------------------------------------------------------- top totals strip */

function TotalsStrip({ flow }: { flow: FlowModel }) {
  const items: { label: string; ms: number; cls: string }[] = [];
  if (flow.totals.dbMs > 0) items.push({ label: "DB", ms: flow.totals.dbMs, cls: "db" });
  if (flow.totals.cacheMs > 0) items.push({ label: "Cache", ms: flow.totals.cacheMs, cls: "cache" });
  if (flow.totals.externalMs > 0) items.push({ label: "External", ms: flow.totals.externalMs, cls: "external" });
  if (flow.totals.internalMs > 0) items.push({ label: "Functions", ms: flow.totals.internalMs, cls: "internal" });
  if (flow.totals.renderMs > 0) items.push({ label: "Render", ms: flow.totals.renderMs, cls: "render" });

  if (items.length === 0) {
    return (
      <div class="flow-totals empty">
        <span class="dim">This request didn't touch any external resource.</span>
      </div>
    );
  }

  return (
    <div class="flow-totals" aria-label="Resource totals">
      {items.map((i) => (
        <span key={i.label} class={`flow-total-chip chip-${i.cls}`}>
          <span class="chip-label">{i.label}</span>
          <span class="chip-ms mono">{Math.round(i.ms)}ms</span>
        </span>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- pipeline row */

interface PipelineNode {
  id: string;
  kind: string;
  label: string;
  sub?: string;
  duration: number;
  errored: boolean;
}

function Pipeline({
  flow,
  trace,
  selected,
  progress,
}: {
  flow: FlowModel;
  trace: TraceRecord;
  selected: string | null;
  progress: number;
}) {
  const total = Math.max(1, trace.duration ?? 1);
  const nodes: PipelineNode[] = [
    {
      id: "client",
      kind: "request",
      label: trace.runId ? "Hoplens" : "Client",
      sub: `${trace.method} ${trace.route ?? trace.path}`,
      duration: 0,
      errored: false,
    },
    ...flow.pipeline.map(
      (s): PipelineNode => ({
        id: s.id,
        kind: s.kind,
        label: pipelineLabel(s, trace),
        sub: s.location ? `${baseFile(s.location.file)}:${s.location.line}` : undefined,
        duration: s.end - s.start,
        errored: !!s.error,
      }),
    ),
  ];

  return (
    <div class="flow-pipeline" aria-label="Request pipeline">
      <div class="flow-pipeline-rail">
        {nodes.map((n, i) => (
          <div class="flow-pipeline-slot" key={n.id}>
            <button
              type="button"
              class={`pipe-node pipe-${n.kind} ${selected === n.id ? "selected" : ""} ${n.errored ? "errored" : ""}`}
              onClick={() => selectHop(n.id)}
            >
              <span class="pipe-kind">{n.kind}</span>
              <span class="pipe-label mono">{n.label}</span>
              {n.sub && <span class="pipe-sub mono dim">{n.sub}</span>}
              {n.duration > 0 && <span class="pipe-dur mono">{Math.round(n.duration)}ms</span>}
            </button>
            {i < nodes.length - 1 && (
              <span class="pipe-arrow" aria-hidden="true">
                →
              </span>
            )}
          </div>
        ))}
      </div>
      <div class="flow-pipeline-scrub" aria-hidden="true">
        <div class="flow-pipeline-scrub-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div class="flow-pipeline-foot dim mono">{Math.round(total)}ms wall · click a node to inspect</div>
    </div>
  );
}

/* -------------------------------------------------------- touched grid */

function TouchedGrid({ flow, selected }: { flow: FlowModel; selected: string | null }) {
  if (flow.groups.length === 0) {
    return (
      <div class="flow-touched flow-touched-empty">
        <b>Nothing to show here yet.</b>
        <span class="dim">
          This request didn't touch any database, cache, external API, or app function. Try a route that queries data,
          and the diagram will light up.
        </span>
      </div>
    );
  }
  return (
    <div class="flow-touched" aria-label="Resources touched by this request">
      {flow.groups.map((g) => (
        <ResourceCard key={`${g.category}-${g.name}`} group={g} selected={selected} />
      ))}
    </div>
  );
}

function ResourceCard({ group, selected }: { group: ResourceGroup; selected: string | null }) {
  const MAX_ITEMS = 6;
  const visible = group.items.slice(0, MAX_ITEMS);
  const more = group.items.length - visible.length;
  return (
    <article class={`res-card res-${group.category}`} aria-label={`${group.name} resource group`}>
      <header class="res-head">
        <span class={`res-icon icon-${group.icon}`} aria-hidden="true" />
        <h4 class="res-name">{group.name}</h4>
        <span class="res-count mono">
          {group.items.length} {group.items.length === 1 ? "call" : "calls"}
        </span>
        <span class="res-total mono">{Math.round(group.totalMs)}ms</span>
      </header>
      <ul class="res-items">
        {visible.map((item) => (
          <ResourceRow key={item.span.id} item={item} selected={selected === item.span.id} />
        ))}
      </ul>
      {more > 0 && <div class="res-more dim mono">+ {more} more</div>}
    </article>
  );
}

function ResourceRow({ item, selected }: { item: ResourceItem; selected: boolean }) {
  return (
    <li class={`res-row ${selected ? "selected" : ""} ${item.errored ? "errored" : ""}`}>
      <button type="button" class="res-row-btn" onClick={() => selectHop(item.span.id)}>
        <span class="res-row-label mono" title={item.label}>
          {item.label}
        </span>
        {item.sub && (
          <span class="res-row-sub mono dim" title={item.sub}>
            {item.sub}
          </span>
        )}
        <span class="res-row-dur mono">{Math.round(item.duration)}ms</span>
      </button>
    </li>
  );
}

/* -------------------------------------------------------- label helpers */

function pipelineLabel(s: SpanRecord, t: TraceRecord): string {
  switch (s.kind) {
    case "request":
      return `${t.method} ${t.route ?? t.path}`;
    case "proxy":
      return "middleware";
    case "router":
      return "router";
    case "handler":
      return "handler";
    case "response":
      return `response ${t.status ?? ""}`.trim();
    default:
      return s.name;
  }
}

function baseFile(file: string): string {
  const i = file.lastIndexOf("/");
  return i >= 0 ? file.slice(i + 1) : file;
}
