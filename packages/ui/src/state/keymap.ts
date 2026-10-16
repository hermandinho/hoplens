import { signal } from "@preact/signals";

/*
 * Scoped keymap (plan 3.9, contract 4.1). Every shortcut is registered here with a label, so the
 * `?` cheatsheet, the palette and the action bar are generated from one list.
 *
 *   const off = register("trace", "f", "Jump to the verdict finding", () => focusFinding());
 *
 * Key syntax (`key` argument):
 *   "j", "?", "/", "[", "0"    the KeyboardEvent.key, case-sensitive ("R" is Shift+r)
 *   "Mod+k"                    Ctrl on Windows/Linux, Cmd on macOS. Also "Ctrl+", "Alt+", "Shift+"
 *   "Escape", "Enter", " "     named keys as KeyboardEvent.key spells them
 *   "c c"                      a two-key sequence (second key within SEQUENCE_MS)
 *
 * Scopes: "global" always applies; the others apply while they are in `activeScopes` (the shell
 * sets it from the focused pane). When two bindings match, the most specific scope wins
 * (SCOPE_ORDER), then the most recent registration. Registering never installs a listener:
 * the shell (WP1) calls `handleKeydown` from its single window keydown listener.
 */

export type KeyScope = "global" | "list" | "subject" | "trace" | "canvas" | "palette";

/** Most specific first. */
export const SCOPE_ORDER: readonly KeyScope[] = ["palette", "canvas", "trace", "subject", "list", "global"];

export interface KeyOptions {
  /** Fire even while typing in an input/textarea/select (Escape, Mod+k). Default false. */
  inInput?: boolean;
  /**
   * Extra guard checked at dispatch time, with the keydown being dispatched. The action bar and the
   * palette call it without an event to ask "is this usable right now?".
   */
  when?: (e?: KeyboardEvent) => boolean;
  /** Keep out of the cheatsheet (aliases such as ArrowDown for j). */
  hidden?: boolean;
  /** Short action-bar text ("move", "open"); defaults to the label up to its first "(" or ":". */
  hint?: string;
  /** false: not offered as a palette action (keys the palette lists elsewhere, or that only make sense as keys). */
  palette?: boolean;
  /**
   * Show in the footer action bar. Default: scoped bindings yes, global ones no (the bar is for
   * context keys; set true on the few globals worth teaching there, such as Mod+k and ?).
   */
  bar?: boolean;
  /** A global binding that still fires while a modal overlay holds the keyboard (Mod+k, ?). */
  overModal?: boolean;
}

export interface KeyBinding extends KeyOptions {
  id: number;
  scope: KeyScope;
  key: string;
  label: string;
  fn: (e: KeyboardEvent) => void;
}

/** Every live binding, in registration order. Read it to render the cheatsheet / action bar. */
export const bindings = signal<readonly KeyBinding[]>([]);

/** Scopes currently active besides "global". Set by the shell. */
export const activeScopes = signal<ReadonlySet<KeyScope>>(new Set());

/**
 * A modal overlay (palette, cheatsheet) holding the keyboard: while set, only that scope's bindings
 * and global bindings marked `overModal` fire. null = no overlay.
 */
export const modalScope = signal<KeyScope | null>(null);

let nextId = 1;

/** Register a shortcut. Returns the unregister function (call it on unmount). */
export function register(
  scope: KeyScope,
  key: string,
  label: string,
  fn: (e: KeyboardEvent) => void,
  opts: KeyOptions = {},
): () => void {
  const b: KeyBinding = { id: nextId++, scope, key, label, fn, ...opts };
  bindings.value = [...bindings.value, b];
  return () => {
    bindings.value = bindings.value.filter((x) => x.id !== b.id);
  };
}

/** Cmd on macOS/iOS, Ctrl elsewhere (Windows, Linux). */
export const IS_MAC = (() => {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || nav.platform || "");
})();

interface Stroke {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean | undefined; // undefined: implied by the key itself ("R", "?")
}

function parseStroke(s: string): Stroke {
  const parts = s.split("+");
  // "+" itself, or a trailing "+" as in "Mod++".
  let key = parts.pop() ?? "";
  if (key === "" && parts.length) {
    parts.pop();
    key = "+";
  }
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const mod = mods.has("mod");
  return {
    key,
    ctrl: mods.has("ctrl") || (mod && !IS_MAC),
    meta: mods.has("meta") || mods.has("cmd") || (mod && IS_MAC),
    alt: mods.has("alt"),
    shift: mods.has("shift") ? true : undefined,
  };
}

/** Split "c c" into strokes; "Mod+k" is one stroke. A literal space key is written " ". */
export function parseKey(key: string): Stroke[] {
  if (key === " ") return [parseStroke(" ")];
  return key.split(" ").filter(Boolean).map(parseStroke);
}

function strokeMatches(s: Stroke, e: KeyboardEvent): boolean {
  const k = s.key.length === 1 && (s.ctrl || s.meta || s.alt) ? s.key.toLowerCase() : s.key;
  const ek = k.length === 1 && (e.ctrlKey || e.metaKey || e.altKey) ? e.key.toLowerCase() : e.key;
  if (ek !== k) return false;
  if (e.ctrlKey !== s.ctrl || e.metaKey !== s.meta || e.altKey !== s.alt) return false;
  if (s.shift !== undefined && e.shiftKey !== s.shift) return false;
  return true;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * Display form for the cheatsheet: "Mod+k" -> "Ctrl+K" (Windows/Linux) / "Cmd+K" (mac),
 * "c c" -> "c c", "Escape" -> "Esc", " " -> "Space". `mac` is for tests.
 */
export function formatKey(key: string, mac = IS_MAC): string {
  const stroke = (st: string) => {
    const parts = parseKeyParts(st);
    const last = parts.length - 1;
    return parts
      .map((p, i) => {
        if (i < last) return p === "Mod" ? (mac ? "Cmd" : "Ctrl") : p === "Meta" ? (mac ? "Cmd" : "Meta") : p;
        return KEY_NAMES[p] ?? (p.length === 1 && last > 0 ? p.toUpperCase() : p);
      })
      .join("+");
  };
  if (key === " ") return stroke(" ");
  return key.split(" ").filter(Boolean).map(stroke).join(" ");
}

/** "Mod++" -> ["Mod", "+"]; "Mod+k" -> ["Mod", "k"]. */
function parseKeyParts(stroke: string): string[] {
  const parts = stroke.split("+");
  let key = parts.pop() ?? "";
  if (key === "" && parts.length) {
    parts.pop();
    key = "+";
  }
  return [...parts, key];
}

const SEQUENCE_MS = 800;
let pending: { first: KeyboardEvent; at: number } | null = null;

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ""));
}

function rank(b: KeyBinding): number {
  return SCOPE_ORDER.indexOf(b.scope);
}

/**
 * Dispatch one keydown to the best matching binding. Returns true when one fired (and the event
 * was preventDefault-ed). Sequences: the first stroke of "c c" is remembered; a single-key binding
 * on the same key fires immediately unless a sequence completes first.
 */
export function handleKeydown(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const typing = isTyping(e);
  const live = bindings.value.filter((b) => inReach(b) && (!typing || b.inInput) && (!b.when || b.when(e)));
  const now = Date.now();
  const prev = pending && now - pending.at <= SEQUENCE_MS ? pending.first : null;
  pending = null;

  const candidates: KeyBinding[] = [];
  for (const b of live) {
    const strokes = parseKey(b.key);
    if (strokes.length === 2 && prev && strokeMatches(strokes[0]!, prev) && strokeMatches(strokes[1]!, e)) {
      candidates.push(b);
    }
  }
  if (!candidates.length) {
    for (const b of live) {
      const strokes = parseKey(b.key);
      if (strokes.length === 1 && strokeMatches(strokes[0]!, e)) candidates.push(b);
    }
  }
  // Remember this stroke if it can start a sequence, unless it just completed one ("c c c" is a
  // sequence and then a fresh "c", not two sequences).
  const completed = candidates.some((b) => parseKey(b.key).length === 2);
  if (
    !completed &&
    live.some((b) => {
      const s = parseKey(b.key);
      return s.length === 2 && strokeMatches(s[0]!, e);
    })
  ) {
    pending = { first: e, at: now };
  }
  if (!candidates.length) return false;
  candidates.sort((x, y) => rank(x) - rank(y) || y.id - x.id);
  const best = candidates[0]!;
  e.preventDefault();
  best.fn(e);
  return true;
}

/** Is the binding's scope live right now (ignoring `when`)? Honours a modal overlay. */
function inReach(b: KeyBinding, ignoreModal = false): boolean {
  const modal = ignoreModal ? null : modalScope.value;
  if (modal) return b.scope === modal || (b.scope === "global" && !!b.overModal);
  return b.scope === "global" || activeScopes.value.has(b.scope);
}

/**
 * The bindings usable right now without a keydown in hand (action bar, palette actions): in reach,
 * not hidden, and `when()` passes. Most specific scope first, then registration order.
 * `ignoreModal`: as if no overlay were open (the palette lists what the page under it can do).
 */
export function usableBindings(opts: { ignoreModal?: boolean } = {}): KeyBinding[] {
  const out = bindings.value.filter((b) => !b.hidden && inReach(b, opts.ignoreModal) && (!b.when || b.when()));
  return out.sort((x, y) => rank(x) - rank(y) || x.id - y.id);
}

/** The action-bar text for a binding: its `hint`, else its label up to a "(" or ": ". */
export function hintOf(b: Pick<KeyBinding, "hint" | "label">): string {
  return b.hint ?? (b.label.split(/ \(|: /)[0] ?? b.label).trim();
}

export interface BarHint {
  /** Formatted keys, merged when neighbours share a hint ("j/k"). */
  keys: string[];
  hint: string;
  /** The first binding: what a click on the hint runs. */
  binding: KeyBinding;
}

/** Context first (list, subject, request, canvas), then the globals that opted in. */
const BAR_ORDER: readonly KeyScope[] = ["palette", "list", "subject", "trace", "canvas", "global"];

/**
 * The footer action bar's hints (plan 3.8, "the Raycast lesson"): usable bindings that belong in
 * the bar, ordered by BAR_ORDER, with neighbours that share a hint merged ("j/k move"). Pure over
 * the list it is given (pass usableBindings()).
 */
export function barHints(list: readonly KeyBinding[], mac = IS_MAC): BarHint[] {
  const shown = list
    .filter((b) => (b.scope === "global" ? b.bar === true : b.bar !== false))
    .sort((x, y) => BAR_ORDER.indexOf(x.scope) - BAR_ORDER.indexOf(y.scope) || x.id - y.id);
  const out: BarHint[] = [];
  const seen = new Set<string>();
  for (const b of shown) {
    if (seen.has(b.key)) continue; // the same key in two scopes: the more specific one is listed
    seen.add(b.key);
    const hint = hintOf(b);
    const prev = out[out.length - 1];
    if (prev && prev.hint === hint && prev.binding.scope === b.scope) prev.keys.push(formatKey(b.key, mac));
    else out.push({ keys: [formatKey(b.key, mac)], hint, binding: b });
  }
  return out;
}

/** Run a binding as if its key had been pressed (palette, action-bar buttons). */
export function runBinding(b: KeyBinding): void {
  const first = b.key === " " ? " " : (b.key.split(" ")[0] ?? b.key);
  const key = parseKeyParts(first).pop() ?? first;
  const e =
    typeof KeyboardEvent === "function"
      ? new KeyboardEvent("keydown", { key, cancelable: true })
      : ({ key, preventDefault() {}, target: null } as unknown as KeyboardEvent);
  b.fn(e);
}

/** Bindings for the cheatsheet, grouped by scope in SCOPE_ORDER (global last). */
export function cheatsheet(): { scope: KeyScope; items: { key: string; label: string }[] }[] {
  const out: { scope: KeyScope; items: { key: string; label: string }[] }[] = [];
  for (const scope of SCOPE_ORDER) {
    // One row per key. Several lists share j / k in the "list" scope, each guarded by `when`: the
    // row shows the binding usable right now, else the first registered. In a live scope a key whose
    // every binding is guarded off does nothing here, so it is left out (Enter on Queries, r2).
    const live = scope === "global" || activeScopes.value.has(scope);
    const byKey = new Map<string, KeyBinding>();
    const usable = new Set<string>();
    for (const b of bindings.value) {
      if (b.scope !== scope || b.hidden) continue;
      const ok = !b.when || b.when();
      if (ok) usable.add(b.key);
      const cur = byKey.get(b.key);
      if (!cur || (cur.when && !cur.when() && ok)) byKey.set(b.key, b);
    }
    const items = [...byKey.values()]
      .filter((b) => !live || usable.has(b.key))
      .map((b) => ({ key: formatKey(b.key), label: b.label }));
    if (items.length) out.push({ scope, items });
  }
  return out;
}
