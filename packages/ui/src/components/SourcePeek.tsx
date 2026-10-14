import { useEffect, useRef } from "preact/hooks";
import type { SourceResponse } from "../api/types";
import { closeSource, openSource, sourceData, sourceError, sourceLoading } from "../state/source";

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
