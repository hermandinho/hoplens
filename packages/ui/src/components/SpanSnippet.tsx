import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import type { SourceResponse, SpanRecord } from "../api/types";
import { openSourceAt } from "../state/source";

/**
 * Compact code preview rendered under a span row. Pulls /api/source and shows
 * a few lines around the span's location with the hit line highlighted.
 *
 * Caches results in-module keyed by file+line+ctx so flipping between spans
 * doesn't re-hit the backend. The whole box is dev-only (same as the server).
 */

const CTX = 3; // lines of context on each side; keeps the row compact
const cache = new Map<string, Promise<SourceResponse>>();

function fetchSnippet(file: string, line: number): Promise<SourceResponse> {
  const key = `${file}@${line}@${CTX}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = api.source(file, line, CTX);
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

type State = { loading: true } | { loading: false; data: SourceResponse } | { loading: false; error: string };

export function SpanSnippet({ span }: { span: SpanRecord }) {
  const loc = span.location;
  const [state, setState] = useState<State>({ loading: true });

  useEffect(() => {
    if (!loc) return;
    let cancelled = false;
    setState({ loading: true });
    fetchSnippet(loc.file, loc.line).then(
      (data) => {
        if (!cancelled) setState({ loading: false, data });
      },
      (err) => {
        if (!cancelled) setState({ loading: false, error: (err as Error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loc]);

  if (!loc) {
    const hint = describeMissingLocation(span);
    return <div class={`span-snippet k-${span.kind}`}>{hint && <div class="span-snippet-empty">{hint}</div>}</div>;
  }

  return (
    <div class={`span-snippet k-${span.kind}`}>
      <div class="span-snippet-head">
        <button
          type="button"
          class="span-snippet-loc mono"
          onClick={() => openSourceAt(loc.file, loc.line)}
          title="Open in source viewer"
        >
          <span aria-hidden="true">↗</span> {loc.file}:{loc.line}
        </button>
        <span class="dim">context ±{CTX}</span>
      </div>
      {state.loading && <div class="span-snippet-empty">loading source…</div>}
      {!state.loading && "error" in state && <div class="span-snippet-err">couldn't load source: {state.error}</div>}
      {!state.loading && "data" in state && <SnippetLines data={state.data} highlight={loc.line} />}
    </div>
  );
}

function SnippetLines({ data, highlight }: { data: SourceResponse; highlight: number }) {
  return (
    <div class="span-snippet-body">
      {data.lines.map((line, i) => {
        const n = data.start + i;
        return (
          <div key={n} class={`span-snippet-line ${n === highlight ? "highlight" : ""}`}>
            <span class="span-snippet-num mono">{n}</span>
            <span class="span-snippet-code mono">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function describeMissingLocation(span: SpanRecord): string | null {
  // No location is normal for framework-internal spans; a soft hint beats a
  // blank box or an error.
  switch (span.kind) {
    case "request":
    case "response":
    case "router":
      return null;
    case "fetch":
      return "No file location — this fetch was initiated by framework code.";
    case "db":
      return "No file location — this driver didn't emit a call site.";
    default:
      return "No source location recorded for this step.";
  }
}
