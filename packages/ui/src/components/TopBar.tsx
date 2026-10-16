import { useComputed } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { QUERY_INPUT_MAIN } from "../state/requestLog";
import { go, route } from "../state/router";
import {
  type MainView,
  actionError,
  bootstrap,
  clearTraces,
  clearing,
  findingGroups,
  followLive,
  hasRoutes,
  liveStatus,
  loadError,
  loadStatus,
  mainView,
  metaState,
  openBuilder,
  setMainView,
  toggleFollow,
  tracesState,
  tracesWithErrors,
} from "../state/store";
import { QueryBar } from "./RequestLog";

/*
 * The top bar (plan 3.2): brand, the four view tabs, the request filter, the live controls, then a
 * thin status line holding two slots other work packages fill in:
 *   <EpochRail/>  edit ticks (WP9b draws the real rail; this one marks the dev-rebuild epochs seen)
 *   <StatusSlot/> runtime status (WP6 adds loop p99 and RSS next to the live dot)
 * Problems that used to be a full-width banner (StatusBanner) now render as one notice line here.
 */

const VIEWS: ReadonlyArray<{ id: MainView; label: string; title: string }> = [
  { id: "overview", label: "Overview", title: "What to fix first: findings, routes, errors" },
  { id: "requests", label: "Requests", title: "The live request log; pick one to open it beside the list" },
  { id: "queries", label: "Queries", title: "Every db, cache and fetch call across requests, and the hosts called" },
  { id: "changes", label: "Changes", title: "Your edits (dev rebuilds) and what each one changed" },
];

export function TopBar() {
  const view = mainView.value;
  const follow = followLive.value;
  const traceCount = tracesState.value.length;
  const errCount = tracesWithErrors.value;
  // Only the group count: reading kpis here would recompute every stat even with the Overview hidden.
  const findings = findingGroups.value.length;

  return (
    <header class="top">
      <div class="top-row">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">
            ◆
          </span>
          <span class="brand-name">Hoplens</span>
        </div>

        <nav class="view-nav" aria-label="Views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              class="action view-nav-btn"
              aria-current={view === v.id ? "page" : undefined}
              onClick={() => setMainView(v.id)}
              title={v.title}
            >
              {v.label}
              {v.id === "overview" && findings > 0 && (
                <span class="tab-count action-count" title={`${findings} finding groups`}>
                  {findings}
                </span>
              )}
              {v.id === "requests" && traceCount > 0 && <span class="tab-count action-count">{traceCount}</span>}
              {v.id === "requests" && errCount > 0 && (
                <span class="tab-count tab-count-err" aria-label={`${errCount} with 5xx errors`}>
                  {errCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div
          class="top-filter"
          // Typing a filter anywhere shows the list it filters.
          onInput={() => {
            if (mainView.peek() !== "requests") setMainView("requests");
          }}
        >
          <QueryBar id={QUERY_INPUT_MAIN} variant="compact" />
        </div>

        <div class="actions">
          <button
            type="button"
            class="action"
            onClick={() => openBuilder()}
            title="Compose a request to one of your routes"
          >
            New request
          </button>
          <button
            type="button"
            class="action"
            aria-pressed={follow}
            onClick={toggleFollow}
            title="Open each new request as it arrives (paused while the pointer is on the list)"
          >
            <span class={`dot ${follow ? "on" : ""}`} aria-hidden="true" />
            Follow
          </button>
          <button
            type="button"
            class="action"
            onClick={() => void bootstrap()}
            title="Re-scan routes and reload traces"
          >
            Refresh
          </button>
          <ClearButton count={traceCount} />
        </div>
      </div>

      <div class="top-status">
        <EpochRail />
        <StatusSlot />
      </div>

      <TopNotice />
    </header>
  );
}

/**
 * Edit ticks: one segment per dev-rebuild epoch seen in the retained requests (oldest left), sized
 * by its request count. Clicking one opens Changes at that epoch. WP9b replaces this with the
 * attributed rail (file names, regression caps) once /api/epochs exists.
 */
export function EpochRail() {
  const epochs = useComputed(() => {
    const counts = new Map<number, number>();
    for (const t of tracesState.value) {
      const e = t.facts?.epoch;
      if (e === undefined || t.kind === "asset") continue;
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).slice(-24);
  }).value;
  const r = route.value;
  if (epochs.length === 0) return <div class="epoch-rail epoch-rail-empty" />;
  const total = epochs.reduce((s, [, n]) => s + n, 0);
  const current = epochs[epochs.length - 1]?.[0];
  return (
    <div class="epoch-rail">
      <ol class="epoch-ticks" aria-label="Dev rebuilds (edits) seen in the retained requests">
        {epochs.map(([e, n]) => {
          const on = (r.view === "changes" && r.epoch === String(e)) || r.since === String(e);
          return (
            <li key={e} style={{ flexGrow: 1 + (n / total) * 10 }}>
              <button
                type="button"
                class={`epoch-tick ${on ? "epoch-tick-on" : ""}`}
                title={`e${e}: ${n} request${n === 1 ? "" : "s"}`}
                aria-label={`Edit e${e}, ${n} requests`}
                onClick={() => go({ view: "changes", epoch: String(e) })}
              />
            </li>
          );
        })}
      </ol>
      {current !== undefined && (
        <span class="epoch-now mono" title="Current dev-rebuild epoch">
          e{current}
        </span>
      )}
    </div>
  );
}

/** Runtime status: live stream, Next and OTel. WP6 adds loop p99 / RSS here. */
export function StatusSlot() {
  const meta = metaState.value;
  const live = liveStatus.value;
  return (
    <output class="status-slot" aria-label="Runtime status">
      {meta?.app && <span class="pill-text mono">{meta.app}</span>}
      {meta?.next && (
        <span class="pill-text" title="Next.js version detected">
          Next {meta.next}
        </span>
      )}
      {meta && (
        <span
          class={`pill-text ${meta.otel === "none" ? "pill-text-warn" : ""}`}
          title={
            meta.otel === "own"
              ? "Hoplens registered its own OpenTelemetry provider"
              : meta.otel === "attached"
                ? "Attached to the existing OpenTelemetry provider"
                : "No OpenTelemetry provider available; framework hops will be missing"
          }
        >
          OTel {meta.otel}
        </span>
      )}
      {meta?.uiPort && (
        <span class="pill-text mono" title="Standalone UI port">
          :{meta.uiPort}
        </span>
      )}
      <span class={`pill-text pill-live pill-live-${live}`} aria-label={`Live status: ${live}`}>
        <span class="dot-indicator" aria-hidden="true" />
        {live === "live" ? "live" : live === "reconnecting" ? "reconnecting…" : "offline"}
      </span>
    </output>
  );
}

/**
 * One notice line for what used to be the full-width StatusBanner, most urgent first:
 * can't reach Hoplens (with Retry), a failed action (dismissible), the live stream reconnecting,
 * no OTel provider, next.config not wrapped. Absent when nothing is wrong.
 */
function TopNotice() {
  const err = loadError.value;
  const status = loadStatus.value;
  const live = liveStatus.value;
  const meta = metaState.value;
  const action = actionError.value;

  if (err && !hasRoutes.value && status === "error") {
    return (
      <div class="top-notice top-notice-err" role="alert">
        <span>
          <b>Can't reach Hoplens.</b> {err} Is <code>next dev</code> running, and is <code>@hoplens/next/node</code>{" "}
          imported from <code>instrumentation.ts</code>?
        </span>
        <button type="button" class="link-btn" onClick={() => void bootstrap()}>
          Retry
        </button>
      </div>
    );
  }
  if (action) {
    return (
      <div class="top-notice top-notice-err" role="alert">
        <span>{action}</span>
        <button type="button" class="link-btn" onClick={() => (actionError.value = null)}>
          Dismiss
        </button>
      </div>
    );
  }
  if (live === "reconnecting") {
    return (
      <output class="top-notice top-notice-warn">
        <span>
          <b>Live stream disconnected.</b> Reconnecting; requests that arrive meanwhile show up when it resumes.
        </span>
      </output>
    );
  }
  if (meta && meta.otel === "none") {
    return (
      <output class="top-notice top-notice-warn">
        <span>
          <b>OpenTelemetry provider missing.</b> Framework hops (router, handler, fetch) won't show. Install{" "}
          <code>@vercel/otel</code>, or remove the manual OTel setup from <code>instrumentation.ts</code> so Hoplens
          registers its own.
        </span>
      </output>
    );
  }
  if (meta && meta.configured === false) {
    return (
      <output class="top-notice top-notice-warn">
        <span>
          <b>next.config isn't wrapped with withHoplens.</b> Route scanning works; function hops and schema pre-fill are
          off. Run <code>npx hoplens init</code>.
        </span>
      </output>
    );
  }
  return null;
}

/** Two-step clear: first click arms for 3s, second click deletes every retained trace. */
function ClearButton({ count }: { count: number }) {
  const [armed, setArmed] = useState(false);
  const busy = clearing.value;

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      class={`action ${armed ? "action-danger" : ""}`}
      disabled={busy || count === 0}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        void clearTraces();
      }}
      title={count === 0 ? "No traces to clear" : "Delete every retained trace (all open Hoplens tabs clear too)"}
    >
      {busy ? "Clearing…" : armed ? `Clear ${count}?` : "Clear"}
    </button>
  );
}
