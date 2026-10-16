import { useMemo } from "preact/hooks";
import type { CapturedError, LogRecord, SpanRecord, TraceRecord } from "../api/types";
import { whereToLook } from "../state/flame";
import { selectHop, selectedHopId } from "../state/journey";
import { openSourceAt } from "../state/source";
import { BUCKET_LABELS, fmtMs } from "../state/stats";
import { selectedTrace } from "../state/store";
import { bucketOf } from "../state/traceview";
import { JsonView } from "./JsonView";

export function Inspector() {
  const trace = selectedTrace.value;
  const hopId = selectedHopId.value;

  if (!trace) {
    return (
      <aside class="insp" aria-label="Hop inspector">
        <div class="empty">
          <b>Hop inspector</b>
          Pick a request, then click a row in the waterfall to see its location, duration, args and return value here.
        </div>
      </aside>
    );
  }

  if (!hopId) return <WhereToLook trace={trace} />;

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

/* --------------------------------------------------------- where to look */

/** Empty state for a selected request: the spans the end of the request waited on longest (critical path). */
function WhereToLook({ trace }: { trace: TraceRecord }) {
  const picks = useMemo(() => whereToLook(trace.spans, 3), [trace.spans]);
  return (
    <aside class="insp" aria-label="Hop inspector">
      <div class="insp-look">
        <div class="insp-section-title">Where to look</div>
        {picks.length === 0 ? (
          <p class="dim insp-look-note">
            {trace.done ? "Nothing on the critical path stands out." : "Waiting for the request to finish…"}
          </p>
        ) : (
          <>
            <p class="dim insp-look-note">
              The end of this request waited longest on these spans: their own time on the critical path (the chain of
              spans that decided when it finished). Speed one up and the request ends sooner.
            </p>
            <ol class="insp-look-list">
              {picks.map((p) => {
                const b = bucketOf(p.span);
                return (
                  <li key={p.span.id}>
                    <button type="button" class="insp-look-item" onClick={() => selectHop(p.span.id)}>
                      <span class={`legend-swatch b-${b}`} aria-hidden="true" title={BUCKET_LABELS[b]} />
                      <span class="insp-look-name mono" title={p.span.name}>
                        {p.span.name}
                      </span>
                      <span class="insp-look-ms mono" title="Time on the critical path spent in this span itself">
                        {fmtMs(p.self)}
                      </span>
                      <span class="insp-look-pct mono dim">{Math.round(p.share * 100)}%</span>
                      {p.span.location && (
                        <span class="insp-look-loc mono dim">
                          {p.span.location.file}:{p.span.location.line}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        <p class="dim insp-look-note">Click any span in the Flame or Tree to inspect it.</p>
      </div>
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
  return (
    <section class="insp-section">
      <div class="insp-section-title">{title}</div>
      <JsonView value={value} />
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
