// Per-trace facts: where the time went, sizes, counts. Pure and framework-neutral so it can be
// unit-tested without a runtime. Runs in finalize(), after the response finished — never on the
// request's hot path.

import type { SpanRecord, TimeBucket, TraceFacts, TraceRecord } from "./types";

/** Facts and findings stop looking at spans past this many (sorted by start). */
export const MAX_ANALYZED_SPANS = 2000;

export const TIME_BUCKETS: readonly TimeBucket[] = ["db", "cache", "ext", "fn", "framework", "compile", "idle"];

export interface FactsInput {
  /** ms from trace start to the first response write. */
  ttfb?: number;
  /** Request body bytes (content-length, else the captured body size). */
  reqBytes?: number;
  /** Response body bytes as written by the app. Falls back to the captured body size. */
  resBytes?: number;
  epoch?: number;
  cold?: boolean;
  droppedSpans?: number;
}

/** Spans with no duration (e.g. Drizzle's logger markers) are counted but never timed. */
export function isMarker(s: SpanRecord): boolean {
  return !(s.end > s.start);
}

export function isRedis(s: SpanRecord): boolean {
  return s.kind === "db" && String(s.attrs["db.system"] ?? "").toLowerCase() === "redis";
}

/**
 * Bucket for a span's self time. "fn" is the user's code: wrapped functions, the route handler body
 * and the proxy (middleware) file. Everything else Next runs is "framework". The request root itself
 * is reported as "idle": time inside the request that no child span accounts for.
 */
export function bucketOf(s: SpanRecord): TimeBucket {
  switch (s.kind) {
    case "db":
      return isRedis(s) ? "cache" : "db";
    case "fetch":
      return "ext";
    case "function":
    case "handler":
    case "proxy":
      return "fn";
    case "compile":
      return "compile";
    case "request":
      return "idle";
    default:
      return "framework";
  }
}

/** Spans sorted by start and capped at `max`. */
export function cappedSpans(t: TraceRecord, max = MAX_ANALYZED_SPANS): { spans: SpanRecord[]; truncated: boolean } {
  const sorted = isSortedByStart(t.spans) ? t.spans : [...t.spans].sort((a, b) => a.start - b.start);
  return sorted.length > max ? { spans: sorted.slice(0, max), truncated: true } : { spans: sorted, truncated: false };
}

function isSortedByStart(spans: SpanRecord[]): boolean {
  for (let i = 1; i < spans.length; i++) if (spans[i]!.start < spans[i - 1]!.start) return false;
  return true;
}

/** Total length of the union of [start, end) intervals. Input need not be sorted. */
export function unionLength(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = Number.NEGATIVE_INFINITY;
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const [a, b] of sorted) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) curEnd = b;
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/**
 * Self time of each span: its duration minus the union of its direct children's intervals (clipped
 * to the span). Keyed by span id.
 */
export function selfTimes(spans: SpanRecord[]): Map<string, number> {
  const children = new Map<string, Array<[number, number]>>();
  for (const s of spans) {
    if (!s.parentId || isMarker(s)) continue;
    let list = children.get(s.parentId);
    if (!list) children.set(s.parentId, (list = []));
    list.push([s.start, s.end]);
  }
  const out = new Map<string, number>();
  for (const s of spans) {
    const dur = Math.max(0, s.end - s.start);
    const kids = children.get(s.id);
    if (!kids) {
      out.set(s.id, dur);
      continue;
    }
    const clipped = kids.map(([a, b]): [number, number] => [Math.max(a, s.start), Math.min(b, s.end)]);
    out.set(s.id, Math.max(0, dur - unionLength(clipped)));
  }
  return out;
}

/**
 * Sweep the timeline [0, duration] and give every instant to the innermost span active at that
 * instant (latest start, then earliest end, then deepest parent chain). Buckets therefore sum to the
 * duration exactly, overlapping siblings are not double-counted, and spans whose parent link broke
 * across an un-instrumented async boundary still land in the right bucket.
 *
 * Time covered only by the request root (or nothing) inside the compile window goes to "compile":
 * Turbopack compiles a route between "load route module" and "prepare route module" without a span
 * of its own, so that gap would otherwise read as seconds of "idle". Only an uncovered stretch of at
 * least `COMPILE_GAP_MIN_MS` counts: a warm hit on a dynamic route leaves a 15-45ms hole between those
 * spans with no compile in it, and that stays "idle".
 */
/** Shortest uncovered stretch inside the compile window that is attributed to an untraced compile. */
export const COMPILE_GAP_MIN_MS = 50;

export function timeBudget(spans: SpanRecord[], duration: number): Record<TimeBucket, number> {
  return sweep(spans, duration).time;
}

/**
 * [start, end) of the dev compile phase: first compile span start to last compile span end, clipped
 * to where the user's code (handler / function) starts after it. A proxy (middleware) that ran
 * before the compile doesn't count. Undefined without compile spans.
 */
export function compileWindow(spans: SpanRecord[]): [number, number] | undefined {
  let a = Number.POSITIVE_INFINITY;
  let b = Number.NEGATIVE_INFINITY;
  for (const s of spans) {
    if (s.kind === "compile" && !isMarker(s)) {
      if (s.start < a) a = s.start;
      if (s.end > b) b = s.end;
    }
  }
  if (!(b > a)) return undefined;
  let code = Number.POSITIVE_INFINITY;
  for (const s of spans)
    if ((s.kind === "handler" || s.kind === "function" || s.kind === "proxy") && s.start >= a && s.start < code)
      code = s.start;
  if (code < b) b = code;
  return b > a ? [a, b] : undefined;
}

function sweep(spans: SpanRecord[], duration: number): { time: Record<TimeBucket, number>; gap: number } {
  const time = emptyTime();
  if (!(duration > 0)) return { time, gap: 0 };
  const timed = spans.filter((s) => !isMarker(s) && s.end > 0 && s.start < duration);
  if (timed.length === 0) {
    time.idle = duration;
    return { time, gap: 0 };
  }
  const win = compileWindow(timed);
  let gap = 0;
  // Parent-chain depth only breaks exact start+end ties, which are rare: compute it on demand.
  let depthMap: Map<string, number> | undefined;
  const depth = (id: string) => (depthMap ??= depths(timed)).get(id) ?? 0;
  type Ev = { at: number; open: boolean; s: SpanRecord };
  const events: Ev[] = [];
  for (const s of timed) {
    events.push({ at: Math.max(0, s.start), open: true, s });
    events.push({ at: Math.min(duration, s.end), open: false, s });
  }
  // Closes before opens at the same instant, so an abutting sibling doesn't overlap.
  events.sort((a, b) => a.at - b.at || (a.open === b.open ? 0 : a.open ? 1 : -1));

  const active: SpanRecord[] = [];
  let cursor = 0;
  const flush = (to: number) => {
    if (to <= cursor) return;
    const winner = innermost(active, depth);
    const bucket = winner ? bucketOf(winner) : "idle";
    const g = bucket === "idle" && win ? Math.max(0, Math.min(to, win[1]) - Math.max(cursor, win[0])) : 0;
    if (g >= COMPILE_GAP_MIN_MS) {
      gap += g;
      time.compile += g;
      time.idle += to - cursor - g;
    } else time[bucket] += to - cursor;
    cursor = to;
  };
  for (const ev of events) {
    flush(ev.at);
    if (ev.open) active.push(ev.s);
    else {
      const i = active.indexOf(ev.s);
      if (i >= 0) active.splice(i, 1);
    }
  }
  flush(duration);
  return { time, gap };
}

function innermost(active: SpanRecord[], depth: (id: string) => number): SpanRecord | undefined {
  let best: SpanRecord | undefined;
  for (const s of active) {
    if (
      !best ||
      s.start > best.start ||
      (s.start === best.start && (s.end < best.end || (s.end === best.end && depth(s.id) > depth(best.id))))
    )
      best = s;
  }
  return best;
}

/** Depth through the parentId chain (0 for roots and orphans). */
export function depths(spans: SpanRecord[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const out = new Map<string, number>();
  const visit = (s: SpanRecord, guard: number): number => {
    const known = out.get(s.id);
    if (known !== undefined) return known;
    const parent = s.parentId ? byId.get(s.parentId) : undefined;
    const d = parent && guard < 256 ? visit(parent, guard + 1) + 1 : 0;
    out.set(s.id, d);
    return d;
  };
  for (const s of spans) visit(s, 0);
  return out;
}

function emptyTime(): Record<TimeBucket, number> {
  return { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 };
}

const round = (n: number) => Math.round(n * 100) / 100;

export function computeFacts(t: TraceRecord, input: FactsInput = {}): TraceFacts {
  const { spans, truncated } = cappedSpans(t);
  const duration = t.duration ?? Math.max(0, ...spans.map((s) => s.end));
  const { time, gap } = sweep(spans, duration);
  for (const k of TIME_BUCKETS) time[k] = round(time[k]);

  const counts = { spans: t.spans.length, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 };
  const compile: Array<[number, number]> = [];
  for (const s of spans) {
    if (s.kind === "db") {
      if (isRedis(s)) counts.cache++;
      else counts.db++;
    } else if (s.kind === "fetch") counts.fetch++;
    else if (s.kind === "function") counts.fn++;
    else if (s.kind === "compile" && !isMarker(s)) compile.push([s.start, s.end]);
  }
  for (const l of t.logs) {
    if (l.level === "warn") counts.warn++;
    else if (l.level === "error") counts.error++;
  }

  const facts: TraceFacts = {
    time,
    reqBytes: input.reqBytes ?? t.request.body?.size ?? 0,
    resBytes: input.resBytes ?? t.response.body?.size ?? 0,
    counts,
    cold: input.cold ?? false,
    // Compile spans plus the uncovered gap between them (Turbopack's untraced on-demand compile).
    compileMs: round(unionLength(compile) + gap),
    droppedSpans: input.droppedSpans ?? 0,
    epoch: input.epoch ?? 0,
  };
  if (input.ttfb !== undefined) facts.ttfb = round(input.ttfb);
  if (truncated) facts.truncated = true;
  return facts;
}

/* ------------------------------------------------------- nested fetch fold */

/**
 * Next wraps `fetch` (AppRender.fetch, `http.url`) and so does Hoplens (`url.full`), so one outgoing
 * call shows up as a fetch span with a fetch child for the same method + url. Fold each such pair
 * into the outer span (keeps Next's timing, takes Hoplens's name, attrs, location and error) so
 * counts, rules and the waterfall see one logical call. Returns the kept spans; mutates in place.
 */
export function foldNestedFetches(spans: SpanRecord[]): SpanRecord[] {
  let byId: Map<string, SpanRecord> | undefined;
  const drop = new Map<string, string>(); // child id -> kept parent id
  for (const s of spans) {
    if (s.kind !== "fetch" || !s.parentId) continue;
    byId ??= new Map(spans.map((x) => [x.id, x]));
    const p = byId.get(s.parentId);
    if (!p || p.kind !== "fetch" || drop.has(p.id)) continue;
    if (fetchMethod(p) !== fetchMethod(s)) continue;
    const pu = fetchUrl(p);
    const su = fetchUrl(s);
    if (!pu || !su || (pu !== su && normalizeUrl(pu) !== normalizeUrl(su))) continue;
    p.name = s.name;
    p.attrs = { ...p.attrs, ...s.attrs };
    if (s.location) p.location = s.location;
    if (s.error && !p.error) p.error = s.error;
    if (s.args !== undefined && p.args === undefined) p.args = s.args;
    if (s.result !== undefined && p.result === undefined) p.result = s.result;
    drop.set(s.id, p.id);
  }
  if (drop.size === 0) return spans;
  const out: SpanRecord[] = [];
  for (const s of spans) {
    if (drop.has(s.id)) continue;
    if (s.parentId && drop.has(s.parentId)) s.parentId = drop.get(s.parentId);
    out.push(s);
  }
  return out;
}

function fetchUrl(s: SpanRecord): string | undefined {
  const v = s.attrs["url.full"] ?? s.attrs["http.url"];
  return v === undefined ? undefined : String(v);
}

function fetchMethod(s: SpanRecord): string {
  return String(s.attrs["http.method"] ?? s.attrs["http.request.method"] ?? "GET").toUpperCase();
}

/* ------------------------------------------------------------ normalizers */

const MAX_SQL = 4096;

/**
 * SQL fingerprint: string literals, numbers and `$n` / `?` placeholders become `?`, `IN (...)` lists
 * collapse to `IN (?)`, whitespace collapses. Input is capped at 4k chars first so a huge statement
 * can't blow up the regex work.
 */
export function normalizeSql(sql: string): string {
  return memo(sqlCache, sql, normalizeSqlUncached);
}

// One pass for every literal kind: quoted strings, $n placeholders, numbers (not inside identifiers
// like `table2` or `"col1"`), booleans.
const SQL_LITERALS = /'(?:[^']|'')*'|\$\d+|(?<![\w$."])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false)\b/gi;
const SQL_IN_LIST = /\bIN \( ?\?(?: ?, ?\?)* ?\)/gi;
const SQL_ROWS = /(\( ?\?(?: ?, ?\?)* ?\))(?: ?, ?\( ?\?(?: ?, ?\?)* ?\))+/g;

function normalizeSqlUncached(sql: string): string {
  let s = sql.length > MAX_SQL ? sql.slice(0, MAX_SQL) : sql;
  s = s.replace(SQL_LITERALS, "?").replace(/\s+/g, " ").trim();
  if (s.includes("(")) {
    s = s.replace(SQL_IN_LIST, "IN (?)");
    // Multi-row VALUES (?, ?), (?, ?) → VALUES (?, ?)
    s = s.replace(SQL_ROWS, "$1");
  }
  return s;
}

// Dev apps issue the same handful of statements and urls over and over; a small bounded cache
// keeps normalization off the analysis budget.
const sqlCache = new Map<string, string>();
const urlCache = new Map<string, string>();
const MEMO_MAX = 1000;

function memo(cache: Map<string, string>, key: string, fn: (k: string) => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const v = fn(key);
  if (cache.size >= MEMO_MAX) cache.clear();
  cache.set(key, v);
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXID = /^[0-9a-f]{16,}$/i;

/** True for path segments that look like ids: integers, UUIDs, long hex (ObjectId, hashes). */
export function isIdSegment(seg: string): boolean {
  return /^\d+$/.test(seg) || UUID.test(seg) || HEXID.test(seg);
}

/**
 * URL fingerprint: host + path, id-like segments become `:id`, query values are dropped (keys kept in
 * order). Relative URLs keep no host.
 */
export function normalizeUrl(url: string): string {
  return memo(urlCache, url, normalizeUrlUncached);
}

function normalizeUrlUncached(url: string): string {
  // Hand-rolled split instead of `new URL()`: this runs for every fetch span and URL parsing
  // dominated the analysis budget.
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(url);
  let host = "";
  let pathname: string;
  let search: string;
  if (m) {
    host = (m[1] ?? "").replace(/^[^@]*@/, "").toLowerCase();
    pathname = m[2] || "/";
    search = m[3] ?? "";
  } else {
    const hashAt = url.indexOf("#");
    const clean = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const q = clean.indexOf("?");
    pathname = q >= 0 ? clean.slice(0, q) : clean;
    search = q >= 0 ? clean.slice(q) : "";
  }
  const path = pathname
    .split("/")
    .map((seg) => (seg && isIdSegment(seg) ? ":id" : seg))
    .join("/");
  let query = "";
  if (search.length > 1) {
    const keys = search
      .slice(1)
      .split("&")
      .filter(Boolean)
      .map((kv) => kv.split("=")[0]);
    if (keys.length) query = `?${keys.join("&")}`;
  }
  return `${host}${path}${query}`;
}
