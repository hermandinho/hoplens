import { useLayoutEffect, useRef } from "preact/hooks";
import { type KeyScope, activeScopes, bindings, cheatsheet } from "../state/keymap";
import { cheatsheetOpen } from "../state/palette";

/*
 * The `?` sheet (plan 3.9): every registered key, grouped by scope, generated from state/keymap so
 * it can't drift from what actually works. Scopes not live right now are dimmed; keys of panes
 * that aren't mounted (the canvas, an open request) appear once they are. `?` or Esc closes it.
 */

const SCOPE_LABELS: Record<KeyScope, { title: string; note: string }> = {
  global: { title: "Anywhere", note: "" },
  list: { title: "List", note: "Overview routes, Requests, Queries" },
  subject: { title: "Open subject", note: "a request or route is open" },
  trace: { title: "Open request", note: "a request is open" },
  canvas: { title: "Span canvas", note: "focus in the canvas" },
  palette: { title: "Palette", note: "while it is open" },
};

/** Sheet order: what you use first, first. */
const SHEET_ORDER: readonly KeyScope[] = ["global", "list", "subject", "trace", "canvas", "palette"];

export function Cheatsheet() {
  const open = cheatsheetOpen.value;
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
    } else if (!open && d.open) d.close();
  }, [open]);

  // Reading `bindings` subscribes the sheet to registrations while it is open.
  bindings.value;
  const scopes = activeScopes.value;
  const groups = open ? cheatsheet() : [];
  const ordered = SHEET_ORDER.map((s) => groups.find((g) => g.scope === s)).filter(
    (g): g is NonNullable<typeof g> => !!g,
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click; the keyboard closes it with ? or Esc
    <dialog
      ref={ref}
      class="cheatsheet"
      aria-labelledby="cheatsheet-title"
      onCancel={(e) => {
        e.preventDefault();
        cheatsheetOpen.value = false;
      }}
      onClick={(e) => {
        if (e.target === ref.current) cheatsheetOpen.value = false;
      }}
    >
      {open && (
        <div class="cheatsheet-body">
          <header class="cheatsheet-head">
            <h2 id="cheatsheet-title" class="cheatsheet-title">
              Keyboard shortcuts
            </h2>
            <button
              type="button"
              class="source-close"
              onClick={() => {
                cheatsheetOpen.value = false;
              }}
              aria-label="Close keyboard shortcuts"
            >
              ×
            </button>
          </header>
          <div class="cheatsheet-cols">
            {ordered.map((g) => {
              const live = g.scope === "global" || g.scope === "palette" || scopes.has(g.scope);
              const meta = SCOPE_LABELS[g.scope];
              return (
                <section key={g.scope} class={`cheatsheet-group ${live ? "" : "cheatsheet-group-off"}`}>
                  <h3 class="cheatsheet-scope">
                    {meta.title}
                    {meta.note && <span class="dim"> · {meta.note}</span>}
                  </h3>
                  <dl class="cheatsheet-list">
                    {g.items.map((it) => (
                      <div key={it.key} class="cheatsheet-row">
                        <dt>
                          <kbd>{it.key}</kbd>
                        </dt>
                        <dd>{it.label}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>
          <p class="cheatsheet-foot dim">
            Keys of panes that aren't open yet (the span canvas, a request) are listed once they open. <kbd>?</kbd> or{" "}
            <kbd>Esc</kbd> closes this.
          </p>
        </div>
      )}
    </dialog>
  );
}
