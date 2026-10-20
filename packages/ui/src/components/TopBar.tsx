import { useEffect, useState } from "preact/hooks";
import { NEXT_COPY, frameworkId, frameworkLabel, frameworkPill } from "../state/framework";
import { IS_MAC, formatKey } from "../state/keymap";
import { toggleCheatsheet, togglePalette } from "../state/palette";
import { QUERY_INPUT_MAIN } from "../state/requestLog";
import {
  type MainView,
  actionError,
  bootstrap,
  clearTraces,
  clearing,
  findingGroups,
  followLive,
  frameworkCopy,
  hasRoutes,
  infoNote,
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
import { EpochRail } from "./EpochRail";
import { HealthStrip, LiveRate } from "./HealthStrip";
import { QueryBar } from "./RequestLog";

/*
 * The top bar (plan 3.2): brand, the four view tabs, the request filter, the live controls, then a
 * thin status line holding two slots other work packages fill in:
 *   <EpochRail/>  edit ticks, the newest edit, the rebuild toast (components/EpochRail, WP9b)
 *   <StatusSlot/> runtime status (WP6 adds loop p99 and RSS next to the live dot)
 * Problems that used to be a full-width banner (StatusBanner) now render as one notice line here.
 */

const VIEWS: ReadonlyArray<{ id: MainView; label: string; title: string }> = [
  { id: "overview", label: "Overview", title: "What to fix first: findings, routes, errors" },
  { id: "requests", label: "Requests", title: "The live request log; pick one to open it beside the list" },
  { id: "queries", label: "Queries", title: "Every db, cache and fetch call across requests, and the hosts called" },
  { id: "changes", label: "Changes", title: NEXT_COPY.changesTitle },
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
            <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
              <path class="bm-ring" d="M7 0h18a7 7 0 0 1 7 7v18a7 7 0 0 1-7 7H7a7 7 0 0 1-7-7V7a7 7 0 0 1 7-7z" />
              <rect class="bm-tile" x="2" y="2" width="28" height="28" rx="5" />
              <path class="bm-hop" d="M7 6h8a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
              <rect class="bm-focus" x="10" y="14" width="16" height="6" rx="1" />
              <rect class="bm-end" x="18" y="22" width="8" height="4" rx="1" />
            </svg>
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
              title={v.id === "changes" ? frameworkCopy.value.changesTitle : v.title}
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
            onClick={togglePalette}
            aria-label="Command palette"
            title="Command palette: find a route, request, finding, query or action"
            aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
          >
            <kbd>{formatKey("Mod+k")}</kbd>
            <span class="touch-only">Search</span>
          </button>
          <button
            type="button"
            class="action keys-btn"
            onClick={toggleCheatsheet}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
          >
            <kbd>?</kbd>
          </button>
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
 * Runtime status: app, framework (Next, Express, ...), OTel, port, then the WP6 health strip (loop p99, rss, process errors)
 * and the live dot with the request rate.
 */
export function StatusSlot() {
  const meta = metaState.value;
  const live = liveStatus.value;
  const pill = frameworkPill(meta);
  return (
    // Not <output>: an implicit live region would re-announce the health values every 2s, and the
    // process-errors panel inside needs flow content. Outages are announced by TopNotice.
    <div class="status-slot">
      {meta?.app && <span class="pill-text mono">{meta.app}</span>}
      {pill && (
        <span class="pill-text" title={`${frameworkLabel(meta)} version detected`}>
          {pill}
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
      <HealthStrip />
      <span class={`pill-text pill-live pill-live-${live}`} aria-label={`Live status: ${live}`}>
        <span class="dot-indicator" aria-hidden="true" />
        {live === "live" ? "live" : live === "reconnecting" ? "reconnecting…" : "offline"}
        {live === "live" && <LiveRate />}
      </span>
    </div>
  );
}

/**
 * One notice line for what used to be the full-width StatusBanner, most urgent first:
 * can't reach Hoplens (with Retry), a failed action (dismissible), the live stream reconnecting,
 * no OTel provider, next.config not wrapped, then an info note (the app restarted). Absent when
 * nothing is wrong. Next-only advice (next dev, instrumentation.ts, withHoplens) shows only for Next.
 */
function TopNotice() {
  const err = loadError.value;
  const status = loadStatus.value;
  const live = liveStatus.value;
  const meta = metaState.value;
  const action = actionError.value;
  const info = infoNote.value;
  const fw = frameworkId(meta);

  if (err && !hasRoutes.value && status === "error") {
    return (
      <div class="top-notice top-notice-err" role="alert">
        <span>
          <b>Can't reach Hoplens.</b> {err}{" "}
          {fw === "next" ? (
            <>
              Is <code>next dev</code> running, and is <code>@hoplens/next/node</code> imported from{" "}
              <code>instrumentation.ts</code>?
            </>
          ) : fw === "express" ? (
            <>
              Is the app running, started with <code>--import hoplens/express/register</code> (or calling{" "}
              <code>hoplens(app)</code>)?
            </>
          ) : (
            <>Is the app running with its Hoplens adapter loaded?</>
          )}
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
        {fw === "next" ? (
          <span>
            <b>OpenTelemetry provider missing.</b> Framework hops (router, handler, fetch) won't show. Install{" "}
            <code>@vercel/otel</code>, or remove the manual OTel setup from <code>instrumentation.ts</code> so Hoplens
            registers its own.
          </span>
        ) : (
          <span>
            <b>OpenTelemetry provider missing.</b> Hops recorded through OpenTelemetry spans won't show. Remove the
            app's manual OTel setup so Hoplens registers its own.
          </span>
        )}
      </output>
    );
  }
  if (meta && meta.configured === false && fw === "next") {
    return (
      <output class="top-notice top-notice-warn">
        <span>
          <b>next.config isn't wrapped with withHoplens.</b> Route scanning works; function hops and schema pre-fill are
          off. Run <code>npx hoplens init</code>.
        </span>
      </output>
    );
  }
  if (info) {
    return (
      <output class="top-notice top-notice-info">
        <span>{info}</span>
        <button type="button" class="link-btn" onClick={() => (infoNote.value = null)}>
          Dismiss
        </button>
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
