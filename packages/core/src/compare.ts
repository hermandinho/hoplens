// Trace compare (plan 3.4 / WP8): match the spans of two traces, fold same-shape siblings into
// groups (x1 -> x50), and diff time buckets, counts, findings, headers and bodies. Pure: runs on the
// UI server for one GET /api/compare, never on the app's request path.

import { TIME_BUCKETS, bucketOf, cappedSpans, computeFacts, normalizeUrl, unionLength } from "./facts";
import { dur, labelOf, shapeOf } from "./insights/context";
import { DEFAULT_REDACT } from "./options";
import { REGRESSION_RULE } from "./regressions";
import { type Redactor, makeRedactor } from "./serialize";
import { urlVariantKey } from "./stats";
import type {
  BodyCapture,
  Finding,
  FindingSummary,
  HopKind,
  SourceLocation,
  SpanRecord,
  TimeBucket,
  TraceFacts,
  TraceRecord,
} from "./types";

/* ------------------------------------------------------------------ types */

export interface CompareSide {
  id: string;
  method: string;
  url: string;
  path: string;
  route?: string;
  status?: number;
  duration: number;
  startedAt: number;
  done: boolean;
  epoch?: number;
  cold?: boolean;
  ttfb?: number;
  reqBytes?: number;
  resBytes?: number;
  error?: string;
}

export interface BucketDelta {
  bucket: TimeBucket;
  a: number;
  b: number;
  /** b - a, ms. */
  delta: number;
}

export type CountName = keyof TraceFacts["counts"];

export interface CountDelta {
  name: CountName;
  a: number;
  b: number;
  delta: number;
}

export type RowStatus = "same" | "changed" | "onlyA" | "onlyB";

export interface CompareGroupSide {
  /** Spans folded into this row (x50). */
  count: number;
  /** Union of the members' intervals, ms: what the row cost in wall time. */
  wallMs: number;
  /** Sum of the members' durations, ms. */
  totalMs: number;
  /** Member span ids, start order, capped at MAX_ROW_IDS. */
  spanIds: string[];
  /** First start among members, ms since trace start. */
  start: number;
  location?: SourceLocation;
  errors: number;
}

/**
 * One row of the merged diff: all spans of one shape under one matched parent path, folded. Rows come
 * depth-first, siblings in start order (B's start when the row exists in B, else A's).
 */
export interface CompareRow {
  /** `kind|identity|parentPath`. Stable across traces of the same route. */
  key: string;
  parentKey?: string;
  depth: number;
  kind: HopKind;
  label: string;
  bucket: TimeBucket;
  a?: CompareGroupSide;
  b?: CompareGroupSide;
  /** b.wallMs - a.wallMs (a missing side counts as 0). */
  deltaMs: number;
  /** b.count - a.count. */
  countDelta: number;
  status: RowStatus;
}

/** One span-level match: `key` = row key + `|` + occurrence index within the row. */
export interface SpanPair {
  key: string;
  a?: string;
  b?: string;
  /** dur(b) - dur(a), only when both exist. */
  deltaMs?: number;
}

export type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean" | "undefined";

/**
 * One JSON diff operation. `path` is a JSON pointer. Array paths name the index on the side the
 * value lives on: `remove` uses A's index, every other op B's.
 */
export interface JsonDiffOp {
  op: "add" | "remove" | "replace" | "type";
  path: string;
  a?: unknown;
  b?: unknown;
  /** Only on `type`: the JSON types on each side. */
  aType?: JsonType;
  bType?: JsonType;
}

export interface BodyDiff {
  /** json: both JSON; text: both text; binary: either binary; mixed: different capture kinds; none: neither captured. */
  mode: "json" | "text" | "binary" | "mixed" | "none";
  same: boolean;
  ops: JsonDiffOp[];
  /** More than MAX_DIFF_OPS differences: the rest were dropped. */
  truncated: boolean;
  /** Either capture was cut short at capture time, so the diff may miss differences. */
  partial: boolean;
  aSize?: number;
  bSize?: number;
}

export interface HeaderDiffOp {
  op: "add" | "remove" | "replace";
  /** Lower-cased header name. */
  name: string;
  a?: string;
  b?: string;
}

export interface HeadersDiff {
  same: boolean;
  ops: HeaderDiffOp[];
}

export interface FindingChange {
  fingerprint: string;
  rule: Finding["rule"];
  title: string;
  a?: number;
  b?: number;
}

export interface FindingsDiff {
  /** In B, not in A. */
  added: FindingSummary[];
  /** In A, gone in B. */
  resolved: FindingSummary[];
  /** In both, with a different count (e.g. x10 -> x50). */
  changed: FindingChange[];
  /** In both, unchanged. */
  kept: number;
}

export interface CompareSummary {
  /** b.duration - a.duration, ms. */
  deltaMs: number;
  /** Relative to A, percent; undefined when A took 0ms. */
  deltaPct?: number;
  /** "same" within the regression rule's noise floor, max(20% of A, 5ms), as the UI's tones (see summaryDirection). */
  direction: "slower" | "faster" | "same";
  /** Bucket with the largest change (same sign as the total when there is one). */
  largestBucket?: BucketDelta;
  /** Row key of the largest change inside that bucket, when one stands out. */
  driverKey?: string;
  /** e.g. "B is 55ms slower (+134%): db +52ms, pg.query SELECT * FROM products x1 -> x50; new: N+1 (store.ts:88)". */
  sentence: string;
}

export interface CompareResult {
  a: CompareSide;
  b: CompareSide;
  /** Same method + route template (or normalized path): the diff of rows is meaningful. */
  sameRoute: boolean;
  summary: CompareSummary;
  buckets: BucketDelta[];
  counts: CountDelta[];
  rows: CompareRow[];
  /** More than MAX_ROWS rows: the rest were dropped (counts in `spans` stay exact). */
  rowsTruncated: boolean;
  pairs: SpanPair[];
  pairsTruncated: boolean;
  spans: { matched: number; onlyA: number; onlyB: number; truncated: boolean };
  findings: FindingsDiff;
  request: { headers: HeadersDiff; body: BodyDiff };
  response: { status: { a?: number; b?: number }; headers: HeadersDiff; body: BodyDiff };
}

/* ----------------------------------------------------------------- limits */

export const MAX_ROWS = 1000;
export const MAX_PAIRS = 2000;
export const MAX_ROW_IDS = 100;
export const MAX_DIFF_OPS = 200;
const MAX_DEPTH = 64;
/** Arrays longer than this are diffed index by index instead of aligned (LCS is O(n*m)). */
const MAX_LCS_ITEMS = 200;
const MAX_TEXT_SNIPPET = 200;
/** A row is "same" when its wall time moved by less than 1ms or less than 10%. */
const SAME_MS = 1;
const SAME_RATIO = 0.1;
/** Headers that differ on every request and carry no signal. */
const VOLATILE_HEADERS = new Set(["date", "age", "x-request-id", "x-vercel-id"]);

const defaultRedactor = makeRedactor([...DEFAULT_REDACT]);

/* --------------------------------------------------------------- compare */

export interface CompareOptions {
  /** The runtime's redactor; header/body keys it hits are compared but never echoed. */
  redactor?: Redactor;
}

/**
 * Diff trace `b` (subject) against `a` (baseline).
 *
 * ```ts
 * const r = compareTraces(store.get(a)!, store.get(b)!, { redactor: rt.redactor });
 * r.summary.sentence; // "B is 55ms slower (+134%): db +52ms, pg.query ... x1 -> x50"
 * ```
 */
export function compareTraces(a: TraceRecord, b: TraceRecord, opts: CompareOptions = {}): CompareResult {
  const redactor = opts.redactor ?? defaultRedactor;
  const fa = factsOf(a);
  const fb = factsOf(b);

  const ca = cappedSpans(a);
  const cb = cappedSpans(b);
  const tree = matchTrees(ca.spans, cb.spans);
  const spansTruncated = ca.truncated || cb.truncated;

  const buckets: BucketDelta[] = TIME_BUCKETS.map((bucket) => {
    const x = round(fa.time[bucket] ?? 0);
    const y = round(fb.time[bucket] ?? 0);
    return { bucket, a: x, b: y, delta: round(y - x) };
  });
  const counts: CountDelta[] = (Object.keys(fb.counts) as CountName[]).map((name) => {
    const x = fa.counts[name] ?? 0;
    const y = fb.counts[name] ?? 0;
    return { name, a: x, b: y, delta: y - x };
  });

  const findings = diffFindings(a.findings ?? [], b.findings ?? []);
  const sa = side(a, fa);
  const sb = side(b, fb);
  const summary = summarize(sa, sb, buckets, tree.rows, findings);

  return {
    a: sa,
    b: sb,
    sameRoute: routeKeyOf(a) === routeKeyOf(b),
    summary,
    buckets,
    counts,
    rows: tree.rows,
    rowsTruncated: tree.rowsTruncated,
    pairs: tree.pairs,
    pairsTruncated: tree.pairsTruncated,
    spans: { matched: tree.matched, onlyA: tree.onlyA, onlyB: tree.onlyB, truncated: spansTruncated },
    findings,
    request: {
      headers: diffHeaders(a.request.headers, b.request.headers, redactor),
      body: diffBodies(a.request.body, b.request.body, redactor),
    },
    response: {
      status: { a: a.status, b: b.status },
      headers: diffHeaders(a.response.headers, b.response.headers, redactor),
      body: diffBodies(a.response.body, b.response.body, redactor),
    },
  };
}

/** `GET /api/products`: route template when known, else the normalized path. Same key as the insights. */
export function routeKeyOf(t: TraceRecord): string {
  return `${t.method} ${t.route ?? normalizeUrl(t.path)}`;
}

function factsOf(t: TraceRecord): TraceFacts {
  if (t.facts) return t.facts;
  try {
    return computeFacts(t);
  } catch {
    const time = Object.fromEntries(TIME_BUCKETS.map((k) => [k, 0])) as Record<TimeBucket, number>;
    return {
      time,
      reqBytes: 0,
      resBytes: 0,
      counts: { spans: t.spans.length, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 },
      cold: false,
      compileMs: 0,
      droppedSpans: 0,
      epoch: 0,
    };
  }
}

function side(t: TraceRecord, f: TraceFacts): CompareSide {
  const out: CompareSide = {
    id: t.id,
    method: t.method,
    url: t.url,
    path: t.path,
    duration: round(t.duration ?? 0),
    startedAt: t.startedAt,
    done: t.done,
    epoch: f.epoch,
    cold: f.cold,
    reqBytes: f.reqBytes,
    resBytes: f.resBytes,
  };
  if (t.route !== undefined) out.route = t.route;
  if (t.status !== undefined) out.status = t.status;
  if (f.ttfb !== undefined) out.ttfb = round(f.ttfb);
  if (t.error) out.error = t.error.message;
  return out;
}

/* ---------------------------------------------------------- span matching */

/**
 * What a span "is", independent of when it ran: the query/url shape for I/O, else its name with any
 * url-like token normalized (ids -> :id, query values dropped). The request root has none, so the two
 * roots always match.
 */
export function identityOf(s: SpanRecord): string {
  if (s.kind === "request") return "";
  const shape = shapeOf(s);
  if (shape) return shape;
  return s.name.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s]*/gi, (m) => normalizeUrl(m));
}

interface Tree {
  roots: SpanRecord[];
  children: Map<string, SpanRecord[]>;
}

function treeOf(spans: SpanRecord[]): Tree {
  const ids = new Set(spans.map((s) => s.id));
  const roots: SpanRecord[] = [];
  const children = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    // A broken parent link (parent past the cap, or never recorded) makes the span a root.
    if (!s.parentId || !ids.has(s.parentId) || s.parentId === s.id) {
      roots.push(s);
      continue;
    }
    let list = children.get(s.parentId);
    if (!list) children.set(s.parentId, (list = []));
    list.push(s);
  }
  return { roots, children };
}

interface MatchResult {
  rows: CompareRow[];
  rowsTruncated: boolean;
  pairs: SpanPair[];
  pairsTruncated: boolean;
  matched: number;
  onlyA: number;
  onlyB: number;
}

/**
 * Walk both trees level by level. Under each matched parent path, children are grouped by
 * `kind|identity`; a group present on one side only becomes an only-A / only-B row, with its whole
 * subtree. Inside a group the n-th span (start order) of A pairs with the n-th of B, so reordered
 * siblings of different shapes still match and x1 vs x50 pairs one span and leaves 49 only-in-B.
 * The children of every member of a group are pooled for the next level, so 12 `getProductRating`
 * calls with one query each fold into `getProductRating x12 > pg.query x12`.
 */
export function matchTrees(aSpans: SpanRecord[], bSpans: SpanRecord[]): MatchResult {
  const ta = treeOf(aSpans);
  const tb = treeOf(bSpans);
  const out: MatchResult = {
    rows: [],
    rowsTruncated: false,
    pairs: [],
    pairsTruncated: false,
    matched: 0,
    onlyA: 0,
    onlyB: 0,
  };

  const level = (
    as: SpanRecord[],
    bs: SpanRecord[],
    parentPath: string,
    parentKey: string | undefined,
    depth: number,
  ) => {
    const groups = new Map<string, { a: SpanRecord[]; b: SpanRecord[] }>();
    const put = (s: SpanRecord, which: "a" | "b") => {
      const id = `${s.kind}|${identityOf(s)}`;
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { a: [], b: [] }));
      g[which].push(s);
    };
    for (const s of as) put(s, "a");
    for (const s of bs) put(s, "b");

    const ordered = Array.from(groups.entries())
      .map(([id, g]) => {
        g.a.sort(byStart);
        g.b.sort(byStart);
        const first = g.b[0] ?? g.a[0]!;
        return { id, g, at: first.start };
      })
      .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    for (const { id, g } of ordered) {
      const key = parentPath ? `${id}|${parentPath}` : `${id}|`;
      const n = Math.max(g.a.length, g.b.length);
      for (let i = 0; i < n; i++) {
        const sa = g.a[i];
        const sb = g.b[i];
        if (sa && sb) out.matched++;
        else if (sa) out.onlyA++;
        else out.onlyB++;
        if (out.pairs.length >= MAX_PAIRS) {
          out.pairsTruncated = true;
          continue;
        }
        const pair: SpanPair = { key: `${key}|${i}` };
        if (sa) pair.a = sa.id;
        if (sb) pair.b = sb.id;
        if (sa && sb) pair.deltaMs = round(dur(sb) - dur(sa));
        out.pairs.push(pair);
      }

      if (out.rows.length < MAX_ROWS) out.rows.push(makeRow(key, parentKey, depth, g.a, g.b));
      else out.rowsTruncated = true;

      if (depth + 1 >= MAX_DEPTH) continue;
      const kidsA = g.a.flatMap((s) => ta.children.get(s.id) ?? []);
      const kidsB = g.b.flatMap((s) => tb.children.get(s.id) ?? []);
      if (kidsA.length || kidsB.length) {
        level(kidsA, kidsB, parentPath ? `${parentPath}>${id}` : id, key, depth + 1);
      }
    }
  };

  level(ta.roots, tb.roots, "", undefined, 0);
  return out;
}

function makeRow(
  key: string,
  parentKey: string | undefined,
  depth: number,
  as: SpanRecord[],
  bs: SpanRecord[],
): CompareRow {
  const first = bs[0] ?? as[0]!;
  const a = as.length ? groupSide(as) : undefined;
  const b = bs.length ? groupSide(bs) : undefined;
  const deltaMs = round((b?.wallMs ?? 0) - (a?.wallMs ?? 0));
  const countDelta = bs.length - as.length;
  let status: RowStatus;
  if (!a) status = "onlyB";
  else if (!b) status = "onlyA";
  else {
    const big = Math.max(a.wallMs, b.wallMs);
    const same = countDelta === 0 && (Math.abs(deltaMs) < SAME_MS || Math.abs(deltaMs) < big * SAME_RATIO);
    status = same ? "same" : "changed";
  }
  const row: CompareRow = {
    key,
    depth,
    kind: first.kind,
    label: first.kind === "db" || first.kind === "fetch" ? labelOf(first, 80) : first.name,
    bucket: bucketOf(first),
    deltaMs,
    countDelta,
    status,
  };
  if (parentKey !== undefined) row.parentKey = parentKey;
  if (a) row.a = a;
  if (b) row.b = b;
  return row;
}

function groupSide(spans: SpanRecord[]): CompareGroupSide {
  let total = 0;
  let errors = 0;
  const intervals: Array<[number, number]> = [];
  for (const s of spans) {
    total += dur(s);
    intervals.push([s.start, s.end]);
    if (s.error) errors++;
  }
  const out: CompareGroupSide = {
    count: spans.length,
    wallMs: round(unionLength(intervals)),
    totalMs: round(total),
    spanIds: spans.slice(0, MAX_ROW_IDS).map((s) => s.id),
    start: round(spans[0]!.start),
    errors,
  };
  const loc = spans.find((s) => s.location?.file)?.location;
  if (loc) out.location = loc;
  return out;
}

const byStart = (x: SpanRecord, y: SpanRecord) => x.start - y.start || x.end - y.end;

/* --------------------------------------------------------------- findings */

function summaryOf(f: Finding): FindingSummary {
  const out: FindingSummary = { rule: f.rule, severity: f.severity, title: f.title, fingerprint: f.fingerprint };
  if (f.fn !== undefined) out.fn = f.fn;
  if (f.location !== undefined) out.location = f.location;
  if (f.count !== undefined) out.count = f.count;
  if (f.estSavedMs !== undefined) out.estSavedMs = f.estSavedMs;
  return out;
}

export function diffFindings(a: readonly Finding[], b: readonly Finding[]): FindingsDiff {
  const inA = new Map(a.map((f) => [f.fingerprint, f]));
  const inB = new Map(b.map((f) => [f.fingerprint, f]));
  const out: FindingsDiff = { added: [], resolved: [], changed: [], kept: 0 };
  for (const [fp, f] of inB) {
    const old = inA.get(fp);
    if (!old) out.added.push(summaryOf(f));
    else if ((old.count ?? 1) !== (f.count ?? 1)) {
      out.changed.push({ fingerprint: fp, rule: f.rule, title: f.title, a: old.count, b: f.count });
    } else out.kept++;
  }
  for (const [fp, f] of inA) if (!inB.has(fp)) out.resolved.push(summaryOf(f));
  return out;
}

/* ---------------------------------------------------------------- summary */

const BUCKET_LABEL: Record<TimeBucket, string> = {
  db: "db",
  cache: "cache",
  ext: "external",
  fn: "your code",
  framework: "framework",
  compile: "compile",
  idle: "wait",
};

/**
 * The whole request's direction, B against A: "same" unless it moved by at least max(20% of A, 5ms),
 * the regression rule's floor, which the UI also uses for its diff tones (state/compare.ts isSame),
 * so the sentence and the colors agree. Rows keep their finer 1ms / 10% status. Pure; exported for tests.
 */
export function summaryDirection(aMs: number, bMs: number): CompareSummary["direction"] {
  const d = Math.abs(bMs - aMs);
  if (d < REGRESSION_RULE.minMs || d < REGRESSION_RULE.minPct * Math.max(0, aMs)) return "same";
  return bMs > aMs ? "slower" : "faster";
}

function summarize(
  a: CompareSide,
  b: CompareSide,
  buckets: BucketDelta[],
  rows: CompareRow[],
  findings: FindingsDiff,
): CompareSummary {
  const deltaMs = round(b.duration - a.duration);
  const deltaPct = a.duration > 0 ? Math.round((deltaMs / a.duration) * 100) : undefined;
  const direction = summaryDirection(a.duration, b.duration);
  const sign = Math.sign(deltaMs);

  // Largest bucket move, preferring one that moved the same way as the total.
  const moved = buckets.filter((x) => Math.abs(x.delta) >= SAME_MS);
  const pool = direction === "same" ? moved : moved.filter((x) => Math.sign(x.delta) === sign);
  const largestBucket = (pool.length ? pool : moved).reduce<BucketDelta | undefined>(
    (best, x) => (!best || Math.abs(x.delta) > Math.abs(best.delta) ? x : best),
    undefined,
  );

  // The row that drove it: biggest wall-time move in that bucket; a count change wins ties.
  let driver: CompareRow | undefined;
  if (largestBucket) {
    for (const r of rows) {
      if (r.bucket !== largestBucket.bucket || r.status === "same") continue;
      if (Math.sign(r.deltaMs) !== Math.sign(largestBucket.delta) && r.countDelta === 0) continue;
      if (
        !driver ||
        Math.abs(r.deltaMs) > Math.abs(driver.deltaMs) ||
        (Math.abs(r.deltaMs) === Math.abs(driver.deltaMs) && r.countDelta !== 0 && driver.countDelta === 0)
      )
        driver = r;
    }
  }

  const head =
    direction === "same"
      ? `B takes about the same time (${fmtSigned(deltaMs)}ms, within noise)`
      : `B is ${fmtMs(Math.abs(deltaMs))}ms ${direction}${deltaPct !== undefined ? ` (${deltaPct > 0 ? "+" : ""}${deltaPct}%)` : ""}`;
  // "About the same" is within noise: listing its deltas as causes would contradict it.
  const reasons: string[] = [];
  if (largestBucket && direction !== "same")
    reasons.push(`${BUCKET_LABEL[largestBucket.bucket]} ${fmtSigned(largestBucket.delta)}ms`);
  if (driver && direction !== "same") reasons.push(rowPhrase(driver));
  const finding =
    direction === "faster"
      ? findings.resolved[0] && `fixed: ${findingPhrase(findings.resolved[0])}`
      : findings.added[0] && `new: ${findingPhrase(findings.added[0])}`;
  let sentence = head;
  if (reasons.length) sentence += `: ${reasons.join(", ")}`;
  if (finding) sentence += `; ${finding}`;
  sentence += ".";

  const out: CompareSummary = { deltaMs, direction, sentence };
  if (deltaPct !== undefined) out.deltaPct = deltaPct;
  if (largestBucket) out.largestBucket = largestBucket;
  if (driver) out.driverKey = driver.key;
  return out;
}

function rowPhrase(r: CompareRow): string {
  const label = r.label.length > 60 ? `${r.label.slice(0, 59)}…` : r.label;
  if (r.status === "onlyB") return `${label} only in B${r.b && r.b.count > 1 ? ` (x${r.b.count})` : ""}`;
  if (r.status === "onlyA") return `${label} only in A${r.a && r.a.count > 1 ? ` (x${r.a.count})` : ""}`;
  if (r.countDelta !== 0) return `${label} x${r.a?.count ?? 0} -> x${r.b?.count ?? 0}`;
  return `${label} ${fmtSigned(r.deltaMs)}ms`;
}

function findingPhrase(f: FindingSummary): string {
  if (!f.location) return f.title;
  const base = f.location.file.split("/").pop() ?? f.location.file;
  return `${f.title} (${base}:${f.location.line})`;
}

const fmtMs = (n: number) => (Math.abs(n) >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
const fmtSigned = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${fmtMs(Math.abs(n))}`;
const round = (n: number) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------- headers */

export function diffHeaders(
  a: Record<string, string>,
  b: Record<string, string>,
  redactor: Redactor = defaultRedactor,
): HeadersDiff {
  const la = lowerKeys(a);
  const lb = lowerKeys(b);
  const ops: HeaderDiffOp[] = [];
  const names = Array.from(new Set([...la.keys(), ...lb.keys()])).sort();
  for (const name of names) {
    if (VOLATILE_HEADERS.has(name) || name.startsWith("x-hoplens-")) continue;
    const x = la.get(name);
    const y = lb.get(name);
    if (x === y) continue;
    const secret = redactor.hit(name);
    const show = (v: string | undefined) => (v === undefined ? undefined : secret ? "[redacted]" : v);
    const op: HeaderDiffOp =
      x === undefined ? { op: "add", name } : y === undefined ? { op: "remove", name } : { op: "replace", name };
    const sx = show(x);
    const sy = show(y);
    if (sx !== undefined) op.a = sx;
    if (sy !== undefined) op.b = sy;
    ops.push(op);
  }
  return { same: ops.length === 0, ops };
}

function lowerKeys(h: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(h ?? {})) m.set(k.toLowerCase(), String(v));
  return m;
}

/* ------------------------------------------------------------------ bodies */

export function diffBodies(
  a: BodyCapture | undefined,
  b: BodyCapture | undefined,
  redactor: Redactor = defaultRedactor,
): BodyDiff {
  const base = {
    truncated: false,
    partial: !!(a?.truncated || b?.truncated),
  };
  const sizes: Pick<BodyDiff, "aSize" | "bSize"> = {};
  if (a) sizes.aSize = a.size;
  if (b) sizes.bSize = b.size;
  const ka = bodyKind(a);
  const kb = bodyKind(b);

  if (ka === "none" && kb === "none") return { mode: "none", same: true, ops: [], ...base, ...sizes };
  if (ka === "binary" || kb === "binary") {
    const same = ka === kb && a?.size === b?.size && a?.contentType === b?.contentType;
    return { mode: "binary", same, ops: [], ...base, ...sizes };
  }
  if (ka === "json" && kb === "json") {
    const d = diffJson(a!.json, b!.json, { redactor });
    return { mode: "json", same: d.ops.length === 0, ops: d.ops, ...base, truncated: d.truncated, ...sizes };
  }
  if (ka === "text" && kb === "text") {
    const same = a!.text === b!.text;
    const ops: JsonDiffOp[] = same ? [] : [{ op: "replace", path: "", a: snippet(a!.text!), b: snippet(b!.text!) }];
    return { mode: "text", same, ops, ...base, ...sizes };
  }
  // Different capture kinds (JSON vs text, or a body on one side only).
  const op: JsonDiffOp =
    ka === "none"
      ? { op: "add", path: "", b: bodyValue(b!) }
      : kb === "none"
        ? { op: "remove", path: "", a: bodyValue(a!) }
        : { op: "type", path: "", a: bodyValue(a!), b: bodyValue(b!), aType: kindType(ka), bType: kindType(kb) };
  return { mode: "mixed", same: false, ops: [op], ...base, ...sizes };
}

type BodyKind = "none" | "json" | "text" | "binary";

function bodyKind(c: BodyCapture | undefined): BodyKind {
  if (!c) return "none";
  if (c.binary) return "binary";
  if (c.json !== undefined) return "json";
  if (c.text !== undefined) return "text";
  return "none";
}

function bodyValue(c: BodyCapture): unknown {
  return c.json !== undefined ? c.json : c.text !== undefined ? snippet(c.text) : undefined;
}

function kindType(k: BodyKind): JsonType {
  return k === "json" ? "object" : k === "text" ? "string" : "undefined";
}

function snippet(s: string): string {
  return s.length > MAX_TEXT_SNIPPET ? `${s.slice(0, MAX_TEXT_SNIPPET)}… (+${s.length - MAX_TEXT_SNIPPET} chars)` : s;
}

/* -------------------------------------------------------------- JSON diff */

export function jsonType(v: unknown): JsonType {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t;
  return "string";
}

export interface JsonDiffOptions {
  /** Default MAX_DIFF_OPS. */
  maxOps?: number;
  /** Keys this redactor hits are compared but their values are never returned. */
  redactor?: Redactor;
}

/**
 * Structural diff of two JSON values. Objects diff by key (A's key order, then keys new in B).
 * Arrays are aligned on equal items (LCS), so an insertion is one `add`, not a cascade of replaces;
 * items left between two aligned anchors pair up in order and diff recursively. A change of JSON type
 * (object -> array, number -> string, value -> null) is one `type` op. Stops after `maxOps` ops.
 */
export function diffJson(
  a: unknown,
  b: unknown,
  opts: JsonDiffOptions = {},
): { ops: JsonDiffOp[]; truncated: boolean } {
  const max = opts.maxOps ?? MAX_DIFF_OPS;
  const redactor = opts.redactor ?? defaultRedactor;
  const ops: JsonDiffOp[] = [];
  let truncated = false;
  const push = (op: JsonDiffOp): boolean => {
    if (ops.length >= max) {
      truncated = true;
      return false;
    }
    ops.push(op);
    return true;
  };

  const walk = (x: unknown, y: unknown, path: string, secret: boolean): boolean => {
    if (truncated) return false;
    const tx = jsonType(x);
    const ty = jsonType(y);
    if (secret) {
      if (tx === ty && equal(x, y)) return true;
      return push({ op: "replace", path, a: "[redacted]", b: "[redacted]" });
    }
    if (tx !== ty) return push({ op: "type", path, a: x, b: y, aType: tx, bType: ty });
    if (tx === "object") {
      const ox = x as Record<string, unknown>;
      const oy = y as Record<string, unknown>;
      for (const k of Object.keys(ox)) {
        const p = `${path}/${escapePointer(k)}`;
        const hit = redactor.hit(k);
        if (!Object.hasOwn(oy, k)) {
          if (!push({ op: "remove", path: p, a: hit ? "[redacted]" : ox[k] })) return false;
        } else if (!walk(ox[k], oy[k], p, hit)) return false;
      }
      for (const k of Object.keys(oy)) {
        if (Object.hasOwn(ox, k)) continue;
        const p = `${path}/${escapePointer(k)}`;
        if (!push({ op: "add", path: p, b: redactor.hit(k) ? "[redacted]" : oy[k] })) return false;
      }
      return true;
    }
    if (tx === "array") return walkArray(x as unknown[], y as unknown[], path);
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return push({ op: "replace", path, a: x, b: y });
    return true;
  };

  const walkArray = (xs: unknown[], ys: unknown[], path: string): boolean => {
    const anchors = xs.length <= MAX_LCS_ITEMS && ys.length <= MAX_LCS_ITEMS ? lcs(xs, ys) : indexAnchors(xs, ys);
    let i = 0;
    let j = 0;
    const gap = (ie: number, je: number): boolean => {
      // Pair leftovers in order (modified items), then the rest are removes / adds.
      while (i < ie && j < je) {
        if (!walk(xs[i], ys[j], `${path}/${j}`, false)) return false;
        i++;
        j++;
      }
      while (i < ie) {
        if (!push({ op: "remove", path: `${path}/${i}`, a: xs[i] })) return false;
        i++;
      }
      while (j < je) {
        if (!push({ op: "add", path: `${path}/${j}`, b: ys[j] })) return false;
        j++;
      }
      return true;
    };
    for (const [ai, bj] of anchors) {
      if (!gap(ai, bj)) return false;
      i = ai + 1;
      j = bj + 1;
    }
    return gap(xs.length, ys.length);
  };

  walk(a, b, "", false);
  return { ops, truncated };
}

/** Index pairs of equal items, longest common subsequence. */
function lcs(xs: unknown[], ys: unknown[]): Array<[number, number]> {
  const kx = xs.map(stableKey);
  const ky = ys.map(stableKey);
  const n = xs.length;
  const m = ys.length;
  // dp[i][j] = LCS length of xs[i..] and ys[j..]
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = kx[i] === ky[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (kx[i] === ky[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/** Fallback for very long arrays: items equal at the same index anchor. */
function indexAnchors(xs: unknown[], ys: unknown[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) if (equal(xs[i], ys[i])) out.push([i, i]);
  return out;
}

function equal(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
  return stableKey(x) === stableKey(y);
}

/** JSON with sorted object keys, so `{a,b}` equals `{b,a}`. */
function stableKey(v: unknown): string {
  if (v === null || typeof v !== "object") return `${typeof v}:${JSON.stringify(v) ?? "undefined"}`;
  if (Array.isArray(v)) return `[${v.map(stableKey).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey(o[k])}`)
    .join(",")}}`;
}

function escapePointer(k: string): string {
  return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

/* -------------------------------------------------------------- baselines */

export type BaselineKind = "previous-build" | "previous-url" | "route-median";

export interface Baseline {
  kind: BaselineKind;
  id: string;
  duration: number;
  startedAt: number;
  epoch?: number;
  status?: number;
  url: string;
}

/**
 * Default baselines for subject `b` (plan 3.4), most useful first: the latest same-route request
 * from an earlier build, the latest earlier request to the same URL, and the same-route request
 * closest to the route's median duration. `records` is newest first (TraceStore.records()).
 * A trace can fill more than one slot; each kind appears at most once.
 */
export function findBaselines(records: readonly TraceRecord[], b: TraceRecord): Baseline[] {
  const key = routeKeyOf(b);
  const epochB = b.facts?.epoch;
  const sameRoute = records.filter((t) => t.id !== b.id && t.done && routeKeyOf(t) === key);
  const out: Baseline[] = [];
  const add = (kind: BaselineKind, t: TraceRecord | undefined) => {
    if (!t) return;
    const x: Baseline = { kind, id: t.id, duration: round(t.duration ?? 0), startedAt: t.startedAt, url: t.url };
    if (t.facts?.epoch !== undefined) x.epoch = t.facts.epoch;
    if (t.status !== undefined) x.status = t.status;
    out.push(x);
  };
  // Same URL variant (path + sorted query) first: ?mode=batch is a different query plan than
  // ?mode=n1, so it only stands in when the subject's variant has no candidate.
  const variant = urlVariantKey(b.url);
  const sameVariant = (t: TraceRecord) => urlVariantKey(t.url) === variant;
  const preferVariant = (list: TraceRecord[]) => {
    const own = list.filter(sameVariant);
    return own.length ? own : list;
  };
  const earlier = sameRoute.filter((t) => t.startedAt < b.startedAt);
  if (epochB !== undefined)
    add("previous-build", preferVariant(earlier.filter((t) => (t.facts?.epoch ?? epochB) < epochB))[0]);
  add(
    "previous-url",
    earlier.find((t) => t.url === b.url),
  );
  // Median over warm requests when there are any: a cold compile would drag the exemplar.
  const warm = sameRoute.filter((t) => !t.facts?.cold);
  const pool = preferVariant((warm.length ? warm : sameRoute).filter((t) => t.duration !== undefined));
  if (pool.length) {
    const ds = pool.map((t) => t.duration!).sort((x, y) => x - y);
    const median = ds[Math.floor((ds.length - 1) / 2)]!;
    let best = pool[0]!;
    for (const t of pool) if (Math.abs(t.duration! - median) < Math.abs(best.duration! - median)) best = t;
    add("route-median", best);
  }
  return out;
}
