import { useEffect } from "preact/hooks";
import {
  bootstrap,
  hasRoutes,
  hasTraces,
  liveStatus,
  loadError,
  loadStatus,
  metaState,
  routesState,
  startLive,
  stopLive,
  tracesState,
  tracesWithErrors,
} from "./state/store";

export function App() {
  useEffect(() => {
    void bootstrap();
    startLive();
    return () => stopLive();
  }, []);

  const meta = metaState.value;
  const routes = routesState.value;
  const traces = tracesState.value;
  const status = loadStatus.value;
  const err = loadError.value;
  const live = liveStatus.value;

  return (
    <div class="app">
      <div class="top">
        <div class="brand">
          <span class="brand-mark">◆</span>
          <span>Hoplens</span>
          {meta?.app && <span class="brand-sub mono">{meta.app}</span>}
        </div>
        <div class="pills">
          {meta?.next && <span class="pill">Next {meta.next}</span>}
          {meta && <span class={`pill ${meta.otel === "none" ? "pill-warn" : ""}`}>OTel {meta.otel}</span>}
          {meta?.uiPort && <span class="pill mono">:{meta.uiPort}</span>}
          <span class={`pill pill-live pill-live-${live}`}>
            <i />
            {live === "live" ? "live" : live === "reconnecting" ? "reconnecting…" : "offline"}
          </span>
        </div>
      </div>

      <aside class="side">
        <div class="section">
          <div class="section-title">Routes {routes && <span class="count">{routes.routes.length}</span>}</div>
          {status === "loading" && <div class="muted">loading…</div>}
          {err && (
            <div class="error">
              <b>Can't reach Hoplens.</b>
              <br />
              {err}
            </div>
          )}
          {status === "ready" && !hasRoutes.value && (
            <div class="muted">
              No route handlers found. Scanner looks for <code>{"app/**/route.ts"}</code> and{" "}
              <code>{"pages/api/**"}</code>.
            </div>
          )}
          {status === "ready" && hasRoutes.value && (
            <ul class="route-list">
              {routes!.routes.map((r) => (
                <li key={r.id} class="route-item">
                  <span class="route-path mono">{r.path}</span>
                  <span class="route-methods">
                    {r.methods.map((m) => (
                      <span key={m.method} class={`method-tag m-${m.method}`}>
                        {m.method}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div class="section">
          <div class="section-title">
            Traffic {traces.length > 0 && <span class="count">{traces.length}</span>}
            {tracesWithErrors.value > 0 && <span class="count count-err">{tracesWithErrors.value} err</span>}
          </div>
          {!hasTraces.value && <div class="muted">No requests yet. Send one to light up the journey.</div>}
          {hasTraces.value && (
            <ul class="trace-list">
              {traces.slice(0, 20).map((t) => (
                <li key={t.id} class="trace-item">
                  <span class={`status-code c${Math.floor((t.status ?? 0) / 100)}`}>{t.status ?? "…"}</span>
                  <span class={`method-tag m-${t.method}`}>{t.method}</span>
                  <span class="trace-path mono">{t.path}</span>
                  {t.duration !== undefined && <span class="trace-dur dim mono">{Math.round(t.duration)}ms</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <main class="main">
        <div class="empty">
          <b>Request builder, journey canvas and details</b>
          Builder in D5, journey in D6, details in D7.
        </div>
      </main>

      <aside class="insp">
        <div class="empty">
          <b>Hop inspector</b>
          Lands in D8.
        </div>
      </aside>
    </div>
  );
}
