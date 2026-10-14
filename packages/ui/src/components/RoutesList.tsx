import type { RouteInfo } from "../api/types";
import {
  filteredRoutes,
  groupedRoutes,
  hasRoutes,
  loadError,
  loadStatus,
  routeSearch,
  routesState,
  selectRoute,
  selectedRouteKey,
} from "../state/store";

export function RoutesList() {
  const status = loadStatus.value;
  const err = loadError.value;
  const routes = routesState.value;
  const groups = groupedRoutes.value;
  const selected = selectedRouteKey.value;
  const q = routeSearch.value;

  return (
    <section class="section section-routes" aria-labelledby="section-routes-title">
      <div class="section-head">
        <h2 id="section-routes-title" class="section-title">
          Routes {routes && <span class="count">{filteredRoutes.value.length}</span>}
        </h2>
      </div>

      <search class="search">
        <label class="sr-only" for="route-search">
          Filter routes
        </label>
        <input
          id="route-search"
          type="search"
          placeholder="Filter by path or file…"
          value={q}
          onInput={(e) => {
            routeSearch.value = (e.target as HTMLInputElement).value;
          }}
          autocomplete="off"
          spellcheck={false}
        />
        {q && (
          <button type="button" class="search-clear" onClick={() => (routeSearch.value = "")} aria-label="Clear filter">
            ×
          </button>
        )}
      </search>

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
          No route handlers found. Scanner looks for <code>{"app/**/route.ts"}</code> and <code>{"pages/api/**"}</code>.
        </div>
      )}
      {status === "ready" && hasRoutes.value && groups.length === 0 && (
        <div class="muted">
          No routes match <b>{q}</b>.
        </div>
      )}

      {groups.map(({ group, items }) => (
        <div key={group} class="route-group">
          <div class="route-group-label mono">/{group}</div>
          {items.map((r) => (
            <RouteRow key={r.id} route={r} selected={selected} />
          ))}
        </div>
      ))}
    </section>
  );
}

function RouteRow({ route, selected }: { route: RouteInfo; selected: string | null }) {
  return (
    <div class="route-row">
      <div class="route-path mono" title={route.file}>
        <RenderPath path={route.path} />
      </div>
      <div class="route-methods">
        {route.methods.map((m) => {
          const key = `${route.id}::${m.method}`;
          const isSelected = selected === key;
          const hasSchema = m.schemas.length > 0;
          return (
            <button
              key={m.method}
              type="button"
              class={`method-btn m-${m.method} ${isSelected ? "selected" : ""}`}
              onClick={() => selectRoute(route, m.method)}
              aria-pressed={isSelected}
              title={hasSchema ? `${m.method} · schema detected (${m.schemas.length})` : m.method}
            >
              {m.method}
              {hasSchema && <span class="zod-dot" aria-label="Zod schema detected" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Dim non-param segments, highlight :params. */
function RenderPath({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((p, i) => (
        <span key={`${i}-${p}`}>
          {i > 0 && <span class="dim">/</span>}
          {p.startsWith(":") ? <span class="param">{p}</span> : p}
        </span>
      ))}
    </>
  );
}
