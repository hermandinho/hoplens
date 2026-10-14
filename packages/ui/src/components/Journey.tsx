import { useEffect, useRef } from "preact/hooks";
import type { Hop } from "../state/journey";
import {
  SPEED_OPTIONS,
  currentTime,
  journey,
  normalisedTime,
  pause,
  play,
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

const COL_WIDTH = 140;
const ROW_HEIGHT = 60;
const MAIN_Y = 50;
const PADDING_X = 40;
const PADDING_TOP = 20;

export function Journey() {
  const trace = selectedTrace.value;
  const j = journey.value;
  const t = currentTime.value;
  const isPlaying = playing.value;
  const spd = speed.value;
  const selected = selectedHopId.value;
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);

  // Reset playback when the trace changes. traceId is a trigger-only dep.
  const traceId = trace?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: traceId is intentionally the sole trigger
  useEffect(() => {
    resetPlayback();
  }, [traceId]);

  // rAF loop advances currentTime at `speed` × wall-clock.
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

  // Keyboard controls, scoped to document when a hop is in play.
  useEffect(() => {
    if (!j) return;
    const handler = (ev: KeyboardEvent) => {
      // Don't swallow when the user is typing in an input/textarea.
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

  if (!trace || !j) {
    return (
      <div class="journey-empty">
        <b>No trace selected</b>
        Pick one from the Traffic sidebar, or send a request to light up the journey.
      </div>
    );
  }

  // Canvas dimensions depend on main-lane columns + call rows.
  const mainWidth = Math.max(j.mainHops.length, 2) * COL_WIDTH;
  const callRows = j.callHops.length;
  const svgWidth = PADDING_X * 2 + mainWidth;
  const svgHeight = PADDING_TOP + MAIN_Y + 60 + Math.max(callRows, 1) * ROW_HEIGHT + 20;
  const callX = (h: Hop) => PADDING_X + h.tStart * mainWidth;
  const callW = (h: Hop) => Math.max(60, (h.tEnd - h.tStart) * mainWidth);
  const packetX = PADDING_X + normalisedTime.value * mainWidth;

  return (
    <section class="journey" aria-label="Request journey">
      <div class="journey-head">
        <h3 class="journey-title">
          Journey <span class="dim mono">{Math.round(j.duration)}ms</span>
        </h3>
        <div class="journey-controls" role="toolbar" aria-label="Playback">
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
            aria-label="Scrub playback"
            onInput={(e) => seekTo(Number((e.target as HTMLInputElement).value))}
          />
          <label class="speed-label" for="journey-speed">
            Speed
          </label>
          <select
            id="journey-speed"
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
          <span class="time-indicator mono" aria-live="off">
            {Math.round(t)}ms
          </span>
        </div>
      </div>

      <div class="journey-canvas-wrap">
        <svg
          class="journey-canvas"
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          width={svgWidth}
          height={svgHeight}
          role="img"
          aria-label={`Journey graph for ${trace.method} ${trace.path}`}
        >
          <defs>
            <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
            </marker>
          </defs>

          {/* main rail */}
          <line
            x1={PADDING_X}
            x2={PADDING_X + mainWidth}
            y1={MAIN_Y + 15}
            y2={MAIN_Y + 15}
            stroke="var(--line-2)"
            stroke-width={1}
          />

          {/* main-lane hops */}
          {j.mainHops.map((h, i) => {
            const x = PADDING_X + i * COL_WIDTH + 8;
            const w = COL_WIDTH - 16;
            return (
              <MainHopNode
                key={h.id}
                hop={h}
                x={x}
                y={MAIN_Y}
                w={w}
                h={32}
                selected={selected === h.id}
                onSelect={() => selectHop(h.id)}
              />
            );
          })}

          {/* handler → call elbow connectors */}
          {j.callHops.map((h) => {
            const handlerIdx = j.mainHops.findIndex((m) => m.kind === "handler");
            const handlerX = handlerIdx >= 0 ? PADDING_X + handlerIdx * COL_WIDTH + COL_WIDTH / 2 : PADDING_X;
            const y = MAIN_Y + 60 + (h.row - 1) * ROW_HEIGHT;
            const nodeX = Math.max(callX(h), handlerX + 20);
            return (
              <g key={`conn-${h.id}`} class="elbow">
                <path
                  d={`M${handlerX},${MAIN_Y + 32} L${handlerX},${y + 12} L${nodeX},${y + 12}`}
                  fill="none"
                  stroke="var(--line-2)"
                  stroke-width={1}
                />
              </g>
            );
          })}

          {/* call hops */}
          {j.callHops.map((h) => {
            const y = MAIN_Y + 60 + (h.row - 1) * ROW_HEIGHT;
            const handlerIdx = j.mainHops.findIndex((m) => m.kind === "handler");
            const handlerX = handlerIdx >= 0 ? PADDING_X + handlerIdx * COL_WIDTH + COL_WIDTH / 2 : PADDING_X;
            const x = Math.max(callX(h), handlerX + 20);
            const w = Math.min(callW(h), mainWidth - (x - PADDING_X));
            return (
              <CallHopNode
                key={h.id}
                hop={h}
                x={x}
                y={y}
                w={w}
                h={24}
                selected={selected === h.id}
                onSelect={() => selectHop(h.id)}
              />
            );
          })}

          {/* animated packet along the main rail */}
          <circle
            class="packet"
            cx={packetX}
            cy={MAIN_Y + 15}
            r={5}
            fill="var(--in)"
            stroke="var(--in-ink)"
            stroke-width={1}
          />
        </svg>
      </div>
    </section>
  );
}

function MainHopNode({
  hop,
  x,
  y,
  w,
  h,
  selected,
  onSelect,
}: {
  hop: Hop;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const colorVar = `var(--k-${hop.kind})`;
  const errored = !!hop.span.error;
  return (
    <g
      class={`hop-node main ${selected ? "selected" : ""} ${errored ? "errored" : ""}`}
      // biome-ignore lint/a11y/useSemanticElements: SVG has no native button; role=button is the correct ARIA role here.
      role="button"
      tabindex={0}
      aria-label={`${hop.kind}: ${hop.name}${errored ? " (errored)" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style="cursor: pointer"
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        fill={errored ? "var(--err-bg)" : "var(--panel-2)"}
        stroke={errored ? "var(--err)" : colorVar}
        stroke-width={selected ? 2 : 1}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 + 4}
        text-anchor="middle"
        fill="var(--fg)"
        font-size={11}
        font-family="var(--font-mono)"
      >
        {hop.name.length > 20 ? `${hop.name.slice(0, 18)}…` : hop.name}
      </text>
      <text
        x={x + w / 2}
        y={y - 4}
        text-anchor="middle"
        fill={colorVar}
        font-size={9}
        font-family="var(--font-mono)"
        style="text-transform: uppercase; letter-spacing: 0.08em"
      >
        {hop.kind}
      </text>
    </g>
  );
}

function CallHopNode({
  hop,
  x,
  y,
  w,
  h,
  selected,
  onSelect,
}: {
  hop: Hop;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const colorVar = `var(--k-${hop.kind})`;
  const errored = !!hop.span.error;
  const dur = Math.round(hop.end - hop.start);
  return (
    <g
      class={`hop-node call ${selected ? "selected" : ""} ${errored ? "errored" : ""}`}
      // biome-ignore lint/a11y/useSemanticElements: SVG has no native button; role=button is the correct ARIA role here.
      role="button"
      tabindex={0}
      aria-label={`${hop.kind}: ${hop.name} (${dur}ms)${errored ? " errored" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style="cursor: pointer"
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill={errored ? "var(--err-bg)" : colorVar}
        fill-opacity="0.12"
        stroke={errored ? "var(--err)" : colorVar}
        stroke-width={selected ? 2 : 1}
      />
      <text x={x + 8} y={y + 16} fill="var(--fg)" font-size={11} font-family="var(--font-mono)">
        {hop.name.length > 32 ? `${hop.name.slice(0, 30)}…` : hop.name}
      </text>
      <text x={x + w - 6} y={y + 16} text-anchor="end" fill="var(--dim)" font-size={10} font-family="var(--font-mono)">
        {dur}ms
      </text>
    </g>
  );
}
