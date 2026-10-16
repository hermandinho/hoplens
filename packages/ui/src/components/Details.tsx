import type { BodyCapture, TraceRecord } from "../api/types";
import { detailsCounts, detailsTab, rawRequest, rawRequestError, setDetailsTab } from "../state/details";
import { isHandledError, statusClass } from "../state/stats";
import { selectedTrace } from "../state/store";
import { JsonView } from "./JsonView";

const TABS = [
  { id: "response", label: "Response" },
  { id: "request", label: "Request" },
  { id: "console", label: "Console" },
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
        {tab === "console" && <ConsolePane trace={trace} />}
        {tab === "request" && <RequestPane />}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- panes */

function ResponsePane({ trace }: { trace: TraceRecord }) {
  return (
    <div class="pane">
      <div class="response-head">
        <span class={`status-code ${statusClass(trace)}`}>{trace.status ?? (trace.done ? "—" : "…")}</span>
        {trace.duration !== undefined && <span class="dim mono">{Math.round(trace.duration)}ms</span>}
        {trace.error && (
          <span class="pane-issue">
            {isHandledError(trace) && "Handled: "}
            {trace.error.type}: {trace.error.message}
          </span>
        )}
      </div>
      <HeadersTable headers={trace.response.headers} />
      <BodyBlock body={trace.response.body} empty="Empty response body." />
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
