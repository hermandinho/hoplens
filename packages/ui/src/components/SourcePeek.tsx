import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import type { SourceResponse } from "../api/types";
import { closeSource, openSource, openSourceAt, sourceData, sourceError, sourceLoading } from "../state/source";

export function SourcePeek() {
  const req = openSource.value;
  const data = sourceData.value;
  const err = sourceError.value;
  const loading = sourceLoading.value;
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Open/close the native <dialog>. Esc + backdrop click close automatically with .close().
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (req && !el.open) el.showModal();
    if (!req && el.open) el.close();
  }, [req]);

  // Close on Escape (dialog does this natively, we just need to notify our signal).
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClose = () => closeSource();
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  if (!req) return <dialog ref={dialogRef} class="source-dialog" aria-label="Source viewer" />;

  return (
    <dialog
      ref={dialogRef}
      class="source-dialog"
      aria-label={`Source: ${req.file}:${req.line}`}
      onClick={(e) => {
        if (e.target === dialogRef.current) closeSource();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") closeSource();
      }}
    >
      <header class="source-head">
        <div>
          <b class="mono">{req.file}</b>
          <span class="dim mono">:{req.line}</span>
        </div>
        <button type="button" class="source-close" onClick={closeSource} aria-label="Close source viewer">
          ×
        </button>
      </header>
      <div class="source-body">
        {loading && <div class="muted">loading…</div>}
        {err && (
          <div class="error" role="alert">
            <b>Can't load source:</b> {err}
          </div>
        )}
        {data && <SourceLines data={data} highlight={req.line} />}
      </div>
    </dialog>
  );
}

function SourceLines({ data, highlight }: { data: SourceResponse; highlight: number }) {
  return (
    <ol class="src-lines" start={data.start}>
      {data.lines.map((line, i) => {
        const n = data.start + i;
        return (
          <li key={n} class={`src-line ${n === highlight ? "src-highlight" : ""}`}>
            <span class="src-num mono">{n}</span>
            <pre class="src-code mono">{line || " "}</pre>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------ inline peek */

/**
 * Source snippets already fetched for inline peeks, by "rev|file:line:context:seek". Bounded.
 * `rev` (the trace's dev-rebuild epoch) is part of the key: after an edit the next request's peek
 * re-reads the file instead of showing the pre-edit lines. Failures are never cached.
 */
const inlineCache = new Map<string, InlineSnippet>();
const INLINE_CACHE_MAX = 100;
/** Lines read below `line` when looking for the call site (`seek`). */
const SEEK_SPAN = 30;

interface InlineSnippet {
  data: SourceResponse;
  /** The line marked as the culprit (the call site when `seek` found it, else `line`). */
  hit: number;
}

function cacheKey(file: string, line: number, context: number, seek: string | undefined, rev: string): string {
  return `${rev}|${file}:${line}:${context}:${seek ?? ""}`;
}

/** The first line at or after `line` that calls `seek(` (a word boundary before it). */
function findCall(data: SourceResponse, line: number, seek: string): number | undefined {
  const re = new RegExp(`(^|[^\\w$])${seek.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&")}\\s*\\(`);
  for (let i = 0; i < data.lines.length; i++) {
    const n = data.start + i;
    if (n >= line && re.test(data.lines[i] ?? "")) return n;
  }
  return undefined;
}

async function loadSnippet(
  file: string,
  line: number,
  context: number,
  seek: string | undefined,
): Promise<InlineSnippet> {
  if (!seek) return { data: await api.source(file, line, context), hit: line };
  // One read covering the declaration and the body below it; then cut +-context around the call.
  const half = Math.ceil(SEEK_SPAN / 2);
  const wide = await api.source(file, line + half, half);
  const hit = findCall(wide, line, seek) ?? line;
  const from = Math.max(wide.start, hit - context);
  const to = Math.min(wide.start + wide.lines.length - 1, hit + context);
  return {
    data: { ...wide, start: from, lines: wide.lines.slice(from - wide.start, to - wide.start + 1) },
    hit,
  };
}

/**
 * Inline source peek: +-`context` lines around `line`, the culprit line marked and annotated with
 * `note` ("x10, 22ms each"). With `seek` (a function name), the marked line is the first call to
 * it at or below `line`: an N+1 finding locates the enclosing function's declaration, but the line
 * to fix is the call in its loop. The snippet itself is static text; the Open button shows the full
 * source viewer. When the source can't be resolved it shows just `file:line`, so the location is
 * never lost. `onResolve` reports the marked line (for an "open" action elsewhere).
 */
export function InlineSource({
  file,
  line,
  note,
  context = 2,
  seek,
  rev = "",
  onResolve,
}: {
  file: string;
  line: number;
  note?: string;
  context?: number;
  seek?: string;
  /** Invalidates the cached snippet (pass the trace's epoch). */
  rev?: string | number;
  onResolve?: (line: number) => void;
}) {
  const key = cacheKey(file, line, context, seek, String(rev));
  const [snip, setSnip] = useState<InlineSnippet | null | undefined>(() => inlineCache.get(key));
  const resolveRef = useRef(onResolve);
  resolveRef.current = onResolve;

  useEffect(() => {
    const hit = inlineCache.get(key);
    if (hit) {
      setSnip(hit);
      resolveRef.current?.(hit.hit);
      return;
    }
    setSnip(undefined);
    let live = true;
    loadSnippet(file, line, context, seek)
      .then((r) => {
        remember(key, r);
        if (!live) return;
        setSnip(r);
        resolveRef.current?.(r.hit);
      })
      .catch(() => {
        if (live) setSnip(null);
      });
    return () => {
      live = false;
    };
  }, [key, file, line, context, seek]);

  const at = snip?.hit ?? line;
  const open = () => openSourceAt(file, at);
  if (!snip || snip.data.lines.length === 0) {
    return (
      <button type="button" class="src-inline-fallback src-link mono" onClick={open} title="Open in source viewer">
        {file}:{at}
        {note && <span class="src-inline-note"> {note}</span>}
      </button>
    );
  }
  const { data } = snip;
  return (
    <figure class="src-inline">
      <figcaption class="src-inline-cap">
        <span class="mono dim">
          {file}:{at}
        </span>
        <button type="button" class="link-btn src-inline-open" onClick={open}>
          Open
        </button>
      </figcaption>
      <ol class="src-inline-lines mono" start={data.start}>
        {data.lines.map((text, i) => {
          const n = data.start + i;
          const hit = n === at;
          return (
            <li key={n} class={hit ? "src-inline-hit" : ""} aria-current={hit ? "true" : undefined}>
              <span class="src-inline-num" aria-hidden="true">
                {n}
              </span>
              <code class="src-inline-code">{text || " "}</code>
              {hit && note && <span class="src-inline-note">{`<- ${note}`}</span>}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

function remember(key: string, v: InlineSnippet): void {
  if (inlineCache.size >= INLINE_CACHE_MAX) inlineCache.clear();
  inlineCache.set(key, v);
}
