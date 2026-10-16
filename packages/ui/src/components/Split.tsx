import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/*
 * The list | subject split every view uses (plan 3.1 "one list, one subject", 3.2).
 *  - With no subject the list takes the full width: nothing is drawn that is empty.
 *  - The splitter drags (pointer) and steps (Arrow keys, Shift for bigger steps); the list width is
 *    remembered per split id once dragged (before that it is 38% of the width, layout.css). Min
 *    320px list, 560px subject (plan 3.10).
 *  - Double-click the splitter (or toggleListRail(id), bound to Ctrl+\ by the keymap) collapses
 *    the list to a 48px rail.
 *  - Below 900px the panes stack (mobile proper is WP11).
 */

export const LIST_MIN = 320;
export const SUBJECT_MIN = 560;
const HANDLE = 8;
/** Fallback when the list can't be measured yet (the CSS default is a share of the width). */
const DEFAULT_W = 440;
const STEP = 16;

const KEY = (id: string) => `hoplens.split.${id}`;

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: the width just isn't remembered */
  }
}

/** Collapsed-to-rail state per split id (remembered per view). */
export const listRail = signal<Readonly<Record<string, boolean>>>({});

export function toggleListRail(id: string): void {
  const on = !(listRail.value[id] ?? readStore(`${KEY(id)}.rail`) === "1");
  listRail.value = { ...listRail.value, [id]: on };
  writeStore(`${KEY(id)}.rail`, on ? "1" : "0");
}

function isRail(id: string): boolean {
  return listRail.value[id] ?? readStore(`${KEY(id)}.rail`) === "1";
}

export interface SplitProps {
  /** Remembers the width and rail state under this id (one per view). */
  id: string;
  list: ComponentChildren;
  /** The selected item. null/undefined: no subject, the list takes the full width. */
  subject?: ComponentChildren | null;
  listLabel: string;
  subjectLabel?: string;
  listClass?: string;
  subjectClass?: string;
  /** Collapsed rail content (defaults to an expand button). */
  rail?: ComponentChildren;
  /** Pointer over the list, or focus inside the subject: the live list should hold still. */
  onHold?: (held: boolean) => void;
}

export function Split(props: SplitProps) {
  const { id, list, subject, listLabel, subjectLabel, listClass = "", subjectClass = "", onHold } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  // null: never dragged, the CSS default (a share of the width) applies.
  const [stored, setWidth] = useState<number | null>(() => {
    const raw = readStore(KEY(id));
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= LIST_MIN ? n : null;
  });
  const listWidth = () =>
    rootRef.current?.querySelector<HTMLElement>(":scope > .split-list")?.getBoundingClientRect().width ?? DEFAULT_W;
  const width = stored ?? Math.round(listWidth());
  const hasSubject = subject !== null && subject !== undefined && subject !== false;
  const rail = hasSubject && isRail(id);

  // Hold = list hovered || subject focused. Tracked here so both halves feed one flag.
  const hold = useRef({ hover: false, focus: false, on: false });
  const setHold = (patch: Partial<{ hover: boolean; focus: boolean }>) => {
    const h = hold.current;
    Object.assign(h, patch);
    const on = h.hover || h.focus;
    if (on !== h.on) {
      h.on = on;
      onHold?.(on);
    }
  };
  // Released on unmount (view switch) so Follow never stays paused by a pane that is gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per mount
  useEffect(() => () => onHold?.(false), []);
  // The subject closing while focused inside it: focusout doesn't fire for removed nodes.
  useEffect(() => {
    if (!hasSubject) setHold({ focus: false });
  });

  const clamp = (w: number) => {
    const total = rootRef.current?.clientWidth ?? 0;
    const max = Math.max(LIST_MIN, total - SUBJECT_MIN - HANDLE);
    return Math.round(Math.min(max, Math.max(LIST_MIN, w)));
  };
  const commit = (w: number) => {
    const c = clamp(w);
    setWidth(c);
    writeStore(KEY(id), String(c));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || rail) return;
    const handle = e.currentTarget as HTMLElement;
    const left = rootRef.current?.getBoundingClientRect().left ?? 0;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    let last = width;
    const move = (ev: PointerEvent) => {
      last = clamp(ev.clientX - left - HANDLE / 2);
      setWidth(last);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      commit(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onHandleKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? STEP * 4 : STEP;
    if (e.key === "ArrowLeft") commit(width - step);
    else if (e.key === "ArrowRight") commit(width + step);
    else if (e.key === "Home") commit(LIST_MIN);
    else if (e.key === "End") commit(Number.POSITIVE_INFINITY);
    else if (e.key === "Enter") toggleListRail(id);
    else return;
    e.preventDefault();
  };

  const listPane = (
    <section
      class={`split-pane split-list ${listClass}`}
      aria-label={listLabel}
      onMouseEnter={() => setHold({ hover: true })}
      onMouseLeave={() => setHold({ hover: false })}
    >
      {list}
    </section>
  );

  if (!hasSubject) {
    return (
      <div class="split split-solo" ref={rootRef}>
        {listPane}
      </div>
    );
  }

  return (
    <div
      class={`split ${rail ? "split-rail" : ""}`}
      ref={rootRef}
      style={stored === null ? undefined : ({ "--split-w": `${stored}px` } as Record<string, string>)}
    >
      {rail ? (
        <section class="split-pane split-list split-list-rail" aria-label={`${listLabel} (collapsed)`}>
          {props.rail ?? (
            <button
              type="button"
              class="split-rail-btn"
              onClick={() => toggleListRail(id)}
              title={`Show the ${listLabel.toLowerCase()} list`}
              aria-label={`Show the ${listLabel.toLowerCase()} list`}
            >
              »
            </button>
          )}
        </section>
      ) : (
        listPane
      )}
      <div
        class="split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize list (Arrow keys; Enter or double-click collapses)"
        aria-valuemin={LIST_MIN}
        aria-valuenow={rail ? 48 : width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onDblClick={() => toggleListRail(id)}
        onKeyDown={onHandleKey}
      />
      <section
        class={`split-pane split-subject ${subjectClass}`}
        aria-label={subjectLabel}
        onFocusIn={() => setHold({ focus: true })}
        onFocusOut={(e) => {
          const next = (e as FocusEvent).relatedTarget as Node | null;
          if (!next || !(e.currentTarget as HTMLElement).contains(next)) setHold({ focus: false });
        }}
      >
        {subject}
      </section>
    </div>
  );
}
