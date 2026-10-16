import { batch } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { callSites, culpritLoc } from "../state/callSite";
import { epochLabel, epochList } from "../state/epochs";
import { openErrorsPanel, processErrorTotal } from "../state/health";
import { type KeyBinding, formatKey, register, runBinding, usableBindings } from "../state/keymap";
import {
  GROUP_LABELS,
  type PaletteActs,
  type PaletteItem,
  buildItems,
  cheatsheetOpen,
  editsOf,
  flatRows,
  paletteOpen,
  pushRecent,
  rankItems,
  readRecents,
  writeRecents,
} from "../state/palette";
import { queriesData, queriesState, refreshQueries } from "../state/queries";
import { quoteValue } from "../state/querySuggest";
import { prefillQuery } from "../state/requestLog";
import { go, route, setSince } from "../state/router";
import {
  type MainView,
  bootstrap,
  loadTrace,
  overviewFindings,
  routeStats,
  setMainView,
  toggleFollow,
  tracesState,
} from "../state/store";

/*
 * Command palette (plan 3.8): Ctrl/Cmd+K toggles it. Findings, routes, recent requests, query
 * shapes, edits, views and actions in one list. Recents show before typing; every row shows its
 * shortcut on the right; Enter runs the primary action, Ctrl/Cmd+Enter the secondary one. Free
 * text is also sent to the server search (`/traces?q=`), so a request matching only in its logs or
 * body is found too. Matching and ranking live in state/palette.ts.
 */

const VIEWS: ReadonlyArray<[MainView, string, string]> = [
  ["overview", "Overview", "1"],
  ["requests", "Requests", "2"],
  ["queries", "Queries", "3"],
  ["changes", "Changes", "4"],
];

const SEARCH_DEBOUNCE_MS = 200;
const LIST_ID = "palette-list";

const ACTS: PaletteActs = {
  openTrace: (id) => void loadTrace(id, "user"),
  openRoute: (key) => go({ view: "overview", routeKey: key }),
  filterRequests: (q) => prefillQuery(q),
  openShape: (fingerprint) => go({ view: "queries", shape: fingerprint }),
  openEdit: (epoch) => go({ view: "changes", epoch: String(epoch) }),
  scopeSince: (epoch) => setSince(String(epoch)),
};

/** Views and the keymap's usable actions (as on the page under the palette), plus button-only ones. */
function extraItems(): PaletteItem[] {
  const out: PaletteItem[] = VIEWS.map(([view, label, key]) => ({
    id: `view:${view}`,
    group: "views",
    title: label,
    shortcut: key,
    primary: { label: "Go", run: () => setMainView(view) },
  }));
  const seen = new Set<string>();
  for (const b of usableBindings({ ignoreModal: true })) {
    if (b.palette === false || b.scope === "palette") continue;
    const id = `action:${b.scope}:${b.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      group: "actions",
      title: b.label,
      shortcut: formatKey(b.key),
      primary: { label: "Run", run: () => runBinding(b as KeyBinding) },
    });
  }
  const procErrors = processErrorTotal.peek();
  if (procErrors > 0) {
    out.push({
      id: "action:process-errors",
      group: "actions",
      title: `Show process errors (${procErrors})`,
      keywords: "uncaught exception unhandled rejection health crash",
      sev: "err",
      primary: { label: "Show", run: openErrorsPanel },
    });
  }
  out.push(
    {
      id: "action:follow",
      group: "actions",
      title: "Toggle Follow (open each new request as it arrives)",
      primary: { label: "Run", run: toggleFollow },
    },
    {
      id: "action:refresh",
      group: "actions",
      title: "Refresh: re-scan routes and reload requests",
      primary: { label: "Run", run: () => void bootstrap() },
    },
  );
  return out;
}

export function Palette() {
  const open = paletteOpen.value;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const [extra, setExtra] = useState<PaletteItem[]>([]);
  const [hits, setHits] = useState<{ q: string; ids: ReadonlySet<string> } | null>(null);
  const [searching, setSearching] = useState(false);

  // Open/close the native modal dialog (focus trap, restores focus on close).
  useLayoutEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      setCursor(0);
      setHits(null);
      setRecents(readRecents());
      // Actions are what the page under the palette can do right now: read before it opens.
      setExtra(extraItems());
      if (!queriesData.peek() && queriesState.peek() !== "loading" && queriesState.peek() !== "unavailable") {
        void refreshQueries();
      }
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
      inputRef.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Server search for free text: matches logs and bodies the summaries don't carry.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    const ctrl = typeof AbortController === "undefined" ? null : new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .searchTraces(quoteValue(q), ctrl ? { signal: ctrl.signal } : undefined)
        .then((res) => setHits({ q, ids: new Set(res.traces.map((t) => t.id)) }))
        .catch(() => {
          /* aborted or unavailable: the client-side match still stands */
        })
        .finally(() => {
          if (!ctrl?.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl?.abort();
    };
  }, [query, open]);

  const traces = tracesState.value;
  const findings = overviewFindings.value;
  const routes = routeStats.value;
  const shapes = queriesData.value?.queries;
  const serverEdits = epochList.value;
  // Resolved N+1 call lines (culpritLoc reads them): a trigger to rebuild the finding rows.
  const sites = callSites.value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sites` is a trigger, see above
  const items = useMemo(
    () =>
      open
        ? buildItems(
            {
              findings,
              routes,
              traces,
              shapes: shapes ?? [],
              edits: editsOf(
                traces,
                serverEdits.map((e) => ({
                  id: e.id,
                  at: e.at,
                  label: epochLabel(e),
                  files: [...e.files, ...e.deleted],
                })),
              ),
              search: hits && hits.q === query.trim() ? hits : undefined,
              extra,
              locOf: culpritLoc,
            },
            ACTS,
          )
        : [],
    [open, findings, routes, traces, shapes, serverEdits, hits, query, extra, sites],
  );
  const sections = useMemo(() => rankItems(items, query, { recents }), [items, query, recents]);
  const rows = flatRows(sections);
  const active = rows.length ? Math.min(cursor, rows.length - 1) : -1;

  const choose = (item: PaletteItem | undefined, secondary: boolean) => {
    if (!item) return;
    const action = secondary ? (item.secondary ?? item.primary) : item.primary;
    const next = pushRecent(readRecents(), item.id);
    writeRecents(next);
    paletteOpen.value = false;
    // After the dialog closed and handed focus back, so the action sees the page's focus.
    setTimeout(action.run, 0);
  };

  // Keys while open: registered in the "palette" scope, so the `?` sheet lists them too.
  const state = useRef({ rows, active, choose });
  state.current = { rows, active, choose };
  useEffect(() => {
    const move = (d: number) => {
      const n = state.current.rows.length;
      if (!n) return;
      setCursor((c) => (Math.min(c, n - 1) + d + n) % n);
    };
    // Only while the palette itself is open (the cheatsheet shares the modal scope).
    const opts = { inInput: true, palette: false, when: () => paletteOpen.peek() } as const;
    const offs = [
      register("palette", "ArrowDown", "Next row", () => move(1), { ...opts, hint: "move" }),
      register("palette", "ArrowUp", "Previous row", () => move(-1), { ...opts, hint: "move" }),
      register(
        "palette",
        "Enter",
        "Run the row's primary action (open)",
        () => {
          const s = state.current;
          s.choose(s.rows[s.active], false);
        },
        { ...opts, hint: "open" },
      ),
      register(
        "palette",
        "Mod+Enter",
        "Run the row's secondary action (filter, scope)",
        () => {
          const s = state.current;
          s.choose(s.rows[s.active], true);
        },
        { ...opts, hint: "secondary" },
      ),
      register(
        "palette",
        "Escape",
        "Close the palette (or the shortcuts sheet)",
        () => {
          batch(() => {
            paletteOpen.value = false;
            cheatsheetOpen.value = false;
          });
        },
        { inInput: true, palette: false, hint: "close" },
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  // Keep the active row in view (`open`: also on reopening).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` is a trigger
  useLayoutEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`#palette-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  let i = -1;
  const activeItem = rows[active];
  return (
    // The backdrop click closes it; the keyboard closes it with Esc or Ctrl/Cmd+K (state/keymap).
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard close is the palette-scope Escape binding
    <dialog
      ref={dialogRef}
      class="palette"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        paletteOpen.value = false;
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) paletteOpen.value = false;
      }}
    >
      {open && (
        <div class="palette-body">
          <div class="palette-search">
            <input
              ref={inputRef}
              class="palette-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={LIST_ID}
              aria-activedescendant={active >= 0 ? `palette-opt-${active}` : undefined}
              aria-label="Find a route, request, finding, query shape, edit or action"
              placeholder="Find a route, request, finding, query or action…"
              value={query}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setCursor(0);
              }}
            />
            {searching && <span class="palette-searching dim">searching…</span>}
          </div>
          {/* Combobox popup: focus stays in the input, rows are picked via aria-activedescendant. */}
          {/* biome-ignore lint/a11y/useSemanticElements: combobox popup, see above */}
          {/* biome-ignore lint/a11y/useFocusableInteractive: combobox popup, see above */}
          <div class="palette-list" id={LIST_ID} role="listbox" ref={listRef} aria-label="Results">
            {sections.length === 0 && <p class="palette-empty dim">Nothing matches “{query.trim()}”.</p>}
            {sections.map((s) => (
              // biome-ignore lint/a11y/useSemanticElements: an option group inside the listbox, not a form fieldset
              <div key={s.group} role="group" aria-label={GROUP_LABELS[s.group]} class="palette-group">
                <div class="palette-group-head" aria-hidden="true">
                  {GROUP_LABELS[s.group]}
                </div>
                {s.items.map((it) => {
                  i++;
                  const idx = i;
                  const on = idx === active;
                  return (
                    // biome-ignore lint/a11y/useFocusableInteractive: combobox option (aria-activedescendant)
                    // biome-ignore lint/a11y/useKeyWithClickEvents: Enter / Ctrl+Enter on the input pick it
                    <div
                      key={it.id}
                      id={`palette-opt-${idx}`}
                      // biome-ignore lint/a11y/useSemanticElements: combobox option, see above
                      role="option"
                      aria-selected={on}
                      class={`palette-row ${on ? "palette-row-on" : ""}`}
                      onMouseMove={() => {
                        if (!on) setCursor(idx);
                      }}
                      onClick={(e) => choose(it, e.ctrlKey || e.metaKey)}
                    >
                      <span class={`palette-dot ${it.sev ? `palette-dot-${it.sev}` : ""}`} aria-hidden="true" />
                      <span class={`palette-title ${MONO.has(it.group) ? "mono" : ""}`}>{it.title}</span>
                      {it.detail && <span class="palette-detail dim">{it.detail}</span>}
                      <span class="palette-right">
                        {on ? (
                          <span class="palette-acts">
                            <span>
                              <kbd>Enter</kbd> {it.primary.label}
                            </span>
                            {it.secondary && (
                              <span>
                                <kbd>{formatKey("Mod+Enter")}</kbd> {it.secondary.label}
                              </span>
                            )}
                          </span>
                        ) : (
                          it.shortcut && <kbd>{it.shortcut}</kbd>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <footer class="palette-foot dim">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> {activeItem?.primary.label.toLowerCase() ?? "open"}
            </span>
            <span>
              <kbd>{formatKey("Mod+Enter")}</kbd> {activeItem?.secondary?.label.toLowerCase() ?? "secondary"}
            </span>
            <span>
              <kbd>Esc</kbd> or <kbd>{formatKey("Mod+k")}</kbd> close
            </span>
          </footer>
        </div>
      )}
    </dialog>
  );
}

const MONO = new Set<PaletteItem["group"] | "recent">(["routes", "requests", "shapes", "edits"]);
