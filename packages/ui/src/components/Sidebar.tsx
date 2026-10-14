import {
  hasRoutes,
  hasTraces,
  loadError,
  loadStatus,
  routesState,
  tracesState,
  tracesWithErrors,
} from "../state/store";

export function Sidebar() {
  const routes = routesState.value;
  const traces = tracesState.value;
  const status = loadStatus.value;
  const err = loadError.value;

  return (
    <aside class="side" aria-label="Routes and traffic">
      <section class="section" aria-labelledby="section-routes">
        <h2 id="section-routes" class="section-title">
          Routes {routes && <span class="count">{routes.routes.length}</span>}
        </h2>
        {status === "loading" && <div class="muted">loading…</div>}
        {err && (
          <div class="error" role="alert">
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
      </section>

      <section class="section" aria-labelledby="section-traffic">
        <h2 id="section-traffic" class="section-title">
          Traffic {traces.length > 0 && <span class="count">{traces.length}</span>}
          {tracesWithErrors.value > 0 && (
            <span class="count count-err" aria-label={`${tracesWithErrors.value} with errors`}>
              {tracesWithErrors.value} err
            </span>
          )}
        </h2>
        {!hasTraces.value && <div class="muted">No requests yet. Send one to light up the journey.</div>}
        {hasTraces.value && (
          <ul class="trace-list">
            {traces.slice(0, 50).map((t) => (
              <li key={t.id} class="trace-item">
                <span class={`status-code c${Math.floor((t.status ?? 0) / 100)}`}>{t.status ?? "…"}</span>
                <span class={`method-tag m-${t.method}`}>{t.method}</span>
                <span class="trace-path mono">{t.path}</span>
                {t.duration !== undefined && (
                  <span class="trace-dur dim mono" aria-label={`${Math.round(t.duration)} milliseconds`}>
                    {Math.round(t.duration)}ms
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
