import { useComputed } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
  ago,
  dismissToast,
  epochLabel,
  epochList,
  epochsState,
  latestEdit,
  nowTick,
  rebuildToast,
  scheduleToastHide,
  startEpochs,
  toastText,
  verdictsByEpoch,
} from "../state/epochs";
import { go, route, setSince } from "../state/router";
import { scopeApplies, scopeLabel, sinceEpoch } from "../state/sinceScope";
import { mainView, tracesState } from "../state/store";
import "../styles/changes.css";

/*
 * The edit rail in the top bar's status line (plan 3.2 / 3.5): a 6px track with one tick per edit
 * (dev rebuild), sized by its traffic, a red cap on an edit that made a route slower, then the
 * newest edit's name and age ("e7 store.ts 12s ago"). Clicking a tick opens Changes at it.
 * It also starts the epochs feed (state/epochs) and draws the rebuild toast, so both exist on every
 * view without touching the shell. On a view the since scope doesn't filter, it says so here.
 */

const MAX_TICKS = 24;

export function EpochRail() {
  useEffect(() => startEpochs(), []);
  const ticks = useComputed(() => {
    const counts = new Map<number, number>();
    for (const t of tracesState.value) {
      const e = t.facts?.epoch;
      if (e === undefined || t.kind === "asset") continue;
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    const server = epochList.value;
    const verdicts = verdictsByEpoch.value;
    // The server's edits when it has them (names, edits with no traffic yet); else the epochs on requests.
    const ids = server.length ? server.map((e) => e.id) : [...counts.keys()].sort((a, b) => a - b);
    const byId = new Map(server.map((e) => [e.id, e]));
    return ids.slice(-MAX_TICKS).map((id) => {
      const info = byId.get(id);
      const v = verdicts.get(id) ?? [];
      return {
        id,
        n: counts.get(id) ?? 0,
        name: info ? epochLabel(info) : undefined,
        at: info?.at,
        regressed: v.filter((r) => r.status === "regressed").length,
      };
    });
  }).value;
  const r = route.value;
  const since = sinceEpoch.value;
  const latest = latestEdit.value;
  const now = nowTick.value;

  if (ticks.length === 0)
    return (
      <div class="epoch-rail epoch-rail-empty">
        <RebuildToast />
      </div>
    );
  const total = ticks.reduce((s, t) => s + t.n, 0) || 1;
  const current = ticks[ticks.length - 1];

  return (
    <div class="epoch-rail">
      <ol class="epoch-ticks" aria-label="Edits (dev rebuilds), oldest first">
        {ticks.map((t) => {
          const on = (r.view === "changes" && r.epoch === String(t.id)) || since === t.id;
          const inScope = since !== undefined && t.id >= since;
          const name = t.name ? ` ${t.name}` : "";
          const when = t.at ? ` · ${new Date(t.at).toLocaleTimeString()}` : "";
          const bad = t.regressed > 0 ? ` · ${t.regressed} route${t.regressed === 1 ? "" : "s"} slower` : "";
          return (
            <li key={t.id} style={{ flexGrow: 1 + (t.n / total) * 10 }}>
              <button
                type="button"
                class={`epoch-tick ${on ? "epoch-tick-on" : ""} ${inScope && !on ? "epoch-tick-scope" : ""} ${t.regressed > 0 ? "epoch-tick-bad" : ""}`}
                title={`e${t.id}${name}${when} · ${t.n} request${t.n === 1 ? "" : "s"}${bad}`}
                aria-label={`Edit e${t.id}${name}, ${t.n} requests${bad}`}
                onClick={() =>
                  go(
                    since !== undefined
                      ? { view: "changes", epoch: String(t.id), since: String(since) }
                      : { view: "changes", epoch: String(t.id) },
                  )
                }
              />
            </li>
          );
        })}
      </ol>
      {latest ? (
        <button
          type="button"
          class="epoch-now mono"
          onClick={() => go({ view: "changes", epoch: String(latest.id) })}
          title={`Newest edit: ${[...latest.files, ...latest.deleted].join(", ") || epochLabel(latest)} (open in Changes)`}
        >
          e{latest.id} {epochLabel(latest)} <span class="dim">{ago(latest.at, now)}</span>
        </button>
      ) : (
        current && (
          <span
            class="epoch-now mono"
            title={
              epochsState.value === "unavailable"
                ? "Current dev-rebuild epoch (this core does not attribute edits)"
                : "No edit yet this session"
            }
          >
            e{current.id}
          </span>
        )
      )}
      {since !== undefined && !scopeApplies(mainView.value) && (
        <span
          class="scope-chip scope-chip-off"
          title="The since scope is set, but this view's numbers are kept per query shape for the whole session, so it is not filtered"
        >
          since {scopeLabel(since)} · not applied here
          <button
            type="button"
            class="scope-chip-x"
            aria-label="Clear the since scope"
            onClick={() => setSince(undefined)}
          >
            ×
          </button>
        </span>
      )}
      <RebuildToast />
    </div>
  );
}

/**
 * "store.ts rebuilt · /api/products +134%": shown only when an edit made a route slower (plan 3.5).
 * Clicking it opens Changes at that edit. Hides after 12s unless the pointer is on it.
 */
function RebuildToast() {
  const t = rebuildToast.value;
  if (!t) return null;
  return (
    <output class="rebuild-toast" onMouseEnter={() => scheduleToastHide(true)} onMouseLeave={() => scheduleToastHide()}>
      <span class="sev-dot sev-error" aria-hidden="true" />
      <button
        type="button"
        class="rebuild-toast-open"
        onClick={() => {
          go({ view: "changes", epoch: String(t.epoch) });
          dismissToast();
        }}
        title="Open Changes at this edit"
      >
        {toastText(t)}
      </button>
      <button type="button" class="scope-chip-x" aria-label="Dismiss" onClick={dismissToast}>
        ×
      </button>
    </output>
  );
}
