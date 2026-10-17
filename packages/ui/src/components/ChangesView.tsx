import { signal, useComputed, useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { EpochView, RouteRegression, TraceSummary } from "../api/types";
import {
  baseName,
  buildTimeline,
  candidateName,
  epochAt,
  epochList,
  epochsState,
  isSessionEdit,
  labelGap,
  nowTick,
  otherVerdictsByEpoch,
  regressionId,
  requestsByEpoch,
  verdictsByEpoch,
  viaLabel,
} from "../state/epochs";
import { register } from "../state/keymap";
import { type Route, go, route, setSince } from "../state/router";
import { serverStats } from "../state/serverStats";
import { sinceEpoch } from "../state/sinceScope";
import { tracesState } from "../state/store";
import { SinceChip } from "./SinceChip";
import { VerdictRow } from "./SinceStrip";
import "../styles/changes.css";

/*
 * Changes (plan 3.5, #/changes[/e<id>]): the regression timeline. A track with one tick per edit and
 * one dot per request (ok / slow / error), then the edits newest first: the files saved, the routes
 * the edit affects, and each route's verdict (p50 before -> after, the bucket that grew, the I/O
 * change, n on both sides) with "compare before / after" and "replay x10". Clicking a tick selects that edit;
 * dragging across the track sets the since scope. Filters always say what they hide.
 */

const onlyRegressions = signal(false);

interface EpochRowData {
  id: number;
  info?: EpochView;
  /** Requests built by this edit (retained, or the server's count when it says more). */
  n: number;
  /** Retained requests built by this edit (what the "requests" link lists). */
  retained: number;
  /** Verdicts for the routes this edit affects (all of them when its routes aren't known). */
  verdicts: RouteRegression[];
  /** Verdicts for routes the edit doesn't touch: traffic drift, listed muted. */
  others: RouteRegression[];
}

/** Edit ids in the order on screen, for j / k. */
let rowOrder: number[] = [];

export function ChangesView({ r }: { r: Extract<Route, { view: "changes" }> }) {
  const all = useComputed<EpochRowData[]>(() => {
    const retained = requestsByEpoch(tracesState.value);
    const counts = requestsByEpoch(tracesState.value, serverStats.value?.routes);
    const verdicts = verdictsByEpoch.value;
    const others = otherVerdictsByEpoch.value;
    const byId = new Map(epochList.value.map((e) => [e.id, e]));
    const ids = new Set<number>([...byId.keys(), ...counts.keys(), ...verdicts.keys(), ...others.keys()]);
    return [...ids]
      .sort((a, b) => b - a)
      .map((id) => ({
        id,
        info: byId.get(id),
        n: counts.get(id) ?? 0,
        retained: retained.get(id) ?? 0,
        verdicts: verdicts.get(id) ?? [],
        others: others.get(id) ?? [],
      }));
  }).value;
  const since = sinceEpoch.value;
  const only = onlyRegressions.value;
  const inScope = since === undefined ? all : all.filter((x) => x.id >= since);
  const rows = only ? inScope.filter((x) => x.verdicts.some((v) => v.status === "regressed")) : inScope;
  rowOrder = rows.map((x) => x.id);
  // "This session": a restart with `persist: true` restores the earlier sessions' edits (greyed below).
  const mine = all.filter((x) => isSessionEdit(x.id, x.info));
  const edits = mine.length;
  const earlier = all.filter((x) => x.info?.session !== undefined && x.info.via !== "start" && x.id > 0).length;
  const regressedEdits = mine.filter((x) => x.verdicts.some((v) => v.status === "regressed")).length;
  const traces = tracesState.value;
  const selected = r.epoch !== undefined ? Number(r.epoch) : undefined;
  const listRef = useRef<HTMLOListElement>(null);

  // #/changes/e<id> (a tick, the rail, the toast, j / k): bring that edit into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows.length re-runs it once the row exists
  useEffect(() => {
    if (r.epoch === undefined) return;
    listRef.current?.querySelector(`[data-epoch="${CSS.escape(r.epoch)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [r.epoch, rows.length]);

  const hidden = all.length - rows.length;
  const why = [since !== undefined ? `before e${since}` : "", only ? "without a regression" : ""].filter(Boolean);

  return (
    <section class="chg" aria-labelledby="changes-title">
      <header class="list-head chg-head">
        <h2 id="changes-title" class="list-title">
          Changes {edits > 0 && <span class="count">{edits}</span>}
        </h2>
        <span class="dim chg-sub">
          {edits === 0
            ? "no edits yet this session"
            : `${edits} edit${edits === 1 ? "" : "s"} this session${regressedEdits ? ` · ${regressedEdits} made a route slower` : ""}`}
          {earlier > 0 && ` · ${earlier} from earlier sessions`}
        </span>
        <SinceChip detail={`${inScope.length}/${all.length}`} title={`Edits e${since} and later only.`} />
        <fieldset class="chips chg-filter">
          <legend class="sr-only">Which edits</legend>
          <button
            type="button"
            class={`chip ${only ? "chip-active" : ""}`}
            aria-pressed={only}
            onClick={() => (onlyRegressions.value = true)}
            title="Only edits after which a route got slower"
          >
            Only regressions
          </button>
          <button
            type="button"
            class={`chip ${!only ? "chip-active" : ""}`}
            aria-pressed={!only}
            onClick={() => (onlyRegressions.value = false)}
          >
            All
          </button>
        </fieldset>
        {rows.length > 0 && (
          <span class="list-hint dim">
            <kbd>j</kbd> <kbd>k</kbd> move
          </span>
        )}
      </header>

      {epochsState.value === "unavailable" && (
        <p class="chg-note dim">
          This Hoplens core does not report edits (no /api/epochs): showing the rebuild epochs seen on requests, without
          files or verdicts.
        </p>
      )}

      {/* Keyed on this session's edits, not on `all`: e0 (session start) is always listed, so an
          `all.length === 0` check never showed this to someone who hadn't saved a file yet. */}
      {edits > 0 && (
        <p class="chg-note dim">
          Each save is an edit. For each route it affects, Hoplens compares the typical response time (p50) of warm
          requests before and after it; <span class="mono">n 6|3</span> counts them on each side. Too few is low
          confidence: <b>replay ×10</b> sends more. <b>compare before / after</b> opens one request from each side next
          to each other, to see what changed.
        </p>
      )}
      {edits === 0 && (
        <p class="chg-empty muted">
          No edits yet. Save a source file while <code>next dev</code> runs and send a request: each rebuild shows up
          here with the files it changed and how each affected route moved.
        </p>
      )}
      {all.length > 0 && (
        <>
          <ChangesTrack selected={selected} />
          {hidden > 0 && (
            <output class="chg-note dim">
              Showing {rows.length} of {all.length}: {hidden} hidden {why.join(" or ")}.{" "}
              {only && (
                <button type="button" class="link-btn" onClick={() => (onlyRegressions.value = false)}>
                  Show all
                </button>
              )}
            </output>
          )}
          {rows.length === 0 ? (
            <p class="chg-empty muted">
              {only ? "No edit made a route slower" : "No edits"}
              {since !== undefined ? ` since e${since}` : ""}.
            </p>
          ) : (
            <ol class="chg-list" ref={listRef}>
              {rows.map((x) => (
                <EpochRow key={x.id} row={x} on={selected === x.id} traces={traces} only={only} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- one edit */

function filesText(info: EpochView | undefined): { text: string; title: string } {
  if (!info) return { text: "epoch seen on requests", title: "" };
  if (info.id === 0) return { text: "session start", title: "The baseline for the first edit" };
  if (info.via === "start") return { text: "dev server restarted", title: "A new dev session began here" };
  const files = [...info.files, ...info.deleted.map((f) => `${f} (deleted)`)];
  if (files.length) {
    const more = files.length - 2 + info.moreFiles;
    return { text: `${files.slice(0, 2).join(", ")}${more > 0 ? ` +${more}` : ""}`, title: files.join("\n") };
  }
  if (info.candidates.length) {
    const names = [...new Set(info.candidates.map(candidateName))];
    return {
      text:
        names.length === 1
          ? (names[0] as string)
          : `one of: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`,
      title: `Named by the rebuilt chunks, not by a file save:\n${info.candidates.join("\n")}`,
    };
  }
  return { text: "no source change seen", title: "A rebuild with no saved source file and no named chunk" };
}

function selectEpoch(id: number, replace = true): void {
  const since = route.peek().since;
  go(since ? { view: "changes", epoch: String(id), since } : { view: "changes", epoch: String(id) }, { replace });
}

function EpochRow({
  row,
  on,
  traces,
  only,
}: { row: EpochRowData; on: boolean; traces: readonly TraceSummary[]; only: boolean }) {
  const { id, info, n, retained } = row;
  const past = info?.session !== undefined;
  const verdicts = only ? row.verdicts.filter((v) => v.status === "regressed") : row.verdicts;
  const bad = row.verdicts.some((v) => v.status === "regressed");
  const f = filesText(info);
  const routes = info?.routes ?? [];
  const since = sinceEpoch.value;
  // A restored edit older than every route's kept epochs: its requests were counted, but no longer
  // per epoch (the server keeps each route's newest few), so "0 req" would be wrong.
  const aged = past && n === 0;
  const none =
    id === 0 || info?.via === "start"
      ? "Session start: what the first edit is compared with."
      : aged
        ? "From an earlier session; its requests are older than the per-route stats window."
        : routes.length > 0 && n === 0
          ? "No affected traffic yet."
          : n > 0
            ? `${n} request${n === 1 ? "" : "s"}; no route compared yet (each needs 3 warm requests on both sides).`
            : "No traffic in this edit.";
  return (
    <li
      class={`chg-epoch ${on ? "chg-epoch-on" : ""} ${bad ? "chg-epoch-bad" : ""} ${past ? "chg-epoch-past" : ""}`}
      data-epoch={String(id)}
    >
      <div class="chg-epoch-head">
        <button
          type="button"
          class="chg-eid mono"
          aria-current={on ? "true" : undefined}
          onClick={() => selectEpoch(id, false)}
          title="Select this edit"
        >
          e{id}
        </button>
        {info && info.at > 0 && <span class="mono dim">{new Date(info.at).toLocaleTimeString()}</span>}
        <span class="chg-files mono" title={f.title}>
          {f.text}
        </span>
        {info && id > 0 && <span class="dim chg-via">({viaLabel(info)})</span>}
        {past && (
          <span class="chg-past-tag dim" title="Restored from an earlier dev session (persist: true)">
            session {info.session}
          </span>
        )}
        {routes.length > 0 && (
          <span class="chg-affects dim" title={routes.join("\n")}>
            affects {routes.slice(0, 3).join(", ")}
            {routes.length > 3 ? ` +${routes.length - 3}` : ""}
          </span>
        )}
        <span class="chg-epoch-actions">
          <span
            class="mono dim"
            title={
              aged
                ? "Not known any more: the server keeps each route's newest epochs only"
                : n > retained
                  ? `${n} requests built by this edit (${retained} still retained to open)`
                  : "Retained requests built by this edit"
            }
          >
            {aged ? "–" : n} req
          </span>
          {since !== id && (
            <button
              type="button"
              class="link-btn"
              onClick={() => setSince(String(id))}
              title="Scope the lists (Overview, Requests, Changes) to this edit and later"
            >
              since e{id}
            </button>
          )}
          {retained > 0 && (
            <button
              type="button"
              class="link-btn"
              onClick={() => go({ view: "requests", since: String(id) })}
              title="Open the request log scoped to this edit and later"
            >
              requests
            </button>
          )}
        </span>
      </div>
      {verdicts.length > 0 ? (
        <ul class="vrows">
          {verdicts.map((v) => (
            <VerdictRow key={regressionId(v)} r={v} traces={traces} />
          ))}
        </ul>
      ) : (
        <p class="chg-none dim">{none}</p>
      )}
      {!only && row.others.length > 0 && (
        <details class="chg-others">
          <summary class="dim">
            {row.others.length} other route{row.others.length === 1 ? "" : "s"} this edit doesn't touch (traffic drift,
            not this edit)
          </summary>
          <ul class="vrows">
            {row.others.map((v) => (
              <VerdictRow key={regressionId(v)} r={v} traces={traces} />
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ track */

const LANE_Y = { ok: 34, slow: 42, error: 50 } as const;

/** Small stable jitter so dots in one lane don't sit on one line. */
function jitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 5) - 2;
}

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

function ChangesTrack({ selected }: { selected?: number }) {
  const epochs = epochList.value;
  const traces = tracesState.value;
  const verdicts = verdictsByEpoch.value;
  const now = nowTick.value;
  const since = sinceEpoch.value;
  const ref = useRef<HTMLDivElement>(null);
  // Labels need ~150px each (labelGap): at phone width the fixed 7% gap let close edits overlap.
  const width = useSignal(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => (width.value = el.clientWidth));
    ro.observe(el);
    width.value = el.clientWidth;
    return () => ro.disconnect();
  }, [width]);
  const w = width.value;
  const tl = useMemo(
    () => buildTimeline(epochs, traces, verdicts, now, { minLabelGap: labelGap(w) }),
    [epochs, traces, verdicts, now, w],
  );
  const brush = useSignal<{ x0: number; x1: number } | null>(null);

  const frac = (e: PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  };
  const onDown = (e: PointerEvent) => {
    if ((e.target as Element).closest?.("button") || e.button !== 0) return;
    const x = frac(e);
    brush.value = { x0: x, x1: x };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const b = brush.peek();
    if (b) brush.value = { x0: b.x0, x1: frac(e) };
  };
  const onUp = () => {
    const b = brush.peek();
    brush.value = null;
    if (!b || Math.abs(b.x1 - b.x0) < 0.01 || epochs.length === 0) return;
    const t = tl.t0 + Math.min(b.x0, b.x1) * (tl.t1 - tl.t0);
    const id = epochAt(epochs, t);
    if (id !== undefined) setSince(String(id));
  };

  const scopeX = since !== undefined ? tl.ticks.find((t) => t.id === since)?.x : undefined;
  const b = brush.value;

  return (
    <div
      class="chg-track"
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => (brush.value = null)}
      title="Click a tick to select an edit. Drag across the track to scope the lists to the edits from there on."
    >
      <svg class="chg-svg" width="100%" height="58" aria-hidden="true">
        {scopeX !== undefined && <rect class="chg-scope" x={pct(scopeX)} y="0" width={pct(1 - scopeX)} height="58" />}
        <line class="chg-axis" x1="0" x2="100%" y1="22" y2="22" />
        {tl.dots.map((d) => (
          <circle
            key={d.id}
            class={`chg-dot chg-dot-${d.tone}`}
            cx={pct(d.x)}
            cy={LANE_Y[d.tone] + jitter(d.id)}
            r="2.5"
          />
        ))}
        {tl.ticks.map((t) => (
          <line
            key={t.id}
            class={`chg-tick ${selected === t.id ? "chg-tick-on" : ""}`}
            x1={pct(t.x)}
            x2={pct(t.x)}
            y1="16"
            y2="28"
          />
        ))}
        {tl.ticks
          .filter((t) => t.regressed)
          .map((t) => (
            <line key={`cap${t.id}`} class="chg-cap" x1={pct(t.x)} x2={pct(t.x)} y1="10" y2="16" />
          ))}
        {b && (
          <rect class="chg-brush" x={pct(Math.min(b.x0, b.x1))} y="0" width={pct(Math.abs(b.x1 - b.x0))} height="58" />
        )}
      </svg>
      <ol class="chg-ticks" aria-label="Edits on the timeline">
        {tl.ticks.map((t) => (
          <li
            key={t.id}
            class={`chg-tick-item ${t.x > 0.85 ? "chg-tick-end" : t.x < 0.1 ? "chg-tick-start" : ""}`}
            style={{ left: pct(t.x) }}
          >
            <button
              type="button"
              class={`chg-tick-btn mono ${selected === t.id ? "chg-tick-btn-on" : ""} ${t.regressed ? "chg-tick-btn-bad" : ""}`}
              onClick={() => selectEpoch(t.id, false)}
              title={`${t.label}${t.at ? ` · ${new Date(t.at).toLocaleTimeString()}` : ""}${t.regressed ? " · a route got slower" : ""}`}
              aria-label={`${t.label}${t.regressed ? ", a route got slower" : ""}`}
            >
              {t.showLabel ? shortTick(t.label) : ""}
            </button>
          </li>
        ))}
      </ol>
      {/* The legend sits on the axis-labels row, between the times: in the tick band it covered the
          label of an edit near "now" (r3). */}
      <div class="chg-axis-labels dim">
        <span class="mono" aria-hidden="true">
          {new Date(tl.t0).toLocaleTimeString()}
        </span>
        <ul class="chg-legend" aria-label="Dot colours">
          <li>
            <span class="chg-swatch chg-swatch-ok" aria-hidden="true" /> ok
          </li>
          <li>
            <span class="chg-swatch chg-swatch-slow" aria-hidden="true" /> slow
          </li>
          <li>
            <span class="chg-swatch chg-swatch-error" aria-hidden="true" /> error
          </li>
        </ul>
        <span class="mono" aria-hidden="true">
          {tl.endsNow ? "now" : `${new Date(tl.t1).toLocaleTimeString()} (quiet since)`}
        </span>
      </div>
    </div>
  );
}

/** "e7 src/lib/store.ts" stays as is; long names are cut to keep ticks apart. */
function shortTick(label: string): string {
  const [id, ...rest] = label.split(" ");
  const name = rest.join(" ");
  const short = name.length > 18 ? `${baseName(name).slice(0, 17)}…` : name;
  return short ? `${id} ${short}` : (id as string);
}

/* ------------------------------------------------------------------- keys */

/** j / k on Changes: the next (older) / previous (newer) edit in the list on screen. */
function stepRow(delta: number): void {
  if (!rowOrder.length) return;
  const r = route.peek();
  const cur = r.view === "changes" && r.epoch !== undefined ? rowOrder.indexOf(Number(r.epoch)) : -1;
  const next =
    cur < 0 ? (delta > 0 ? 0 : rowOrder.length - 1) : Math.min(rowOrder.length - 1, Math.max(0, cur + delta));
  const id = rowOrder[next];
  if (id !== undefined && next !== cur) selectEpoch(id);
}

const onChanges = () => route.value.view === "changes" && epochList.value.length + tracesState.value.length > 0;

register("list", "j", "Next (older) edit", () => stepRow(1), { when: onChanges, hint: "move" });
register("list", "k", "Previous (newer) edit", () => stepRow(-1), { when: onChanges, hint: "move" });
