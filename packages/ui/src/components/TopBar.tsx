import { bootstrap, followLive, liveStatus, metaState, toggleFollow } from "../state/store";

export function TopBar() {
  const meta = metaState.value;
  const live = liveStatus.value;
  const follow = followLive.value;

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
      </div>
    </header>
  );
}
