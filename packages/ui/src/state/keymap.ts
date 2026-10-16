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
  /** Extra guard checked at dispatch time. */
  when?: () => boolean;
  /** Keep out of the cheatsheet (aliases such as ArrowDown for j). */
  hidden?: boolean;
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

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

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

/** Display form for the cheatsheet: "Mod+k" -> "Ctrl+K" / "Cmd+K", "c c" -> "c c". */
export function formatKey(key: string): string {
  return key
    .split(" ")
    .map((stroke) =>
      stroke
        .split("+")
        .map((p) =>
          p === "Mod" ? (IS_MAC ? "Cmd" : "Ctrl") : p.length === 1 && stroke.includes("+") ? p.toUpperCase() : p,
        )
        .join("+"),
    )
    .join(" ");
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
  const scopes = activeScopes.value;
  const live = bindings.value.filter(
    (b) => (b.scope === "global" || scopes.has(b.scope)) && (!typing || b.inInput) && (!b.when || b.when()),
  );
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

/** Bindings for the cheatsheet, grouped by scope in SCOPE_ORDER (global last). */
export function cheatsheet(): { scope: KeyScope; items: { key: string; label: string }[] }[] {
  const out: { scope: KeyScope; items: { key: string; label: string }[] }[] = [];
  for (const scope of SCOPE_ORDER) {
    const seen = new Set<string>();
    const items: { key: string; label: string }[] = [];
    for (const b of bindings.value) {
      if (b.scope !== scope || b.hidden || seen.has(b.key)) continue;
      seen.add(b.key);
      items.push({ key: formatKey(b.key), label: b.label });
    }
    if (items.length) out.push({ scope, items });
  }
  return out;
}
