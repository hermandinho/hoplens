import type { TraceSummary } from "../api/types";
import {
  filteredTraces,
  hasTraces,
  loadTrace,
  selectedTraceId,
  setTrafficFilter,
  tracesState,
  tracesWithErrors,
  trafficFilter,
} from "../state/store";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "route", label: "Routes" },
  { id: "page", label: "Pages" },
  { id: "error", label: "Errors" },
] as const;

export function TrafficList() {
  const traces = tracesState.value;
  const filter = trafficFilter.value;
  const visible = filteredTraces.value;
  const selected = selectedTraceId.value;

  return (
    <section class="section" aria-labelledby="section-traffic-title">
      <div class="section-head">
        <h2 id="section-traffic-title" class="section-title">
          Traffic {traces.length > 0 && <span class="count">{traces.length}</span>}
          {tracesWithErrors.value > 0 && (
            <span class="count count-err" aria-label={`${tracesWithErrors.value} with errors`}>
              {tracesWithErrors.value} err
            </span>
          )}
        </h2>
      </div>

      <fieldset class="chips">
        <legend class="sr-only">Filter traffic</legend>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            class={`chip ${filter === f.id ? "chip-active" : ""}`}
            aria-pressed={filter === f.id}
            onClick={() => setTrafficFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </fieldset>

      {!hasTraces.value && <div class="muted">No requests yet. Send one to light up the journey.</div>}
      {hasTraces.value && visible.length === 0 && <div class="muted">No traces match the current filter.</div>}

      {visible.length > 0 && (
        <ul class="trace-list">
          {visible.slice(0, 100).map((t) => (
            <TraceRow key={t.id} trace={t} selected={selected === t.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TraceRow({ trace: t, selected }: { trace: TraceSummary; selected: boolean }) {
  const statusClass = t.error ? "c5" : `c${Math.floor((t.status ?? 0) / 100)}`;
  return (
    <li>
      <button
        type="button"
        class={`trace-row ${selected ? "selected" : ""}`}
        onClick={() => void loadTrace(t.id)}
        aria-pressed={selected}
        title={t.error ? `Error: ${t.error}` : `${t.method} ${t.path}`}
      >
        <span class={`status-code ${statusClass}`}>{t.status ?? (t.done ? "—" : "…")}</span>
        <span class={`method-tag m-${t.method}`}>{t.method}</span>
        <span class="trace-path mono">{t.path}</span>
        {t.duration !== undefined && (
          <span class="trace-dur dim mono" aria-label={`${Math.round(t.duration)} milliseconds`}>
            {Math.round(t.duration)}ms
          </span>
        )}
      </button>
    </li>
  );
}
