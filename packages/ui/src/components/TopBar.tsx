import { useEffect, useState } from "preact/hooks";
import {
  type MainView,
  bootstrap,
  clearTraces,
  clearing,
  findingGroups,
  followLive,
  liveStatus,
  mainView,
  metaState,
  setMainView,
  toggleFollow,
  tracesState,
} from "../state/store";

const VIEWS: ReadonlyArray<{ id: MainView; label: string; title: string }> = [
  { id: "overview", label: "Overview", title: "Cross-request overview: latency, findings, routes" },
  { id: "requests", label: "Requests", title: "Dense request log with a query bar (press /)" },
  { id: "queries", label: "Queries", title: "Every db, cache and fetch call across requests, and the hosts called" },
  { id: "workbench", label: "Trace", title: "The selected request: journey, details and the request builder" },
];

export function TopBar() {
  const meta = metaState.value;
  const live = liveStatus.value;
  const follow = followLive.value;
  const view = mainView.value;
  const traceCount = tracesState.value.length;
  // Only the group count: reading kpis here would recompute every stat even with the Overview hidden.
  const findings = findingGroups.value.length;

  return (
    <header class="top">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          ◆
        </span>
        <span class="brand-name">Hoplens</span>
        {meta?.app && <span class="brand-sub mono">{meta.app}</span>}
      </div>

      <output class="pills" aria-label="Runtime status">
        {meta?.next && (
          <span class="pill" title="Next.js version detected">
            Next {meta.next}
          </span>
        )}
        {meta && (
          <span
            class={`pill ${meta.otel === "none" ? "pill-warn" : ""}`}
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
          <span class="pill mono" title="Standalone UI port">
            :{meta.uiPort}
          </span>
        )}
        <span class={`pill pill-live pill-live-${live}`} aria-label={`Live status: ${live}`}>
          <span class="dot-indicator" aria-hidden="true" />
          <span class="pill-live-text">
            {live === "live" ? "live" : live === "reconnecting" ? "reconnecting…" : "offline"}
          </span>
        </span>
      </output>

      <div class="actions">
        <nav class="view-nav" aria-label="Views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              class="action view-nav-btn"
              aria-current={view === v.id ? "page" : undefined}
              aria-pressed={view === v.id}
              onClick={() => setMainView(v.id)}
              title={v.title}
            >
              {v.label}
              {v.id === "overview" && findings > 0 && <span class="tab-count action-count">{findings}</span>}
            </button>
          ))}
        </nav>
        <button
          type="button"
          class="action"
          aria-pressed={follow}
          onClick={toggleFollow}
          title="Auto-select each new trace as it arrives"
        >
          <span class={`dot ${follow ? "on" : ""}`} aria-hidden="true" />
          Follow
        </button>
        <button type="button" class="action" onClick={() => void bootstrap()} title="Re-scan routes and reload traces">
          Refresh
        </button>
        <ClearButton count={traceCount} />
      </div>
    </header>
  );
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
