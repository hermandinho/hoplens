import type { CapturedError, LogRecord, SpanRecord } from "../api/types";
import { selectedHopId } from "../state/journey";
import { openSourceAt } from "../state/source";
import { selectedTrace } from "../state/store";

export function Inspector() {
  const trace = selectedTrace.value;
  const hopId = selectedHopId.value;

  if (!trace || !hopId) {
    return (
      <aside class="insp" aria-label="Hop inspector">
        <div class="empty">
          <b>Hop inspector</b>
          Click a hop in the journey or a row in the waterfall to see its location, duration, args and return value
          here.
        </div>
      </aside>
    );
  }

  const span = trace.spans.find((s) => s.id === hopId);
  if (!span) {
    return (
      <aside class="insp" aria-label="Hop inspector">
        <div class="empty">
          <b>Hop not in current trace</b>
          Pick a hop from the current trace to see its details.
        </div>
      </aside>
    );
  }

  const dur = Math.round(span.end - span.start);
  const offset = Math.round(span.start);
  const logs = trace.logs.filter((l) => l.spanId === span.id);

  return (
    <aside class="insp" aria-label="Hop inspector">
      <header class="insp-head">
        <KindTag kind={span.kind} />
        <h3 class="insp-name mono" title={span.name}>
          {span.name}
        </h3>
      </header>

      <dl class="insp-metrics">
        <div>
          <dt class="dim mono">duration</dt>
          <dd class="mono">{dur}ms</dd>
        </div>
        <div>
          <dt class="dim mono">offset</dt>
          <dd class="mono">+{offset}ms</dd>
        </div>
        {span.type && (
          <div>
            <dt class="dim mono">type</dt>
            <dd class="mono">{span.type}</dd>
          </div>
        )}
      </dl>

      {span.location && (
        <section class="insp-section">
          <div class="insp-section-title">Location</div>
          <button
            type="button"
            class="src-link mono"
            onClick={() => openSourceAt(span.location!.file, span.location!.line)}
            title="Open in source viewer"
          >
            <span class="src-link-arrow" aria-hidden="true">
              ↗
            </span>
            {span.location.file}:{span.location.line}
          </button>
        </section>
      )}

      {span.error && <ErrorBlock err={span.error} />}
      {span.args !== undefined && <JsonSection title="Arguments" value={span.args} />}
      {span.result !== undefined && <JsonSection title="Return value" value={span.result} />}
      <AttrsSection attrs={span.attrs} />
      {logs.length > 0 && <LogsSection logs={logs} />}
    </aside>
  );
}

/* --------------------------------------------------------------- blocks */

function ErrorBlock({ err }: { err: CapturedError }) {
  const stackLines = err.stack.split("\n");
  return (
    <section class="insp-section insp-error">
      <div class="insp-section-title insp-error-title">Error</div>
      <div class="insp-error-msg">
        <b class="mono">{err.type}:</b> {err.message}
      </div>
      {stackLines.length > 1 && (
        <ol class="insp-stack">
          {stackLines.map((raw, i) => {
            const line = raw.trim();
            const m = line.match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?(?:\s*\[(framework)\])?$/);
            if (!m) {
              return (
                <li key={`${i}-${line}`} class="insp-stack-line dim mono">
                  {line}
                </li>
              );
            }
            const [, fn, file, lineStr, colStr, flag] = m;
            const foreign = flag === "framework";
            return (
              <li key={`${i}-${line}`} class={`insp-stack-line ${foreign ? "dim" : ""}`}>
                <span class="mono">at {fn ?? "(anonymous)"} </span>
                {foreign ? (
                  <span class="mono dim">
                    ({file}:{lineStr}:{colStr}) [framework]
                  </span>
                ) : (
                  <button
                    type="button"
                    class="stack-link mono"
                    onClick={() => openSourceAt(file!, Number(lineStr))}
                    title="Open in source viewer"
                  >
                    ({file}:{lineStr}:{colStr})
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <section class="insp-section">
      <div class="insp-section-title">{title}</div>
      <pre class="insp-json mono">{text}</pre>
    </section>
  );
}

function AttrsSection({ attrs }: { attrs: Record<string, string | number | boolean> }) {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return null;
  return (
    <section class="insp-section">
      <div class="insp-section-title">Attributes</div>
      <dl class="insp-attrs">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt class="mono dim">{k}</dt>
            <dd class="mono">{String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function LogsSection({ logs }: { logs: LogRecord[] }) {
  return (
    <section class="insp-section">
      <div class="insp-section-title">Logs ({logs.length})</div>
      <ol class="insp-logs">
        {logs.map((log, i) => (
          <li key={`${log.t}-${i}`} class={`insp-log level-${log.level}`}>
            <span class="dim mono">+{Math.round(log.t)}ms</span>
            <span class={`console-level level-${log.level}`}>{log.level}</span>
            <pre class="mono">{log.text}</pre>
            {log.location && (
              <button
                type="button"
                class="stack-link mono"
                onClick={() => openSourceAt(log.location!.file, log.location!.line)}
              >
                {log.location.file}:{log.location.line}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function KindTag({ kind }: { kind: SpanRecord["kind"] }) {
  return <span class={`kind-tag kind-${kind}`}>{kind}</span>;
}
