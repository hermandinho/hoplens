import { effect, signal } from "@preact/signals";
import { HoplensApiError, WRITE_HEADERS, tapLive } from "../api/client";
import type {
  Baseline,
  BaselineKind,
  BaselinesResponse,
  BucketDelta,
  CompareResult,
  CompareRow,
  CountDelta,
  JsonDiffOp,
  PinsResponse,
} from "../api/types";
import { register } from "./keymap";
import { type Route, go, route, sameRoute } from "./router";
import { BUCKET_LABELS, fmtMs } from "./stats";

/*
 * Compare (plan 3.4, WP8 UI): the merged diff of two requests, A = baseline, B = subject
 * (#/cmp/<a>..<b>). This module holds the pure view helpers (unit-tested in test/compare.test.ts)
 * and the live half: the compare fetch, the baselines for the open request, server-side pins, the
 * "pick the baseline from the list" mode (`c c`) and the keys c, c c, d, p.
 *
 * Entry points: `c` on a request opens its default baseline (previous build, else the previous
 * same-URL request, else the route's median exemplar; with none it starts picking), `c c` picks A
 * from the list, `d` diffs against the previous build, the subject bar's Compare button, the
 * palette (it lists these keys as actions) and the baselines row inside the compare view.
 */

const API = "/__hoplens/api";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.method && init.method !== "GET" ? WRITE_HEADERS : { accept: "application/json" };
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) throw new HoplensApiError(res.status, await res.text().catch(() => res.statusText), path);
  return (await res.json()) as T;
}

/* ===================================================================== pure helpers */

export const BASELINE_LABELS: Record<BaselineKind, string> = {
  "previous-build": "previous build",
  "previous-url": "previous same URL",
  "route-median": "route median",
};

/** The baseline `c` opens: the first (core orders them previous build, same URL, route median) that isn't B itself. */
export function defaultBaseline(list: readonly Baseline[] | undefined, b: string): Baseline | undefined {
  return list?.find((x) => x.id !== b);
}

/** `d`: the previous build's request, when there is one. */
export function previousBuild(list: readonly Baseline[] | undefined, b: string): Baseline | undefined {
  return list?.find((x) => x.kind === "previous-build" && x.id !== b);
}

export function compareRoute(a: string, b: string, since?: string): Route {
  return since ? { view: "compare", a, b, since } : { view: "compare", a, b };
}

/** Pick mode (`c c`): the next request opened from the list becomes A, B stays. */
export interface PickState {
  b: string;
}

/**
 * Where a pick lands: when the route opens a request other than B while picking, the compare route
 * with that request as A. null = nothing picked (yet).
 */
export function resolvePick(pick: PickState | null, r: Route): Route | null {
  if (!pick || r.view !== "trace" || r.traceId === pick.b) return null;
  return compareRoute(r.traceId, pick.b, r.since);
}

/** A compare `c` opened by itself: where it came from, where it went, when. */
export interface AutoCompare {
  from: Route;
  to: Route;
  at: number;
}

/** How long after `c` opened a compare a second `c` counts as `c c` (the keymap's SEQUENCE_MS, plus slack). */
export const CHORD_UNDO_MS = 1000;

/**
 * `c c` from a request: the first `c` already opened the default compare (single keys fire at once).
 * When the open view is still that compare, opened within `windowMs`, the pick should start from the
 * request it came from: returns that route; else null (stay where you are).
 */
export function chordUndo(last: AutoCompare | null, cur: Route, now: number, windowMs = CHORD_UNDO_MS): Route | null {
  if (!last || now - last.at > windowMs || !sameRoute(cur, last.to)) return null;
  return last.from;
}

/**
 * Noise floor for a span or bucket tone: a change counts only past both 5ms and 20% of A (the
 * regression rule's max(20%, 5ms), also used by replay vs-last-run, Changes and the since strip).
 * Core's row `status` is finer (1ms / 10%) and only decides what "changes only" keeps.
 */
export const NOISE_MS = 5;
export const NOISE_PCT = 0.2;

export function isSame(a: number, b: number): boolean {
  const d = Math.abs(b - a);
  return d < NOISE_MS || d < NOISE_PCT * a;
}

export type Tone = "worse" | "better" | "same";

/** Diff color for a ms change (red = slower, green = faster, gray = within noise). */
export function toneOf(a: number, b: number): Tone {
  if (isSame(a, b)) return "same";
  return b > a ? "worse" : "better";
}

/** "+52ms", "−3.0ms", "=" (under 0.05ms). */
export function fmtDelta(ms: number): string {
  if (Math.abs(ms) < 0.05) return "=";
  return `${ms > 0 ? "+" : "−"}${fmtMs(Math.abs(ms))}`;
}

/** "+134%" / "−20%"; undefined without a base. */
export function fmtDeltaPct(a: number, b: number): string | undefined {
  if (!(a > 0)) return undefined;
  const p = Math.round(((b - a) / a) * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}%`;
}

export type RowMark = "added" | "removed" | Tone;

/** A span row's mark: only-in-B / only-in-A carry a glyph and a label, not a hue (plan 3.4). */
export function rowMark(r: Pick<CompareRow, "status" | "a" | "b">): RowMark {
  if (r.status === "onlyB") return "added";
  if (r.status === "onlyA") return "removed";
  if (r.status === "same") return "same";
  return toneOf(r.a?.wallMs ?? 0, r.b?.wallMs ?? 0);
}

/** Repeat counts: "x10 → x1" when they differ, "x12" when both repeat the same, "" for single spans. */
export function countText(r: Pick<CompareRow, "a" | "b">): string {
  const a = r.a?.count;
  const b = r.b?.count;
  if (a !== undefined && b !== undefined) {
    if (a !== b) return `x${a} → x${b}`;
    return a > 1 ? `x${a}` : "";
  }
  const n = a ?? b ?? 0;
  return n > 1 ? `x${n}` : "";
}

/**
 * Rows to draw. `changesOnly` keeps every row that is not "same" plus its ancestors, so a change
 * deep in the tree still reads in context. Order (depth-first) is kept.
 */
export function visibleRows(rows: readonly CompareRow[], changesOnly: boolean): CompareRow[] {
  if (!changesOnly) return [...rows];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keep = new Set<string>();
  for (const r of rows) {
    if (r.status === "same") continue;
    let cur: CompareRow | undefined = r;
    while (cur && !keep.has(cur.key)) {
      keep.add(cur.key);
      cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
    }
  }
  return rows.filter((r) => keep.has(r.key));
}

export interface BucketView {
  bucket: BucketDelta["bucket"];
  label: string;
  /** ms, or % of the side's total in "share" mode. */
  a: number;
  b: number;
  delta: number;
  tone: Tone;
  /** |delta| relative to the largest |delta| shown, 0..1 (the bar's width). */
  bar: number;
}

/**
 * The bucket table: buckets with time on either side, largest change first. "share" turns each
 * side into percent of its own total, so a request that is slower overall can still show which
 * bucket grew its share.
 */
export function bucketView(buckets: readonly BucketDelta[], mode: "abs" | "share"): BucketView[] {
  const totA = buckets.reduce((s, x) => s + x.a, 0);
  const totB = buckets.reduce((s, x) => s + x.b, 0);
  const rows = buckets
    .filter((x) => x.a >= 0.05 || x.b >= 0.05)
    .map((x) => {
      const a = mode === "share" ? (totA > 0 ? (x.a / totA) * 100 : 0) : x.a;
      const b = mode === "share" ? (totB > 0 ? (x.b / totB) * 100 : 0) : x.b;
      // Share points: a 10-point move is "changed"; ms: the row rule.
      const tone: Tone = mode === "share" ? (Math.abs(b - a) < 2 ? "same" : b > a ? "worse" : "better") : toneOf(a, b);
      return { bucket: x.bucket, label: BUCKET_LABELS[x.bucket] ?? x.bucket, a, b, delta: b - a, tone, bar: 0 };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.bucket.localeCompare(y.bucket));
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.delta)));
  for (const r of rows) r.bar = max > 0 ? Math.abs(r.delta) / max : 0;
  return rows;
}

const COUNT_LABELS: Record<CountDelta["name"], string> = {
  spans: "spans",
  db: "db queries",
  fetch: "fetches",
  cache: "cache ops",
  fn: "functions",
  warn: "warnings",
  error: "errors",
};

/** "db queries 1 → 50" for each count that changed; spans last (it moves with everything else). */
export function countChanges(counts: readonly CountDelta[]): { text: string; tone: Tone }[] {
  return counts
    .filter((c) => c.delta !== 0)
    .sort((x, y) => Number(x.name === "spans") - Number(y.name === "spans"))
    .map((c) => ({
      text: `${COUNT_LABELS[c.name] ?? c.name} ${c.a} → ${c.b}`,
      tone: c.name === "spans" ? "same" : c.delta > 0 ? "worse" : "better",
    }));
}

export const OP_GLYPH: Record<JsonDiffOp["op"], string> = { add: "+", remove: "−", replace: "~", type: "≠" };

/** A JSON value for one diff cell, at most `max` characters. */
export function jsonText(v: unknown, max = 60): string {
  if (v === undefined) return "—";
  let s: string;
  try {
    s = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One body/header op as a sentence: "/items/3 removed", "/price 10 → \"10\" (number → string)". */
export function opText(op: JsonDiffOp): string {
  const path = op.path || "/";
  if (op.op === "add") return `${path} added: ${jsonText(op.b)}`;
  if (op.op === "remove") return `${path} removed: ${jsonText(op.a)}`;
  if (op.op === "type") return `${path} ${jsonText(op.a)} → ${jsonText(op.b)} (${op.aType} → ${op.bType})`;
  return `${path} ${jsonText(op.a)} → ${jsonText(op.b)}`;
}

/* ===================================================================== live state */

export type CompareLoad =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; data: CompareResult }
  | { key: string; status: "missing"; missing: ("a" | "b")[] }
  | { key: string; status: "error"; error: string };

export const compareKey = (a: string, b: string) => `${a}..${b}`;

/** The open compare's fetch, keyed by `a..b`. */
export const compareLoad = signal<CompareLoad | null>(null);

/** View toggles, kept across compares. */
export const changesOnly = signal(false);
export const valueMode = signal<"abs" | "share">("abs");

interface BaselinesEntry {
  status: "loading" | "ready" | "error";
  list: Baseline[];
  at: number;
}

/** Baselines per subject id (the open request, or a compare's B). */
export const baselines = signal<ReadonlyMap<string, BaselinesEntry>>(new Map());

/** Ids pinned server-side (Compare pins both sides; `p` pins the open request). */
export const pinnedIds = signal<ReadonlySet<string>>(new Set());

/** `c c`: picking A from the list for this B. null = not picking. */
export const pickState = signal<PickState | null>(null);

/** Last compare/pin failure, shown in the compare view and next to the pin. Cleared on navigation. */
export const compareNotice = signal<string | null>(null);

/** The compare the last `c` opened on its own (for `c c`, see chordUndo). */
let lastAuto: AutoCompare | null = null;

let compareSeq = 0;

async function loadCompare(a: string, b: string): Promise<void> {
  const key = compareKey(a, b);
  const cur = compareLoad.peek();
  if (cur?.key === key && cur.status !== "error") return;
  const seq = ++compareSeq;
  compareLoad.value = { key, status: "loading" };
  try {
    const data = await call<CompareResult>(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    if (seq !== compareSeq) return;
    compareLoad.value = { key, status: "ready", data };
    void refreshPins();
  } catch (err) {
    if (seq !== compareSeq) return;
    if (err instanceof HoplensApiError && err.status === 404) {
      let missing: ("a" | "b")[] = [];
      try {
        missing = (JSON.parse(err.body) as { missing?: ("a" | "b")[] }).missing ?? [];
      } catch {
        /* older core: no body */
      }
      compareLoad.value = { key, status: "missing", missing: missing.length ? missing : ["a", "b"] };
      return;
    }
    compareLoad.value = { key, status: "error", error: (err as Error).message };
  }
}

/** Re-fetch the open compare (after an error). */
export function retryCompare(): void {
  const r = route.peek();
  if (r.view !== "compare") return;
  compareLoad.value = null;
  void loadCompare(r.a, r.b);
}

const BASELINES_TTL_MS = 10_000;
const BASELINES_KEEP = 40;

function setBaselines(id: string, e: BaselinesEntry): void {
  const next = new Map(baselines.peek());
  next.delete(id);
  next.set(id, e);
  while (next.size > BASELINES_KEEP) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  baselines.value = next;
}

const inflight = new Map<string, Promise<Baseline[]>>();

/** Baselines for subject `b`; cached for a few seconds (new traffic changes the route median). */
export function loadBaselines(b: string, force = false): Promise<Baseline[]> {
  const cur = baselines.peek().get(b);
  if (!force && cur?.status === "ready" && Date.now() - cur.at < BASELINES_TTL_MS) return Promise.resolve(cur.list);
  const pending = inflight.get(b);
  if (pending) return pending;
  if (!cur) setBaselines(b, { status: "loading", list: [], at: Date.now() });
  const p = call<BaselinesResponse>(`/compare/baselines?b=${encodeURIComponent(b)}`)
    .then((res) => {
      setBaselines(b, { status: "ready", list: res.baselines ?? [], at: Date.now() });
      return res.baselines ?? [];
    })
    .catch(() => {
      setBaselines(b, { status: "error", list: [], at: Date.now() });
      return [] as Baseline[];
    })
    .finally(() => inflight.delete(b));
  inflight.set(b, p);
  return p;
}

export function baselinesOf(b: string): BaselinesEntry | undefined {
  return baselines.value.get(b);
}

let pinsKnown = false;

export async function refreshPins(): Promise<void> {
  try {
    const res = await call<PinsResponse>("/compare/pins");
    pinsKnown = true;
    // The user's own pins (`p`). Compare's automatic pins aren't shown (older core: every pin).
    pinnedIds.value = new Set(res.manual ?? res.pinned ?? []);
  } catch {
    /* older core without the list: keep what we know */
  }
}

export async function setPinned(id: string, on: boolean): Promise<void> {
  const prev = pinnedIds.peek();
  const next = new Set(prev);
  if (on) next.add(id);
  else next.delete(id);
  pinnedIds.value = next;
  try {
    await call(`/compare/pins/${encodeURIComponent(id)}`, { method: on ? "POST" : "DELETE" });
    compareNotice.value = null;
    void refreshPins(); // the server caps manual pins at 20 and releases the oldest
  } catch (err) {
    pinnedIds.value = prev;
    compareNotice.value =
      err instanceof HoplensApiError && err.status === 404
        ? "Can't pin: the request has rotated out."
        : `Could not ${on ? "pin" : "unpin"}: ${(err as Error).message}`;
  }
}

export function togglePin(id: string): void {
  void setPinned(id, !pinnedIds.peek().has(id));
}

/** Open the compare of `a` against `b` (push; `replace` for baseline switches inside the view). */
export function openCompare(a: string, b: string, opts: { replace?: boolean } = {}): void {
  pickState.value = null;
  go(compareRoute(a, b, route.peek().since), opts);
}

export function startPick(b: string): void {
  pickState.value = { b };
}

export function cancelPick(): void {
  pickState.value = null;
}

/**
 * `c` / the Compare button: the default baseline, or, with none, start picking one from the list.
 * Fetches the baselines first when they aren't known yet.
 */
export async function compareDefault(b: string): Promise<void> {
  const list = await loadBaselines(b);
  // Moved on while loading, or `c c` already switched to picking.
  if (subjectId() !== b || pickState.peek()?.b === b) return;
  const base = defaultBaseline(list, b);
  if (base) {
    const from = route.peek();
    openCompare(base.id, b);
    lastAuto = { from, to: route.peek(), at: Date.now() };
  } else startPick(b);
}

/** The request the compare keys act on: the open request, or a compare's B. */
export function subjectId(): string | undefined {
  const r = route.peek();
  if (r.view === "trace") return r.traceId;
  if (r.view === "compare") return r.b;
  return undefined;
}

/* ===================================================================== wiring */

/**
 * Effects and keys. Called once by the shell (MainPane); returns the disposer.
 *   route compare  -> fetch the diff (pins both sides), baselines for B
 *   route trace    -> baselines for the open request (debounced: j/k steps quickly)
 *   picking        -> the next request opened from the list becomes A
 */
export function initCompare(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Pin badges in the log need the server's pins on every view, not only once a request is open.
  void refreshPins();
  let lastRoute: Route | null = null;
  const stopRoute = effect(() => {
    const r = route.value;
    // A notice belongs to the view it was raised in (a failed pin on a request must not turn up on
    // the next compare).
    if (lastRoute && !sameRoute(lastRoute, r)) compareNotice.value = null;
    lastRoute = r;
    if (timer) clearTimeout(timer);
    timer = null;
    if (r.view === "compare") {
      void loadCompare(r.a, r.b);
      void loadBaselines(r.b);
      if (!pinsKnown) void refreshPins();
    } else if (r.view === "trace") {
      const id = r.traceId;
      timer = setTimeout(() => void loadBaselines(id), 150);
      if (!pinsKnown) void refreshPins();
    }
  });

  const stopPick = effect(() => {
    const r = route.value;
    const pick = pickState.value;
    if (!pick) return;
    const next = resolvePick(pick, r);
    if (next) {
      pickState.value = null;
      // After the go() that opened the request has written its history entry: navigating from
      // inside it would let that pushState land after (and over) this replace.
      queueMicrotask(() => {
        if (sameRoute(route.peek(), r)) go(next, { replace: true });
      });
    } else if (r.view !== "trace" && r.view !== "compare") pickState.value = null;
  });

  // A cleared store drops every pin; a reconnect may follow a server restart.
  const stopTap = tapLive((ev) => {
    if (ev.type === "clear") {
      pinnedIds.value = new Set();
      baselines.value = new Map();
    } else if (ev.type === "hello") void refreshPins();
  });

  const onTrace = () => route.peek().view === "trace";
  const offs = [
    register(
      "trace",
      "c",
      "Compare with the default baseline (previous build, same URL, or route median)",
      () => {
        const id = subjectId();
        if (id) void compareDefault(id);
      },
      { when: onTrace, hint: "compare" },
    ),
    register(
      "subject",
      "c c",
      "Pick the baseline (A) from the list",
      () => {
        const id = subjectId();
        if (!id) return;
        // From a request, the first `c` already opened the default compare: go back to the request
        // (that `c` pushed one history entry), so Esc leaves the reader where they started.
        const back = chordUndo(lastAuto, route.peek(), Date.now());
        lastAuto = null;
        if (back) {
          if (typeof history !== "undefined" && history.length > 1) history.back();
          else go(back, { replace: true });
        }
        startPick(id);
      },
      { when: () => subjectId() !== undefined, hint: "pick baseline" },
    ),
    register(
      "trace",
      "d",
      "Diff against the previous build",
      () => {
        const id = subjectId();
        const base = id ? previousBuild(baselines.peek().get(id)?.list, id) : undefined;
        if (id && base) openCompare(base.id, id);
      },
      {
        when: () => {
          const id = subjectId();
          return onTrace() && !!id && !!previousBuild(baselines.value.get(id)?.list, id);
        },
        hint: "vs previous build",
      },
    ),
    register(
      "trace",
      "p",
      "Pin / unpin this request (kept past rotation)",
      () => {
        const id = subjectId();
        if (id) togglePin(id);
      },
      { when: onTrace, hint: "pin" },
    ),
    register("subject", "Escape", "Stop picking a baseline", cancelPick, {
      when: () => pickState.value !== null,
      hint: "cancel pick",
    }),
  ];

  return () => {
    if (timer) clearTimeout(timer);
    stopRoute();
    stopPick();
    stopTap();
    for (const off of offs) off();
  };
}
