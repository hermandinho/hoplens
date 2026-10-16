import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { swipeIntent } from "../state/mobile";
import { type MainView, findingGroups, mainView, setMainView, tracesWithErrors } from "../state/store";

/*
 * Phone-only pieces of the shell (plan 3.6, WP11). Mounted at every width, shown only under the
 * mobile breakpoint by layout.css (`@media (max-width: 760px)`), so a resize never remounts state.
 *   <MobileTabs/>   the view tabs at the bottom, padded for the safe area
 *   <Sheet/>        a bottom sheet (native modal dialog): the trace details live in one on mobile
 *   useSwipe()      horizontal flick on the open request -> newer / older request
 */

const TABS: ReadonlyArray<{ id: MainView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "requests", label: "Requests" },
  { id: "queries", label: "Queries" },
  { id: "changes", label: "Changes" },
];

export function MobileTabs() {
  const view = mainView.value;
  const findings = findingGroups.value.length;
  const errs = tracesWithErrors.value;
  return (
    <nav class="mtabs" aria-label="Views">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          class="mtab"
          aria-current={view === t.id ? "page" : undefined}
          onClick={() => setMainView(t.id)}
        >
          <span class="mtab-label">{t.label}</span>
          {t.id === "overview" && findings > 0 && <span class="mtab-count">{findings}</span>}
          {t.id === "requests" && errs > 0 && (
            <span class="mtab-count mtab-count-err" aria-label={`${errs} with 5xx errors`}>
              {errs}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

export interface SheetProps {
  open: boolean;
  label: string;
  onClose: () => void;
  /** Rendered in the sheet's header, beside Close (tabs, a title). */
  head?: ComponentChildren;
  children: ComponentChildren;
}

/**
 * Bottom sheet. A native modal <dialog>: focus is trapped and handed back on close, Esc closes it,
 * a tap on the scrim closes it. Esc is stopped here so the page's own Esc bindings don't also fire.
 */
export function Sheet({ open, label, onClose, head, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
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
  // Closing on unmount: a removed open modal would leave the page inert in some engines.
  useEffect(
    () => () => {
      if (ref.current?.open) ref.current.close();
    },
    [],
  );
  return (
    <dialog
      ref={ref}
      class="sheet"
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div class="sheet-body">
          <div class="sheet-grip" aria-hidden="true" />
          <div class="sheet-head">
            {head}
            <button type="button" class="sheet-close" onClick={onClose}>
              Close
            </button>
          </div>
          <div class="sheet-content">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** Is `el` (or an ancestor up to `stop`) something that scrolls sideways or takes its own drags? */
function ownsHorizontalDrag(el: Element | null, stop: Element): boolean {
  for (let n = el; n && n !== stop; n = n.parentElement) {
    if (n.tagName === "DIALOG" || n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT")
      return true;
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

/**
 * Touch handlers for a horizontal flick (state/mobile swipeIntent). Gestures that start on something
 * that scrolls sideways (code, the tree, a table) or inside a dialog are left alone.
 */
export function useSwipe(on: (dir: "older" | "newer") => void) {
  const start = useRef<{ x: number; y: number; t: number; skip: boolean } | null>(null);
  return {
    onTouchStart: (e: TouchEvent) => {
      const p = e.touches[0];
      if (e.touches.length !== 1 || !p) {
        start.current = null;
        return;
      }
      start.current = {
        x: p.clientX,
        y: p.clientY,
        t: e.timeStamp,
        skip: ownsHorizontalDrag(e.target as Element, e.currentTarget as Element),
      };
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current;
      start.current = null;
      const p = e.changedTouches[0];
      if (!s || s.skip || !p) return;
      const dir = swipeIntent({ dx: p.clientX - s.x, dy: p.clientY - s.y, dt: e.timeStamp - s.t });
      if (dir) on(dir);
    },
    onTouchCancel: () => {
      start.current = null;
    },
  };
}
