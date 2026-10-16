import { useEffect, useRef } from "preact/hooks";
import type { TraceRecord } from "../api/types";
import { register } from "../state/keymap";
import {
  REPLAY_N,
  type ReplayJob,
  type StripCell,
  compareOffer,
  confirmReplay,
  dismissReplay,
  isRunning,
  liveRuns,
  medianRun,
  progressTraces,
  replayBusy,
  replayJob,
  replayOnce,
  replayTrace,
  resultRuns,
  statsLine,
  stopNote,
  stripCells,
  vsLastRun,
} from "../state/replay";
import { go } from "../state/router";
import { actionError, builderOpen, loadTrace, selectedTraceId, tracesState } from "../state/store";
import "../styles/replay.css";

/*
 * Replay xN (plan 4.2 WP7). `ReplayActions` sits in the trace subject's action row and owns the
 * trace keys `r` (replay once, open it) and `R` (replay x10). `ReplayPanel` shows the batch:
 * the inline confirm for a non-GET, progress while it runs, then warm p50/p95, one bar per run,
 * "vs last run", and a compare against the median run when the gap is worth a look.
 */

function idle(): boolean {
  return !isRunning() && !builderOpen.peek();
}

async function once(trace: { id: string }): Promise<void> {
  try {
    const id = await replayOnce(trace);
    if (id) await loadTrace(id, "user");
  } catch (err) {
    actionError.value = `Replay failed: ${(err as Error).message}`;
  }
}

/** Replay buttons for the open trace, plus its `r` / `R` keys. */
export function ReplayActions({ trace }: { trace: TraceRecord }) {
  // Any replay in flight (this job, a single replay, or a Changes row's x10 batch): the actions
  // would return early, so say so instead of looking clickable.
  const busy = replayBusy();
  // While the builder drawer is open, R replays the builder's request (RequestBuilder owns it).
  const keys = !builderOpen.value;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-register per trace
  useEffect(() => {
    const offs = [
      register("trace", "r", "Replay this request once and open it", () => void once(trace), {
        when: idle,
        hint: "replay",
      }),
      register(
        "trace",
        "R",
        `Replay this request x${REPLAY_N}: warm p50/p95 and vs last run`,
        () => void replayTrace(trace),
        { when: idle, hint: `replay x${REPLAY_N}` },
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [trace.id]);

  return (
    <>
      <button
        type="button"
        class="sbtn"
        disabled={busy}
        onClick={() => void once(trace)}
        title="Send this request again and open the new trace"
      >
        {keys && <kbd class="rp-kbd">r</kbd>} Replay
      </button>
      <button
        type="button"
        class="sbtn"
        disabled={busy}
        onClick={() => void replayTrace(trace)}
        title={`Send this request ${REPLAY_N} times in a row: warm p50/p95, cold runs left out`}
      >
        {keys && <kbd class="rp-kbd">R</kbd>} Replay x{REPLAY_N}
      </button>
    </>
  );
}

/** Whether the trace subject should show this job: replayed from it, or it is one of the runs. */
export function jobShownForTrace(job: ReplayJob | null, traceId: string, builderIsOpen: boolean): boolean {
  if (!job) return false;
  const isRun = !!job.result?.runs.some((r) => r.traceId === traceId);
  if (job.source.kind === "trace") return job.source.traceId === traceId || isRun;
  return !builderIsOpen && isRun;
}

/** The replay batch for the open trace, when there is one. */
export function TraceReplayPanel({ traceId }: { traceId: string }) {
  const job = replayJob.value;
  if (!jobShownForTrace(job, traceId, builderOpen.value)) return null;
  return <ReplayPanel job={job!} />;
}

/** The replay batch for the builder's route, when there is one. */
export function BuilderReplayPanel({ routeKey }: { routeKey: string }) {
  const job = replayJob.value;
  if (job?.source.kind !== "builder" || job.source.routeKey !== routeKey) return null;
  return <ReplayPanel job={job} />;
}

export function ReplayPanel({ job }: { job: ReplayJob }) {
  const title = `${job.req.method} ${job.req.path}`;
  return (
    <section class={`rp rp-${job.phase}`} aria-label="Replay" aria-busy={job.phase === "running"}>
      {job.phase === "confirm" && <Confirm job={job} title={title} />}
      {job.phase === "running" && <Running job={job} title={title} />}
      {job.phase === "done" && <Done job={job} title={title} />}
      {job.phase === "error" && (
        <div class="rp-head">
          <span class="rp-chip rp-chip-err">failed</span>
          <span class="rp-msg">{job.error ?? "Replay failed"}</span>
          <Dismiss />
        </div>
      )}
    </section>
  );
}

function Dismiss() {
  return (
    <button type="button" class="rp-x" onClick={dismissReplay} aria-label="Dismiss the replay" title="Dismiss">
      ×
    </button>
  );
}

function Confirm({ job, title }: { job: ReplayJob; title: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div class="rp-confirm" role="alertdialog" aria-label={`Replay ${title} x${job.n}?`}>
      <p class="rp-msg">
        Replay <span class="mono">{title}</span> x{job.n}? A {job.req.method} can change data: its side effects run{" "}
        {job.n} times.
      </p>
      <div class="rp-actions">
        <button ref={ref} type="button" class="sbtn rp-primary" onClick={confirmReplay}>
          Replay x{job.n}
        </button>
        <button type="button" class="sbtn" onClick={dismissReplay}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Running({ job, title }: { job: ReplayJob; title: string }) {
  const live = progressTraces(tracesState.value, job);
  const done = live.filter((t) => t.done).length;
  const cells = stripCells(liveRuns(live), job.n);
  return (
    <>
      <div class="rp-head">
        <span class="rp-title">
          Replaying <span class="mono">{title}</span> x{job.n}
        </span>
        <output class="rp-progress mono" aria-live="polite">
          run {Math.min(done + 1, job.n)}/{job.n}
        </output>
      </div>
      <Strip cells={cells} />
    </>
  );
}

function Done({ job, title }: { job: ReplayJob; title: string }) {
  const res = job.result!;
  const med = medianRun(res);
  const cells = stripCells(resultRuns(res), res.repeat, med?.traceId);
  const stop = stopNote(res);
  const vs = vsLastRun(res, Date.now());
  const offer = compareOffer(
    res,
    job.source.kind === "trace" ? { traceId: job.source.traceId, ms: job.sourceMs } : undefined,
  );
  return (
    <>
      <div class="rp-head">
        <span class="rp-title">
          Replay x{res.runs.length} <span class="mono">{title}</span>
        </span>
        {res.capped && <span class="rp-chip">capped at {res.repeat}</span>}
        <Dismiss />
      </div>
      <p class="rp-stats mono">{res.warm.n > 0 ? statsLine(res) : "No warm runs: nothing to measure"}</p>
      {stop && (
        <p class="rp-stop">
          <span class="rp-chip rp-chip-warn">stopped</span> {stop}
        </p>
      )}
      <Strip cells={cells} />
      {vs && (
        <p class="rp-vs">
          <span class={`rp-delta rp-delta-${vs.tone}`}>{vs.text}</span>
        </p>
      )}
      {offer && (
        <div class="rp-actions">
          <button type="button" class="sbtn" onClick={() => go({ view: "compare", a: offer.a, b: offer.b })}>
            {offer.label}
          </button>
          <span class="dim rp-detail">{offer.detail}</span>
        </div>
      )}
    </>
  );
}

function Strip({ cells }: { cells: StripCell[] }) {
  const open = selectedTraceId.value;
  return (
    <ol class="rp-strip" aria-label="Runs, in order (bar height = duration)">
      {cells.map((c) => (
        <li key={c.key} class="rp-cell">
          {c.traceId && c.kind !== "pending" ? (
            <button
              type="button"
              class={`rp-bar rp-${c.kind} ${c.median ? "rp-median" : ""}`}
              style={{ height: `${Math.round(c.h * 100)}%` }}
              aria-current={c.traceId === open ? "true" : undefined}
              aria-label={c.label}
              title={c.label}
              onClick={() => void loadTrace(c.traceId!, "user")}
            />
          ) : (
            <span class={`rp-bar rp-${c.kind}`} style={{ height: `${Math.round(c.h * 100)}%` }} title={c.label} />
          )}
        </li>
      ))}
    </ol>
  );
}
