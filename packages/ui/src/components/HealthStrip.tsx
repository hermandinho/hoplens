import { useEffect, useRef, useState } from "preact/hooks";
import type { ProcessErrorRecord } from "../api/types";
import {
  LOOP_HOLD_SAMPLES,
  type LoopView,
  RATE_WINDOW_MS,
  closeErrorsPanel,
  errorKindLabel,
  errorsPanelOpen,
  fmtLoop,
  fmtMem,
  fmtRate,
  healthState,
  initHealth,
  loopView,
  openErrorsPanel,
  processErrorTotal,
  requestRate,
  unseenProcessErrors,
} from "../state/health";
import { register } from "../state/keymap";
import { liveStatus, tracesState } from "../state/store";
import "../styles/health.css";

/*
 * WP6 health strip, rendered inside the top bar's <StatusSlot/> (plan 3.2: "loop p99 4ms  rss 1.1G
 * * 4/s"): event-loop p99, process memory, and a chip for process-level errors (uncaught
 * exceptions / unhandled rejections) that opens a panel to read them.
 */

export function HealthStrip() {
  useEffect(() => initHealth(), []);
  const h = healthState.value;
  const live = liveStatus.value === "live";
  if (h.availability !== "available") return null;
  const cur = h.current;
  const total = processErrorTotal.value;
  const stale = !live ? " health-stale" : "";
  const secs = Math.round(h.sampleMs / 1000);

  return (
    <div class={`health-strip${stale}`}>
      {cur && h.active && (
        <>
          <LoopValue
            p50={cur.loopP50}
            p99={cur.loopP99}
            max={cur.loopMax}
            view={loopView(h.samples[h.samples.length - 1] === cur ? h.samples : [...h.samples, cur])}
            secs={secs}
            stale={!live}
          />
          <span
            class="pill-text health-mem"
            title={[
              `Process memory${live ? "" : " (last known; live stream not connected)"}`,
              `rss ${fmtMem(cur.rss)} (resident set: everything the dev server holds)`,
              `heap ${fmtMem(cur.heapUsed)} used of ${fmtMem(cur.heapTotal)}`,
              `external ${fmtMem(cur.external)} (buffers)`,
              cur.gcCount > 0
                ? `gc ${cur.gcCount} pause${cur.gcCount === 1 ? "" : "s"}, ${fmtLoop(cur.gcMs)} in the last ${secs}s`
                : "no gc pause in the last window",
            ].join("\n")}
          >
            <span class="health-key">rss</span>
            <span class="mono">{fmtMem(cur.rss)}</span>
          </span>
        </>
      )}
      {total > 0 && <ProcessErrorsChip total={total} />}
    </div>
  );
}

function LoopValue({
  p50,
  p99,
  max,
  view,
  secs,
  stale,
}: { p50: number; p99: number; max: number; view: LoopView | undefined; secs: number; stale: boolean }) {
  const level = view?.level ?? "ok";
  const metric = view?.metric ?? "p99";
  const shown = view?.ms ?? p99;
  const hint =
    level === "err"
      ? "The event loop was blocked: requests handled meanwhile waited. Look for sync work (big JSON, sync fs, crypto) or a dev compile."
      : level === "warn"
        ? metric === "max"
          ? `One event-loop stall of ${fmtLoop(shown)} in the last ${LOOP_HOLD_SAMPLES * secs}s: requests handled meanwhile waited.`
          : "Noticeable event-loop stalls."
        : "The event loop is responsive.";
  return (
    <span
      class={`pill-text health-loop health-loop-${level}`}
      title={`Event-loop delay over the last ${secs}s${stale ? " (last known; live stream not connected)" : ""}: p50 ${fmtLoop(p50)}, p99 ${fmtLoop(p99)}, max ${fmtLoop(max)}.\n${hint}`}
      aria-label={`Event loop ${metric} ${fmtLoop(shown)}${level === "ok" ? "" : level === "err" ? ", blocked" : ", stalling"}`}
    >
      {level !== "ok" && <span class={`health-dot health-dot-${level}`} aria-hidden="true" />}
      <span class="health-key">loop {metric}</span>
      <span class="mono">{fmtLoop(shown)}</span>
    </span>
  );
}

/** Request rate next to the live dot, from the retained traces. Re-read on each health tick. */
export function LiveRate() {
  const h = healthState.value;
  const traces = tracesState.value;
  // Without health ticks (older core) a 2s clock keeps the rate from freezing once traffic stops.
  const [, setClock] = useState(0);
  const needClock = h.availability !== "available" && liveStatus.value === "live";
  useEffect(() => {
    if (!needClock) return;
    const t = setInterval(() => setClock((c) => c + 1), 2000);
    return () => clearInterval(t);
  }, [needClock]);
  const shown = fmtRate(requestRate(traces, Date.now()));
  if (!shown) return null;
  return (
    <span
      class="mono health-rate"
      title={`App requests per second over the last ${RATE_WINDOW_MS / 1000}s (assets excluded)`}
    >
      {shown}
    </span>
  );
}

function ProcessErrorsChip({ total }: { total: number }) {
  const open = errorsPanelOpen.value;
  const unseen = unseenProcessErrors.value;
  const ref = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeErrorsPanel();
    };
    document.addEventListener("mousedown", onDown);
    const off = register(
      "global",
      "Escape",
      "Close the process errors panel",
      () => {
        closeErrorsPanel();
        btn.current?.focus();
      },
      { inInput: true, when: () => errorsPanelOpen.peek() },
    );
    return () => {
      document.removeEventListener("mousedown", onDown);
      off();
    };
  }, [open]);

  const label = `${total} process error${total === 1 ? "" : "s"}`;
  return (
    <div class="health-errors" ref={ref}>
      <button
        ref={btn}
        type="button"
        class={`health-chip ${unseen > 0 ? "health-chip-new" : ""}`}
        aria-expanded={open}
        aria-controls="health-errors-panel"
        onClick={() => (open ? closeErrorsPanel() : openErrorsPanel())}
        title="Uncaught exceptions and unhandled rejections in the dev server process (outside any request). Click to read them."
      >
        <span class="health-dot health-dot-err" aria-hidden="true" />
        {label}
        {unseen > 0 && unseen < total && <span class="health-chip-unseen">{unseen} new</span>}
      </button>
      {open && <ProcessErrorsPanel />}
    </div>
  );
}

function ProcessErrorsPanel() {
  const h = healthState.value;
  const errors = [...h.errors].reverse();
  const c = h.errorCounts;
  const total = c.uncaughtException + c.unhandledRejection;
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <section class="health-pop" id="health-errors-panel" aria-label="Process errors" tabIndex={-1} ref={ref}>
      <header class="health-pop-head">
        <b>Process errors</b>
        <span class="dim">
          {c.uncaughtException} uncaught · {c.unhandledRejection} unhandled rejection
          {c.unhandledRejection === 1 ? "" : "s"}
        </span>
        <span class="health-pop-esc dim">
          <kbd>Esc</kbd> close
        </span>
      </header>
      {total > errors.length && (
        <p class="health-pop-note dim">
          Showing the newest {errors.length} of {total}.
        </p>
      )}
      <ol class="health-pop-list">
        {errors.map((e) => (
          <ProcessErrorItem key={e.id} e={e} />
        ))}
      </ol>
      {!h.watchingRejections && (
        <p class="health-pop-note dim">
          Unhandled rejections are recorded only while the app has its own <code>unhandledRejection</code> listener;
          without one, Node's default handling applies.
        </p>
      )}
    </section>
  );
}

function ProcessErrorItem({ e }: { e: ProcessErrorRecord }) {
  const at = new Date(e.t);
  const time = at.toLocaleTimeString(undefined, { hour12: false });
  return (
    <li class="health-err">
      <div class="health-err-line">
        <span class="health-err-kind">{errorKindLabel(e.kind)}</span>
        <time class="mono dim" dateTime={at.toISOString()}>
          {time}
        </time>
      </div>
      <div class="health-err-msg">
        <span class="mono">{e.name}</span>: {e.message || <span class="dim">(no message)</span>}
      </div>
      {e.stack && (
        <details class="health-err-stack">
          <summary>Stack</summary>
          <pre class="mono">{e.stack}</pre>
        </details>
      )}
    </li>
  );
}
