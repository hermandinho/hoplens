import { signal } from "@preact/signals";
import type { RouteRegression, TraceRecord, TraceSummary } from "../api/types";
import {
  ago,
  comparePair,
  describeRegression,
  elapsed,
  epochById,
  epochLabel,
  latestEdit,
  nowTick,
  otherVerdictsByEpoch,
  pctText,
  refreshRegressions,
  regressionId,
  regressionMap,
  regressionRule,
  replayPath,
  verdictsByEpoch,
} from "../state/epochs";
import { replayBusy, runSideBatch } from "../state/replay";
import { go, route, setSince } from "../state/router";
import { sinceEpoch } from "../state/sinceScope";
import { fmtMs, routeKeyOf } from "../state/stats";
import { tracesState } from "../state/store";
import { shortLoc } from "../state/verdict";
import { sinceStripSlot } from "./Overview";
import "../styles/changes.css";

/*
 * "Since your last edit" (plan 3.3 / 3.5): the strip the Overview draws under its hero, the verdict
 * row shared with the Changes table, and the trace subject's "built after e7 store.ts" line.
 */

/* ------------------------------------------------------------- verdict row */

/** Hover text for describeRegression's glyphs. */
const GLYPH_TITLES: Record<string, string> = {
  "!": "Slower after this edit",
  "-": "Faster after this edit",
  "=": "Unchanged",
  "~": "Waiting for traffic",
  "?": "No traffic since the edit",
};

type ReplayState = { state: "running" } | { state: "done"; text: string } | { state: "error"; text: string };
/** Replay x10 progress per verdict row (`key@epoch`). */
const replays = signal<ReadonlyMap<string, ReplayState>>(new Map());

function setReplay(id: string, s: ReplayState | null): void {
  const next = new Map(replays.peek());
  if (s) next.set(id, s);
  else next.delete(id);
  replays.value = next;
}

async function replay(r: RouteRegression, path: string): Promise<void> {
  const id = regressionId(r);
  setReplay(id, { state: "running" });
  try {
    const res = await runSideBatch({ method: r.method, path });
    const w = res.warm;
    const cold = res.coldExcluded ? `, ${res.coldExcluded} cold left out` : "";
    const stopped = res.stopped ? ` (stopped: ${res.stopped})` : "";
    setReplay(id, {
      state: "done",
      text:
        w && w.n > 0
          ? `replayed: p50 ${fmtMs(w.p50)} over ${w.n} warm runs${cold}${stopped}`
          : `no warm run${cold}${stopped}`,
    });
  } catch (err) {
    setReplay(id, { state: "error", text: err instanceof Error ? err.message.slice(0, 120) : "replay failed" });
  }
  void refreshRegressions();
}

/**
 * One verdict: glyph, route, p50 before -> after, the % change, the I/O count and bucket that grew,
 * n on each side, and the actions (compare a typical request from each side; replay x10 when the
 * route has no or too little traffic since the edit, or to confirm a regression).
 */
export function VerdictRow({ r, traces }: { r: RouteRegression; traces: readonly TraceSummary[] }) {
  const d = describeRegression(r, regressionRule.value?.minN);
  const judged = r.status === "regressed" || r.status === "improved" || r.status === "unchanged";
  const pair = judged ? comparePair(r, traces) : undefined;
  const path = r.status !== "improved" && r.status !== "unchanged" ? replayPath(r, traces) : undefined;
  const rp = replays.value.get(regressionId(r));
  const since = route.value.since;
  // "low confidence" alone left people guessing what to do: name the action when there is one.
  const note = d.note && r.lowConfidence && judged && path && !rp ? `${d.note}: replay ×10 to confirm` : d.note;
  return (
    <li class={`vrow vrow-${r.status} ${r.lowConfidence && judged ? "vrow-low" : ""}`}>
      <span class={`vrow-glyph vrow-tone-${d.tone} mono`} title={GLYPH_TITLES[d.glyph]} aria-hidden="true">
        {d.glyph}
      </span>
      <button
        type="button"
        class="vrow-route mono"
        onClick={() => go(since ? { view: "overview", routeKey: r.key, since } : { view: "overview", routeKey: r.key })}
        title={`Open ${r.key} on the Overview${r.basis === "variants" && r.urls?.length ? `. Compared over the same URLs on both sides: ${r.urls.join(", ")}` : ""}`}
      >
        {r.method} {r.route}
      </button>
      <span class="vrow-facts">
        {d.p50 && (
          <span
            class="mono"
            title={`Typical (median, warm) response time before the edit (e${r.baselineEpoch}) -> after it (e${r.epoch})`}
          >
            p50 {d.p50}
          </span>
        )}
        {d.pct && (
          <span
            class={`ov-delta ov-delta-${d.tone === "none" ? "same" : d.tone} mono`}
            title="Change in the typical response time"
          >
            {d.pct}
          </span>
        )}
        {d.io && (
          <span class="mono" title="Average calls per request, before -> after">
            {d.io}
          </span>
        )}
        {d.grew && (
          <span class="mono dim" title="The time bucket that grew most (average self time per request)">
            {d.grew}
          </span>
        )}
        {d.n && (
          <span class="mono dim" title="Warm requests before | after the edit (8+ on both sides for full confidence)">
            {d.n}
          </span>
        )}
        {note && (
          <span
            class={r.lowConfidence ? "vrow-note-low" : "dim"}
            title={
              r.lowConfidence
                ? `Fewer than ${regressionRule.value?.confidentN ?? 8} warm requests on one side: the numbers can still move`
                : undefined
            }
          >
            {note}
          </span>
        )}
        {r.findings.added.length > 0 && (
          <span class="vrow-find" title={r.findings.added.map((f) => f.title).join("\n")}>
            + {r.findings.added.length} new finding{r.findings.added.length === 1 ? "" : "s"}
          </span>
        )}
      </span>
      <span class="vrow-actions">
        {judged && r.status !== "unchanged" && (
          <button
            type="button"
            class="sbtn"
            disabled={!pair}
            onClick={() => pair && go({ view: "compare", a: pair.a, b: pair.b })}
            title={
              pair
                ? `Open a typical request from before the edit (e${r.baselineEpoch}) next to one from after it (e${r.epoch}), to see which spans changed`
                : "Can't compare: this page no longer holds a warm request from both sides. Send the route again (or replay ×10) to get one."
            }
          >
            compare before / after
          </button>
        )}
        {path && (
          <button
            type="button"
            class="sbtn"
            disabled={rp?.state === "running" || replayBusy()}
            onClick={() => void replay(r, path)}
            title={
              replayBusy() && rp?.state !== "running"
                ? "Another replay is running; the core runs one batch at a time"
                : `Send ${r.method} ${path} 10 times; cold runs are left out of the numbers`
            }
          >
            {rp?.state === "running" ? "replaying…" : "replay ×10"}
          </button>
        )}
        {rp && rp.state !== "running" && (
          <output class={`mono ${rp.state === "error" ? "vrow-note-low" : "dim"}`}>{rp.text}</output>
        )}
      </span>
    </li>
  );
}

/* ------------------------------------------------------------ overview strip */

/** Verdicts that moved (regressed or improved), in their given order. Pure. */
export function movedOf(verdicts: readonly RouteRegression[]): RouteRegression[] {
  return verdicts.filter((r) => r.status === "regressed" || r.status === "improved" || r.fixes !== undefined);
}

/** The strip's edit dismissed with ×; a newer edit brings it back. */
const dismissedStrip = signal<number | null>(null);
const STRIP_ROWS = 3;

/**
 * Overview strip: the scope's edit when one is set, else the newest. Regressions first with
 * before/after, then one line for the rest (new findings, resolved, unchanged, waiting, no traffic).
 * Nothing when there has been no edit this session.
 */
export function SinceStrip() {
  const scoped = sinceEpoch.value;
  const latest = latestEdit.value;
  const id = scoped ?? latest?.id;
  const info = id !== undefined ? epochById.value.get(id) : undefined;
  const now = nowTick.value;
  if (id === undefined || id === 0 || !info) return null;
  if (scoped === undefined && dismissedStrip.value === id) return null;
  const verdicts = verdictsByEpoch.value.get(id) ?? [];
  const traces = tracesState.value;
  const moved = movedOf(verdicts);
  const drift = movedOf(otherVerdictsByEpoch.value.get(id) ?? []).length;
  const shown = moved.slice(0, STRIP_ROWS);
  const count = (s: RouteRegression["status"]) => verdicts.filter((r) => r.status === s).length;
  const unchanged = verdicts.filter((r) => r.status === "unchanged" && r.fixes === undefined).length;
  const waiting = count("insufficient");
  const silent = count("no-traffic");
  const added = new Map<string, RouteRegression["findings"]["added"][number]>();
  const removed = new Map<string, RouteRegression["findings"]["removed"][number]>();
  for (const r of verdicts) {
    for (const f of r.findings.added) added.set(f.fingerprint, f);
    for (const f of r.findings.removed) removed.set(f.fingerprint, f);
  }
  const bad = verdicts.some((r) => r.status === "regressed");
  const files = [...info.files, ...info.deleted];

  return (
    <section class={`since-strip ${bad ? "since-strip-bad" : ""}`} aria-label={`Since edit e${id}`}>
      <div class="since-head">
        <span class="since-title">
          Since <span class="mono">{epochLabel(info)}</span>
        </span>
        <span
          class="mono dim"
          title={files.length ? files.join("\n") : `Rebuild noticed ${new Date(info.at).toLocaleTimeString()}`}
        >
          e{id}, {ago(info.at, now)}
        </span>
        {info.routes.length > 0 && (
          <span class="dim" title={info.routes.join("\n")}>
            affects {info.routes.length} route{info.routes.length === 1 ? "" : "s"}
          </span>
        )}
        <span class="since-actions">
          {scoped === undefined && (
            <button
              type="button"
              class="link-btn"
              onClick={() => setSince(String(id))}
              title="Scope the lists to this edit and later (key s)"
            >
              scope to e{id}+
            </button>
          )}
          <button
            type="button"
            class="link-btn"
            onClick={() =>
              go(
                scoped !== undefined
                  ? { view: "changes", epoch: String(id), since: String(scoped) }
                  : { view: "changes", epoch: String(id) },
              )
            }
          >
            Changes
          </button>
          {scoped === undefined && (
            <button
              type="button"
              class="scope-chip-x"
              aria-label="Dismiss until the next edit"
              title="Hide until the next edit"
              onClick={() => (dismissedStrip.value = id)}
            >
              ×
            </button>
          )}
        </span>
      </div>
      {shown.length > 0 && (
        <ul class="vrows">
          {shown.map((r) => (
            <VerdictRow key={regressionId(r)} r={r} traces={traces} />
          ))}
        </ul>
      )}
      <p class="since-summary">
        {moved.length > shown.length && (
          <button type="button" class="link-btn" onClick={() => go({ view: "changes", epoch: String(id) })}>
            {moved.length - shown.length} more in Changes
          </button>
        )}
        {[...added.values()].slice(0, 2).map((f) => (
          <span key={f.fingerprint} class="since-find">
            + new finding: {f.title}
            {f.location && <span class="mono dim"> ({shortLoc(f.location)})</span>}
          </span>
        ))}
        {removed.size > 0 && (
          <span class="since-find">
            - resolved: {[...removed.values()][0]?.title}
            {removed.size > 1 ? ` +${removed.size - 1}` : ""}
          </span>
        )}
        {unchanged > 0 && (
          <span class="dim">
            = {unchanged} route{unchanged === 1 ? "" : "s"} unchanged
          </span>
        )}
        {waiting > 0 && (
          <span class="dim" title="A route is judged once it has 3 warm requests on both sides of the edit">
            ~ {waiting} waiting for traffic
          </span>
        )}
        {silent > 0 && <span class="dim">? {silent} affected, no traffic since</span>}
        {drift > 0 && (
          <button
            type="button"
            class="link-btn"
            onClick={() => go({ view: "changes", epoch: String(id) })}
            title="Routes this edit doesn't touch that still moved (traffic drift, not this edit); Changes lists them"
          >
            {drift} other route{drift === 1 ? "" : "s"} moved (not this edit)
          </button>
        )}
        {verdicts.length === 0 && (
          <span class="dim">
            No route compared yet: each needs {regressionRule.value?.minN ?? 3} warm requests on both sides of the edit.
          </span>
        )}
      </p>
    </section>
  );
}

sinceStripSlot.value = SinceStrip;

/* ---------------------------------------------------------- trace subject */

/**
 * Under the trace's baselines: which edit built this request ("Built after e7 store.ts, 12s
 * before"), how its route moved at that edit, and whether newer edits exist since.
 */
export function EditContext({ trace }: { trace: TraceRecord }) {
  const e = trace.facts?.epoch;
  if (e === undefined || e === 0) return null;
  const info = epochById.value.get(e);
  const v = regressionMap.value.get(`${routeKeyOf(trace)}@${e}`);
  const latest = latestEdit.value;
  if (!info && !v) return null;
  const newer = latest && latest.id > e ? latest.id - e : 0;
  const d = v ? describeRegression(v) : undefined;
  return (
    <p class="edit-ctx">
      <span class="dim">Built after</span>{" "}
      <button
        type="button"
        class="link-btn mono"
        onClick={() => go({ view: "changes", epoch: String(e) })}
        title={
          info
            ? [...info.files, ...info.deleted].join("\n") || "Open this edit in Changes"
            : "Open this edit in Changes"
        }
      >
        e{e}
        {info ? ` ${epochLabel(info)}` : ""}
      </button>
      {info && trace.startedAt >= info.at && (
        <span class="dim"> {elapsed(trace.startedAt - info.at)} before this request</span>
      )}
      {v && d && (v.status === "regressed" || v.status === "improved") && (
        <>
          <span class="dim"> · route p50 {d.p50} </span>
          <span class={`ov-delta ov-delta-${d.tone} mono`}>{d.pct ?? pctText(v.deltaPct)}</span>
          <span class="dim"> vs e{v.baselineEpoch}</span>
        </>
      )}
      {v && v.status === "unchanged" && <span class="dim"> · route unchanged vs e{v.baselineEpoch}</span>}
      {newer > 0 && (
        <span class="dim">
          {" "}
          · {newer} newer edit{newer === 1 ? "" : "s"} since
        </span>
      )}
    </p>
  );
}
