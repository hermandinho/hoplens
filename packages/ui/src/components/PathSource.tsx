import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PathFn, PathPayload } from "../api/types";
import { pathMode } from "../state/canvas";
import { register } from "../state/keymap";
import { whyText } from "../state/path";
import {
  type GutterRow,
  gutterRows,
  loadFnSource,
  pathPanel,
  sourceBlocks,
  sourceMoved,
  sourceOf,
} from "../state/pathPanel";

/*
 * The function's Source view (plan P4, mockup D): its lines from the source endpoint with a gutter
 * of the server's counts (x1, 0 dimmed, ? hatched with the reason), decision lines annotated with
 * the arm taken, not-run regions dimmed and folded (u opens them all), exits marked. A file edited
 * since the trace shows '?' everywhere: its counts belong to other lines.
 */

const live = () => pathMode.value && !!pathPanel.value;

export function PathSource({
  payload,
  fn,
  line,
  autoFocus,
}: { payload: PathPayload; fn: PathFn; line?: number; autoFocus?: boolean }) {
  const src = sourceOf(fn);
  useEffect(() => {
    void loadFnSource(fn);
  }, [fn]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () => (src && src !== "loading" && "lines" in src ? gutterRows(payload, fn, src) : null),
    [payload, fn, src],
  );
  const blocks = useMemo(() => (rows ? sourceBlocks(rows, open) : null), [rows, open]);
  const toggleAll = useRef<() => void>(() => {});
  toggleAll.current = () => {
    if (!blocks) return;
    const shut = blocks.filter((b) => b.t === "fold" && !b.open);
    setOpen(shut.length ? new Set(blocks.flatMap((b) => (b.t === "fold" ? [b.key] : []))) : new Set());
  };
  useEffect(
    () =>
      register("canvas", "u", "Unfold everything in the function view (again: fold back)", () => toggleAll.current(), {
        when: live,
        hint: "unfold",
      }),
    [],
  );
  const box = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the lines are in
  useEffect(() => {
    if (!blocks) return;
    const el = line ? box.current?.querySelector<HTMLElement>(`[data-line="${line}"]`) : null;
    el?.scrollIntoView?.({ block: "nearest" });
    if (autoFocus) box.current?.focus({ preventScroll: !!el });
  }, [!!blocks, fn.key]);
  if (!src || src === "loading") return <p class="path-note dim">loading the source...</p>;
  if ("error" in src) return <p class="path-note">The source could not be read: {src.error}</p>;
  const moved = sourceMoved(fn, src);
  return (
    <>
      {moved && (
        <p class="path-note path-fn-unknown">
          UNKNOWN: {whyText("source-moved")}. The counts are not shown over the edited lines.
        </p>
      )}
      <section
        class="path-src mono"
        ref={box}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be focusable to scroll by keyboard
        tabIndex={0}
        data-own-drag=""
        aria-label={`Source of ${fn.name || "the function"} with execution counts per line`}
      >
        {blocks!.map((b) =>
          b.t === "row" ? (
            <Row key={b.row.line} r={b.row} hit={b.row.line === line} />
          ) : (
            <div key={b.key} class="ps-fold-group">
              <button
                type="button"
                class="ps-fold"
                aria-expanded={b.open}
                onClick={() => {
                  const next = new Set(open);
                  if (b.open) next.delete(b.key);
                  else next.add(b.key);
                  setOpen(next);
                }}
              >
                <span class="ps-g">0</span>
                {b.open ? "v" : ">"} {b.lines} line{b.lines === 1 ? "" : "s"} not run (L{b.from}-{b.to})
              </button>
              {b.open && b.rows.map((r) => <Row key={r.line} r={r} hit={r.line === line} />)}
            </div>
          ),
        )}
      </section>
    </>
  );
}

function Row({ r, hit }: { r: GutterRow; hit: boolean }) {
  const why = r.tone === "unknown" ? `UNKNOWN: ${whyText(r.why)}` : undefined;
  return (
    <div
      class={`ps-row ps-${r.tone}${r.exit ? ` ps-exit ps-exit-${r.exit}` : ""}${hit ? " ps-hit" : ""}`}
      data-line={r.line}
    >
      <span class="ps-g" title={why}>
        {r.count}
      </span>
      <span class="ps-n">{r.line}</span>
      <span class="ps-code">{r.text || " "}</span>
      {r.notes.length > 0 && <span class="ps-br" aria-hidden="true" />}
      {r.notes.map((n) => (
        <span key={n.text} class={`ps-note ps-note-${n.tone}`} title={n.title}>
          {n.text}
        </span>
      ))}
      {why && <span class="sr-only">{why}</span>}
    </div>
  );
}
