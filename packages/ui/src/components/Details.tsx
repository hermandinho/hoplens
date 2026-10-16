import type { BodyCapture, LogRecord, SpanRecord, TraceRecord } from "../api/types";
import { detailsCounts, detailsTab, rawRequest, rawRequestError, setDetailsTab } from "../state/details";
import { selectHop, selectedHopId } from "../state/journey";
import { selectedTrace } from "../state/store";
import { JsonView } from "./JsonView";
import { SpanSnippet } from "./SpanSnippet";

const TABS = [
  { id: "response", label: "Response" },
  { id: "waterfall", label: "Waterfall" },
  { id: "console", label: "Console" },
  { id: "request", label: "Request" },
] as const;

export function Details() {
  const trace = selectedTrace.value;
  const tab = detailsTab.value;
  const counts = detailsCounts.value;

  if (!trace) return null;

  return (
    <section class="details" aria-label="Trace details">
      <div class="details-tabs" role="tablist" aria-label="Trace detail views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`details-tab-${t.id}`}
            aria-controls="details-panel"
            class={`details-tab ${tab === t.id ? "active" : ""}`}
            aria-selected={tab === t.id}
            onClick={() => setDetailsTab(t.id)}
          >
            {t.label}
            {counts[t.id] > 0 && t.id !== "response" && t.id !== "request" && (
              <span class="tab-count">{counts[t.id]}</span>
            )}
          </button>
        ))}
      </div>
      <div id="details-panel" class="details-body" role="tabpanel" aria-labelledby={`details-tab-${tab}`}>
        {tab === "response" && <ResponsePane trace={trace} />}
        {tab === "waterfall" && <WaterfallPane trace={trace} />}
        {tab === "console" && <ConsolePane trace={trace} />}
        {tab === "request" && <RequestPane />}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- panes */

function ResponsePane({ trace }: { trace: TraceRecord }) {
  const status = trace.status ?? 0;
  const statusClass = trace.error ? "c5" : `c${Math.floor(status / 100)}`;
  return (
    <div class="pane">
      <div class="response-head">
        <span class={`status-code ${statusClass}`}>{trace.status ?? (trace.done ? "—" : "…")}</span>
        {trace.duration !== undefined && <span class="dim mono">{Math.round(trace.duration)}ms</span>}
        {trace.error && (
          <span class="pane-issue">
            {trace.error.type}: {trace.error.message}
          </span>
        )}
      </div>
      <HeadersTable headers={trace.response.headers} />
      <BodyBlock body={trace.response.body} empty="Empty response body." />
    </div>
  );
}

function WaterfallPane({ trace }: { trace: TraceRecord }) {
  if (trace.spans.length === 0) {
    return <div class="muted">No spans captured.</div>;
  }
  const total = Math.max(1, ...trace.spans.map((s) => s.end));
  const selected = selectedHopId.value;
  return (
    <div class="pane">
      <div class="waterfall">
        {trace.spans.map((s) => (
          <WaterfallRow key={s.id} span={s} total={total} selected={selected === s.id} logs={trace.logs} />
        ))}
      </div>
      <div class="waterfall-foot dim mono">
        Total {Math.round(total)}ms · {trace.spans.length} spans
      </div>
    </div>
  );
}

function WaterfallRow({
  span,
  total,
  selected,
  logs,
}: {
  span: SpanRecord;
  total: number;
  selected: boolean;
  logs: LogRecord[];
}) {
  const left = (span.start / total) * 100;
  const width = Math.max(0.5, ((span.end - span.start) / total) * 100);
  const dur = Math.round(span.end - span.start);
  const errored = !!span.error;
  // Logs that happened inside this span's time window OR were tagged with its spanId.
  // When errored, we surface them inline so you don't have to hop to the Console tab.
  const scoped = errored ? logs.filter((l) => l.spanId === span.id || (l.t >= span.start && l.t <= span.end)) : [];
  return (
    <div class="wf-row-wrap">
      <button
        type="button"
        class={`wf-row ${selected ? "selected" : ""} ${errored ? "errored" : ""}`}
        onClick={() => selectHop(span.id)}
        aria-pressed={selected}
      >
        <span class={`wf-kind wf-kind-${span.kind}`} aria-hidden="true" />
        <span class="wf-name mono" title={span.name}>
          {span.name}
        </span>
        <span class="wf-bar-track">
          <span class={`wf-bar wf-bar-${span.kind}`} style={`left: ${left}%; width: ${width}%;`} aria-hidden="true" />
        </span>
        <span class="wf-dur dim mono" aria-label={`${dur} milliseconds`}>
          {dur}ms
        </span>
      </button>
      {selected && <SpanSnippet span={span} />}
      {scoped.length > 0 && (
        <fieldset class="wf-logs">
          <legend class="wf-logs-head">Logs during this failing step ({scoped.length})</legend>
          {scoped.map((log, i) => (
            <div key={`${log.t}-${i}`} class={`wf-log-line level-${log.level}`}>
              <span class="wf-log-time">+{Math.round(log.t)}ms</span>
              <span class={`console-level level-${log.level}`}>{log.level}</span>
              <span class="wf-log-text">{log.text}</span>
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function ConsolePane({ trace }: { trace: TraceRecord }) {
  if (trace.logs.length === 0) return <div class="muted">No console output captured for this request.</div>;
  return (
    <div class="pane">
      <ol class="console">
        {trace.logs.map((log, i) => (
          <li key={`${log.t}-${i}`} class={`console-line level-${log.level}`}>
            <span class="console-t dim mono" title={`${Math.round(log.t)}ms into the request`}>
              +{Math.round(log.t)}ms
            </span>
            <span class={`console-level level-${log.level}`} aria-label={log.level}>
              {log.level}
            </span>
            <pre class="console-text mono">{log.text}</pre>
            {log.location && (
              <span class="console-loc dim mono">
                {log.location.file}:{log.location.line}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RequestPane() {
  const req = rawRequest.value;
  const err = rawRequestError.value;
  if (err) {
    return (
      <div class="pane">
        <div class="error" role="alert">
          <b>Can't load request:</b> {err}
        </div>
      </div>
    );
  }
  if (!req) return <div class="muted">loading…</div>;
  // Try to parse body as JSON so we can pretty-print it; fall back to raw text.
  const parsed = tryParseJson(req.body);
  return (
    <div class="pane">
      <div class="request-head">
        <span class={`method-tag m-${req.method}`}>{req.method}</span>
        <span class="mono">{req.url}</span>
      </div>
      <HeadersTable headers={req.headers} />
      {req.body ? (
        <>
          <div class="section-title">Body</div>
          {parsed !== undefined ? <JsonView value={parsed} /> : <pre class="code-block mono">{req.body}</pre>}
        </>
      ) : (
        <div class="muted">No request body.</div>
      )}
      <div class="dim" style="margin-top: 10px; font-size: 11.5px;">
        Secrets (authorization, cookie, …) stay server-side; this is a replay-ready snapshot of what the handler
        actually saw.
      </div>
    </div>
  );
}

function tryParseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed || !/^[[{"]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/* ----------------------------------------------------------- shared helpers */

function HeadersTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <div class="muted">No headers.</div>;
  return (
    <>
      <div class="section-title">Headers</div>
      <div class="headers-table">
        {entries.map(([k, v]) => (
          <div key={k} class="headers-row">
            <span class="headers-key mono">{k}</span>
            <span class="headers-val mono">{v}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function BodyBlock({ body, empty }: { body?: BodyCapture; empty: string }) {
  if (!body) return <div class="muted">{empty}</div>;
  if (body.binary) {
    return (
      <>
        <div class="section-title">Body</div>
        <div class="muted">
          Binary content ({body.contentType ?? "unknown"}, {body.size.toLocaleString()} bytes).
        </div>
      </>
    );
  }
  // JSON gets the tree view; text content falls back to the raw block but
  // first tries to parse as JSON opportunistically (common for text/plain
  // responses that are actually JSON).
  const asJson = body.json !== undefined ? body.json : tryParseJson(body.text);
  return (
    <>
      <div class="section-title">
        Body
        {body.contentType && <span class="dim mono"> {body.contentType}</span>}
        {body.truncated && <span class="pane-issue"> truncated</span>}
      </div>
      {asJson !== undefined ? <JsonView value={asJson} /> : <pre class="code-block mono">{body.text ?? ""}</pre>}
    </>
  );
}
