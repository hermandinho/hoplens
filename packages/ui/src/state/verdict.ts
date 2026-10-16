import type {
  Finding,
  FindingRule,
  FindingSummary,
  HopKind,
  SourceLocation,
  SpanRecord,
  StatsResponse,
  TimeBucket,
  TraceRecord,
  TraceSummary,
} from "../api/types";
import { criticalPath, isLate } from "./flame";
import { BUCKETS, SMALL_SAMPLE, fmtMs, percentiles, routeKeyOf, warmDurations } from "./stats";
import { bucketOf, isMarker, shapeLabel, shapeOf, unionLength } from "./traceview";

/*
 * Cause-first verdict for one request (plan 3.7): one sentence naming what made it slow or fail,
 * how much fixing it would save, and where. Also the grouped "where to look" rows and the
 * same-URL / route / before-edit baselines the trace header shows.
 * Pure: no signals, no DOM. Tested by packages/ui/test/verdict.test.ts.
 */

/* ---------------------------------------------------------------- verdict */

export type VerdictRule = "pending" | "cold" | "finding" | "error" | "swallowed" | "bucket" | "fast";

export interface Verdict {
  rule: VerdictRule;
  /** "fail" = 5xx or thrown; "slow" = a cause worth fixing; "ok" = fast; "info" = neutral. */
  tone: "fail" | "slow" | "ok" | "info";
  /** The sentence, ending in a period. */
  text: string;
  /** Estimated ms saved if the cause is fixed (finding rule only). */
  saveableMs?: number;
  /** The culprit's source location, when known. */
  location?: SourceLocation;
  /** The finding the verdict came from (finding rule only). */
  finding?: Finding;
  /** How often the culprit ran (N+1 / duplicate), for the source annotation. */
  repeat?: number;
  /** Average ms per repeated call. */
  perCallMs?: number;
  /**
   * N+1: the function called once per item ("getUser"). The finding's location is the enclosing
   * function's declaration; the source peek marks the call to this name below it instead.
   */
  callee?: string;
  /** Spans to highlight on the canvas for this verdict (may be empty). */
  spanIds: string[];
  /** Canvas zoom target that best shows the verdict ("handler" for a cold wait). */
  zoom?: "handler";
}

/** A finding saving less than this never becomes the verdict. */
export const VERDICT_MIN_SAVE_MS = 10;
/** Cold wait share of the total above which the wait is the verdict. */
export const COLD_WAIT_SHARE = 0.4;
/** Below this total a request is "fast" when nothing else applies. */
export const FAST_MS = 50;

/** Total duration of a trace (its end when the duration is not known yet). */
function totalOf(t: TraceRecord): number {
  if (t.duration !== undefined) return t.duration;
  let end = 0;
  for (const s of t.spans) if (!isLate(s) && s.end > end) end = s.end;
  return end;
}

/** 5xx, or an error with no status at all (same definition as stats.isError). */
export function isFailed(t: Pick<TraceRecord, "status" | "error">): boolean {
  return t.status !== undefined && t.status > 0 ? t.status >= 500 : !!t.error;
}

/** The first timed handler span, else undefined. */
function handlerSpan(spans: readonly SpanRecord[]): SpanRecord | undefined {
  let best: SpanRecord | undefined;
  for (const s of spans) if (s.kind === "handler" && !isMarker(s) && (!best || s.start < best.start)) best = s;
  return best;
}

/** ms before the route handler started: facts.preHandlerMs, else from the spans. */
export function preHandlerWait(t: TraceRecord): number | undefined {
  const fromFacts = t.facts?.preHandlerMs;
  if (fromFacts !== undefined) return fromFacts;
  const h = handlerSpan(t.spans);
  return h ? Math.max(0, h.start) : undefined;
}

/**
 * How much of the request a finding accounts for, in ms: its estimated saving, else (slow-fn, which
 * claims no saving) the function's own time from its title. Without the fallback a 1.2s cold compile
 * outranked a function that took 12.6s of a 14s request, and the verdict blamed the compile while
 * "Where to look" led with the function.
 */
export function impactMs(f: Pick<Finding, "rule" | "title" | "estSavedMs">): number {
  if (f.estSavedMs !== undefined) return f.estSavedMs;
  if (f.rule === "slow-fn") {
    const m = / spent (\d+(?:\.\d+)?)ms in its own code/.exec(f.title);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Top finding by impact (estimated saving, else a slow function's own time; ties: more spans first). */
export function topFinding(findings: readonly Finding[] | undefined): Finding | undefined {
  let best: Finding | undefined;
  for (const f of findings ?? []) {
    const a = impactMs(f);
    const b = best ? impactMs(best) : 0;
    if (!best || a > b || (a === b && f.spanIds.length > best.spanIds.length)) best = f;
  }
  return best;
}

export function verdictFor(t: TraceRecord): Verdict {
  const total = totalOf(t);
  if (!t.done) return { rule: "pending", tone: "info", text: "Still running…", spanIds: [] };
  const failed = isFailed(t);

  // 1. A cold request that mostly waited before the handler ran.
  const wait = preHandlerWait(t);
  if (t.facts?.cold && wait !== undefined && total > 0 && wait / total > COLD_WAIT_SHARE) {
    const h = handlerSpan(t.spans);
    const handlerMs = h ? h.end - h.start : Math.max(0, total - wait);
    return {
      rule: "cold",
      tone: failed ? "fail" : "info",
      text: `Waited ${fmtMs(wait)} before the handler (cold: likely dev compile). Handler itself took ${fmtMs(handlerMs)}.`,
      spanIds: h ? [h.id] : [],
      zoom: "handler",
    };
  }

  // 2. A thrown error that was caught while the response still went out (< 400): wrong data with
  // a success status is worse than slow, so it outranks every performance finding. HTTP-status-only fetch
  // failures (severity info) are often deliberate and stay in the findings list.
  const swallowed = (t.findings ?? []).find((f) => f.rule === "swallowed-error" && f.severity !== "info");
  if (swallowed) {
    const m = /^(.*?) failed \((.*)\) but the response was (\d+)( x\d+)?$/.exec(swallowed.title);
    const loc = swallowed.location;
    // The errored span's own name when it is a function; for "fetch GET …" its owning function.
    const who = m ? (/\s/.test(m[1]!) ? (swallowed.fn ?? m[1]) : m[1]) : undefined;
    // OTel types a DOMException by its numeric code ("23: The operation was aborted…"): quote the
    // message alone then.
    const err = m ? m[2]!.replace(/^\d+: (.*)$/, '"$1"') : "";
    const what = m
      ? `${/\s/.test(who!) ? who : fnRef(who)} threw ${err}${m[4] ? ` (${m[4].trim()})` : ""} but responded ${m[3]}`
      : lowerFirst(swallowed.title);
    const v: Verdict = {
      rule: "swallowed",
      tone: "fail",
      text: `Failed silently: ${what}${loc ? ` at ${shortLoc(loc)}` : ""}.`,
      finding: swallowed,
      spanIds: swallowed.spanIds,
    };
    if (loc) v.location = loc;
    return v;
  }

  // 3. The finding that would save the most.
  const top = topFinding(t.findings);
  if (top && impactMs(top) >= VERDICT_MIN_SAVE_MS) {
    const v: Verdict = {
      rule: "finding",
      tone: failed ? "fail" : "slow",
      text: `${failed ? "Failed" : "Slow"} because ${findingSentence(top, t.spans)}.`,
      saveableMs: top.estSavedMs,
      finding: top,
      spanIds: top.spanIds,
    };
    if (top.location) v.location = top.location;
    if ((top.rule === "n-plus-1" || top.rule === "duplicate") && top.count && top.count > 1) {
      v.repeat = top.count;
      const ms = memberDurations(top.spanIds, t.spans);
      if (ms.length) v.perCallMs = ms.reduce((a, b) => a + b, 0) / ms.length;
    }
    if (top.rule === "n-plus-1") {
      const callee = nplus1Callee(top, t.spans);
      if (callee) {
        v.callee = callee;
        // Highlight the per-item calls too, so the folded "x10 getUser" row lights up, not only
        // the I/O inside it.
        v.spanIds = [...top.spanIds, ...wrapperIds(top.spanIds, t.spans, callee)];
      }
    }
    return v;
  }

  // 4. A failed request.
  if (failed) {
    const err = t.error;
    const loc = err ? (err.location ?? firstAppFrame(err.stack)) : undefined;
    const what = t.status && t.status > 0 ? `Failed with ${t.status}` : "Failed";
    const msg = err ? `: ${truncate(`${err.type}: ${err.message}`, 120)}` : "";
    const v: Verdict = {
      rule: "error",
      tone: "fail",
      text: `${what}${msg}${loc ? ` at ${shortLoc(loc)}` : ""}.`,
      spanIds: t.spans.filter((s) => s.error).map((s) => s.id),
    };
    if (loc) v.location = loc;
    return v;
  }

  // 5. Fast, else the largest bucket.
  if (total < FAST_MS) return { rule: "fast", tone: "ok", text: `Fast: ${fmtMs(total)}, nothing to fix.`, spanIds: [] };
  const facts = t.facts;
  if (!facts) return { rule: "bucket", tone: "info", text: `Took ${fmtMs(total)}.`, spanIds: [] };
  let big: TimeBucket = "idle";
  for (const b of BUCKETS) if ((facts.time[b] ?? 0) > (facts.time[big] ?? 0)) big = b;
  const pct = Math.round(((facts.time[big] ?? 0) / Math.max(total, 1e-6)) * 100);
  const count = bucketCount(big, facts.counts);
  return {
    rule: "bucket",
    tone: "info",
    text: `Mostly ${BUCKET_WORDS[big]}: ${count ? `${count}, ` : ""}${pct}%.`,
    spanIds: t.spans.filter((s) => !isMarker(s) && s.kind !== "request" && bucketOf(s) === big).map((s) => s.id),
  };
}

const BUCKET_WORDS: Record<TimeBucket, string> = {
  db: "database",
  cache: "cache",
  ext: "external calls",
  fn: "your code",
  framework: "Next.js internals",
  compile: "dev compile",
  idle: "untraced time",
};

function bucketCount(b: TimeBucket, c: NonNullable<TraceRecord["facts"]>["counts"]): string | undefined {
  const n = b === "db" ? c.db : b === "cache" ? c.cache : b === "ext" ? c.fetch : b === "fn" ? c.fn : undefined;
  if (!n) return undefined;
  if (b === "db") return `${n} ${n === 1 ? "query" : "queries"}`;
  if (b === "ext") return `${n} ${n === 1 ? "fetch" : "fetches"}`;
  if (b === "cache") return `${n} cache ${n === 1 ? "call" : "calls"}`;
  return `${n} ${n === 1 ? "function" : "functions"}`;
}

/** The full verdict as one line: sentence, saving and location ("~173ms saveable · external.ts:63"). */
export function verdictLine(v: Verdict): string {
  const parts = [v.text];
  if (v.saveableMs !== undefined && v.saveableMs >= 1) parts.push(`~${fmtMs(v.saveableMs)} saveable`);
  if (v.location && v.rule !== "error" && v.rule !== "swallowed") parts.push(fullLoc(v.location));
  return parts.join(" · ");
}

/* ------------------------------------------------------- finding sentence */

/** "getUser()" / "the route handler" / "the request". */
export function fnRef(fn: string | undefined): string {
  if (!fn || fn === "request") return "the request";
  if (fn === "route handler" || fn === "proxy") return `the ${fn}`;
  return `${fn.replace(/\(\)$/, "")}()`;
}

/**
 * The cause clause of a finding, e.g. "getUser() ran 10 fetches in a loop (N+1)". Works on a full
 * Finding with the trace's spans (best) or on a FindingSummary alone (Overview hero, list peek).
 */
export function findingSentence(
  f: Pick<FindingSummary, "rule" | "title" | "fn" | "count">,
  spans?: readonly SpanRecord[],
  spanIds?: readonly string[],
): string {
  const ids = spanIds ?? (f as Partial<Finding>).spanIds ?? [];
  const n = f.count ?? ids.length;
  switch (f.rule) {
    case "n-plus-1": {
      const members = spans ? membersOf(ids, spans) : [];
      const first = members[0];
      const fetching = first ? first.kind === "fetch" : / fetched /.test(f.title);
      const isCache = first?.kind === "db" && String(first.attrs["db.system"] ?? "").toLowerCase() === "redis";
      const noun = isCache ? "cache calls" : fetching ? "fetches" : "queries";
      const via = /\bvia ([^\s()]+)\(\)/.exec(f.title)?.[1] ?? perItemWrapper(members, spans);
      return `${fnRef(via ?? f.fn)} ran ${n} ${noun} in a loop (N+1)`;
    }
    case "duplicate": {
      const label = f.title.replace(/ ran x\d+ with identical .*$/, "");
      const what = / identical url$/.test(f.title) ? "the same url" : "the same params";
      return `${label} ran ${n} times with ${what}`;
    }
    case "parallelizable": {
      const where = /^(.*?): \d+ sequential calls/.exec(f.title)?.[1] ?? f.fn;
      return `${fnRef(where)} made ${n} calls one after another that could run in parallel`;
    }
    case "fetch-uncached": {
      const url = /^fetch (\S+) not cached/.exec(f.title)?.[1];
      const times = n > 1 ? ` (${n} calls)` : "";
      return url ? `fetch ${url} skips Next's data cache${times}` : lowerFirst(f.title);
    }
    case "large-payload":
      return lowerFirst(f.title.replace(/^(Response|Request) body is/, "the $1 body is"));
    case "swallowed-error": {
      const m = /^(.*?) failed \((.*)\) but the response was (\d+)/.exec(f.title);
      return m ? `${m[1]} failed (${m[2]}) and the error was swallowed` : lowerFirst(f.title);
    }
    case "slow-fn": {
      const m = /^(.*?) spent (\d+(?:\.\d+)?)ms in its own code \((\d+)% of the request\)/.exec(f.title);
      return m ? `${fnRef(m[1])} spent ${fmtMs(Number(m[2]))} in its own code (${m[3]}%)` : lowerFirst(f.title);
    }
    case "cold-compile":
      return `the dev compile ran first (${lowerFirst(f.title)})`;
    default:
      return lowerFirst(f.title);
  }
}

/** The function an N+1 loop called per item: "via getUser()" in the title, else the members' parent. */
export function nplus1Callee(f: Pick<Finding, "title" | "spanIds">, spans: readonly SpanRecord[]): string | undefined {
  return /\bvia ([^\s()]+)\(\)/.exec(f.title)?.[1] ?? perItemWrapper(membersOf(f.spanIds, spans), spans);
}

/** Ancestors of the member spans that are calls of `callee` (nearest such ancestor each). */
function wrapperIds(ids: readonly string[], spans: readonly SpanRecord[], callee: string): string[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const out = new Set<string>();
  for (const id of ids) {
    let cur = byId.get(id);
    for (let guard = 0; cur?.parentId && guard < 8; guard++) {
      cur = byId.get(cur.parentId);
      if (!cur || cur.kind !== "function") break;
      if (cur.name === callee) {
        out.add(cur.id);
        break;
      }
    }
  }
  return [...out];
}

/** The per-item function the loop called (distinct parent calls of the same function), if any. */
function perItemWrapper(members: SpanRecord[], spans: readonly SpanRecord[] | undefined): string | undefined {
  if (!spans || members.length < 2) return undefined;
  const byId = new Map(spans.map((s) => [s.id, s]));
  const parents = members.map((s) => (s.parentId ? byId.get(s.parentId) : undefined));
  const p0 = parents[0];
  if (!p0 || p0.kind !== "function") return undefined;
  const ids = new Set<string>();
  for (const p of parents) {
    if (!p || p.kind !== "function" || p.name !== p0.name) return undefined;
    ids.add(p.id);
  }
  return ids.size > 1 ? p0.name : undefined;
}

function membersOf(ids: readonly string[], spans: readonly SpanRecord[]): SpanRecord[] {
  if (ids.length === 0) return [];
  const want = new Set(ids);
  return spans.filter((s) => want.has(s.id));
}

function memberDurations(ids: readonly string[], spans: readonly SpanRecord[]): number[] {
  return membersOf(ids, spans)
    .filter((s) => !isMarker(s))
    .map((s) => s.end - s.start);
}

function lowerFirst(s: string): string {
  return s.length > 1 && /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** First stack frame that is not marked [framework] and not inside node_modules / node:. */
export function firstAppFrame(stack: string | undefined): SourceLocation | undefined {
  for (const raw of (stack ?? "").split("\n")) {
    const m = /^\s*at (?:.+? \()?(.+?):(\d+):(\d+)\)?(\s*\[framework\])?$/.exec(raw);
    if (!m || m[4]) continue;
    const file = m[1]!;
    if (file.includes("node_modules") || file.startsWith("node:") || file.startsWith("internal/")) continue;
    return { file, line: Number(m[2]), column: Number(m[3]) };
  }
  return undefined;
}

/** "external.ts:63" */
export function shortLoc(loc: SourceLocation): string {
  const base = loc.file.split(/[\\/]/).pop() || loc.file;
  return `${base}:${loc.line}`;
}

/** "src/lib/external.ts:63" */
export function fullLoc(loc: SourceLocation): string {
  return `${loc.file}:${loc.line}`;
}

/* ---------------------------------------------------------- where to look */

export interface LookGroup {
  /** Shape ("db:SELECT …"), "fn:<name>" or a span id. */
  key: string;
  kind: HopKind;
  bucket: TimeBucket;
  /** "pg.query", "fetch", the span / function name. */
  label: string;
  /** The normalized shape ("SELECT * FROM posts LIMIT ?", "GET host/users/:id"), for I/O groups. */
  detail?: string;
  count: number;
  /** I/O: wall time the calls covered (union). Other spans: their time on the critical path. */
  ms: number;
  /** ms / total, 0..1. */
  share: number;
  location?: SourceLocation;
  spanIds: string[];
  /** The finding these spans belong to, when one does (e.g. "n-plus-1"). */
  rule?: FindingRule;
}

/**
 * "Where to look": I/O calls grouped by shape (12 identical pg.query calls are one "12x" row, timed
 * by the wall time they covered) plus the other spans the end of the request waited on (their
 * critical-path ms; repeated calls of one function grouped by name). Largest first.
 */
export function lookGroups(t: TraceRecord, limit = 5): LookGroup[] {
  const spans = t.spans.filter((s) => !isLate(s));
  const total = Math.max(totalOf(t), 1e-6);
  const groups = new Map<string, { members: SpanRecord[]; ms: number; kind: HopKind; io: boolean }>();
  const add = (key: string, s: SpanRecord, ms: number, io: boolean) => {
    const g = groups.get(key);
    if (g) {
      g.members.push(s);
      g.ms += ms;
    } else groups.set(key, { members: [s], ms, kind: s.kind, io });
  };

  const io = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    const shape = shapeOf(s);
    if (!shape) continue;
    const list = io.get(shape);
    if (list) list.push(s);
    else io.set(shape, [s]);
  }
  for (const [shape, members] of io) {
    const ms = unionLength(members.filter((s) => !isMarker(s)).map((s): [number, number] => [s.start, s.end]));
    for (const s of members) add(shape, s, 0, true);
    groups.get(shape)!.ms = ms;
  }

  const path = criticalPath(spans);
  const byId = new Map(spans.map((s) => [s.id, s]));
  for (const [id, ms] of path.ms) {
    const s = byId.get(id);
    if (!s || s.kind === "request" || shapeOf(s) || ms < 0.5) continue;
    add(s.kind === "function" ? `fn:${s.name}` : `span:${id}`, s, ms, false);
  }

  const ruleOf = new Map<string, FindingRule>();
  /** A loop finding's location (the call site the verdict names) per member span. */
  const loopLoc = new Map<string, SourceLocation>();
  for (const f of t.findings ?? [])
    for (const id of f.spanIds) {
      if (!ruleOf.has(id)) ruleOf.set(id, f.rule);
      if ((f.rule === "n-plus-1" || f.rule === "duplicate") && f.location && !loopLoc.has(id))
        loopLoc.set(id, f.location);
    }

  const out: LookGroup[] = [];
  for (const [key, g] of groups) {
    if (g.ms < 0.5) continue;
    const first = g.members[0]!;
    const shape = g.io ? key : undefined;
    const row: LookGroup = {
      key,
      kind: g.kind,
      bucket: bucketOf(first),
      label: shape ? ioLabel(first) : first.name,
      count: g.members.length,
      ms: g.ms,
      share: Math.min(1, g.ms / total),
      spanIds: g.members.map((s) => s.id),
    };
    if (shape) row.detail = shapeLabel(shape);
    // The repeated calls of a loop point where the verdict does (the loop's call site), not at the
    // shared helper's own fetch line.
    const loc = g.members.map((m) => loopLoc.get(m.id)).find(Boolean) ?? commonLocation(g.members);
    if (loc) row.location = loc;
    for (const s of g.members) {
      const r = ruleOf.get(s.id);
      if (r) {
        row.rule = r;
        break;
      }
    }
    out.push(row);
  }
  return out.sort((a, b) => b.ms - a.ms || b.count - a.count).slice(0, limit);
}

function ioLabel(s: SpanRecord): string {
  if (s.kind === "fetch") return "fetch";
  // "pg.query", "redis GET": the span name up to the statement.
  const name = s.name.split(/\s/)[0] || s.name;
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

/** The most common location among the spans (ties: the earliest seen). */
function commonLocation(spans: readonly SpanRecord[]): SourceLocation | undefined {
  const counts = new Map<string, { loc: SourceLocation; n: number }>();
  let best: { loc: SourceLocation; n: number } | undefined;
  for (const s of spans) {
    if (!s.location) continue;
    const k = `${s.location.file}:${s.location.line}`;
    const c = counts.get(k) ?? { loc: s.location, n: 0 };
    c.n++;
    counts.set(k, c);
    if (!best || c.n > best.n) best = c;
  }
  return best?.loc;
}

/* -------------------------------------------------------------- baselines */

/** Same as core's `urlVariantKey`: path + query params sorted by key, then value; no fragment. */
export function urlVariantKey(url: string): string {
  const hashAt = url.indexOf("#");
  const clean = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = clean.indexOf("?");
  let key = clean;
  if (q >= 0) {
    const params = clean
      .slice(q + 1)
      .split("&")
      .filter(Boolean)
      .sort((a, b) => {
        const ka = a.split("=")[0]!;
        const kb = b.split("=")[0]!;
        return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
    key = params.length ? `${clean.slice(0, q)}?${params.join("&")}` : clean.slice(0, q);
  }
  return key.length > 200 ? key.slice(0, 200) : key;
}

export type BaselineKind = "url" | "route" | "edit";

export interface Baseline {
  kind: BaselineKind;
  /** "same URL", "route", "before edit" */
  label: string;
  p50: number;
  /** Sample size behind p50. */
  n: number;
  /** This request minus p50 (ms). */
  deltaMs: number;
  /** deltaMs / p50 (fraction). */
  deltaPct: number;
  /** Fewer than SMALL_SAMPLE requests: a rough guide. */
  small: boolean;
  /** Where the number came from: the server's stats or this tab's traces. */
  source: "server" | "client";
  /** The epoch the "before edit" number is from. */
  epoch?: number;
  /** The sample includes this request itself (server stats count every finished request). */
  includesSelf?: boolean;
}

function baseline(
  kind: BaselineKind,
  label: string,
  duration: number,
  p50: number,
  n: number,
  source: Baseline["source"],
): Baseline {
  const deltaMs = duration - p50;
  return { kind, label, p50, n, deltaMs, deltaPct: p50 > 0 ? deltaMs / p50 : 0, small: n < SMALL_SAMPLE, source };
}

/**
 * Baselines for one request: its own URL variant (so `?fast=1` is not judged against `?fast=0`),
 * the whole route when it has several variants, and the same URL in the epoch before the trace's
 * (the last dev rebuild). Prefers the server's stats (they outlive the ring buffer); without them,
 * falls back to this tab's traces for the same URL.
 */
export function traceBaselines(
  t: TraceRecord,
  stats: StatsResponse | null | undefined,
  local: readonly TraceSummary[] = [],
  includeCold = false,
): Baseline[] {
  const duration = t.duration;
  if (duration === undefined) return [];
  const url = urlVariantKey(t.url);
  const key = routeKeyOf(t);
  const out: Baseline[] = [];
  const route = stats?.routes.find((r) => r.key === key);
  if (route && !includeCold) {
    const epoch = t.facts?.epoch;
    const inEpoch = epoch !== undefined ? route.epochs.find((e) => e.epoch === epoch) : undefined;
    const here = inEpoch ?? route.current;
    // A warm subject is one of the server's own samples for its epoch, which pulls the delta to 0.
    // When this tab still holds every other sample, use those (exact, self excluded); else say so.
    const selfIn = !!inEpoch && !t.facts?.cold;
    const vsServer = (
      kind: BaselineKind,
      label: string,
      p50: number,
      n: number,
      peers: (x: TraceSummary) => boolean,
    ): Baseline => {
      if (selfIn) {
        const others = local.filter((x) => x.id !== t.id && x.done && x.facts?.epoch === epoch && peers(x));
        const p = percentiles(warmDurations(others, false));
        if (p.n > 0 && p.p50 !== undefined && p.n >= n - 1)
          return baseline(kind, label, duration, p.p50, p.n, "client");
      }
      const b = baseline(kind, label, duration, p50, n, "server");
      if (selfIn) b.includesSelf = true;
      return b;
    };
    const v = here.variants?.find((x) => x.url === url);
    if (v?.p50 !== undefined && v.warm > 0 && !(selfIn && v.warm === 1))
      out.push(vsServer("url", "same URL", v.p50, v.warm, (x) => urlVariantKey(x.url) === url));
    const multi = (here.variants?.length ?? 0) > 1 || !v;
    if (multi && here.p50 !== undefined && here.warm > 0 && !(selfIn && here.warm === 1))
      out.push(vsServer("route", "route", here.p50, here.warm, (x) => routeKeyOf(x) === key));
    if (epoch !== undefined) {
      const before = route.epochs.filter((e) => e.epoch < epoch).sort((a, b) => b.epoch - a.epoch)[0];
      const bv = before?.variants?.find((x) => x.url === url);
      if (before && bv?.p50 !== undefined && bv.warm > 0) {
        const b = baseline("edit", "before edit", duration, bv.p50, bv.warm, "server");
        b.epoch = before.epoch;
        out.push(b);
      }
    }
    if (out.length > 0) return out;
  }
  // Client fallback: this tab's other requests to the same URL variant.
  const same = local.filter((x) => x.id !== t.id && x.done && urlVariantKey(x.url) === url);
  const p = percentiles(warmDurations(same, includeCold));
  if (p.n > 0 && p.p50 !== undefined) out.push(baseline("url", "same URL", duration, p.p50, p.n, "client"));
  const routeOthers = local.filter((x) => x.id !== t.id && x.done && routeKeyOf(x) === key);
  if (routeOthers.length > same.length) {
    const r = percentiles(warmDurations(routeOthers, includeCold));
    if (r.n > 0 && r.p50 !== undefined) out.push(baseline("route", "route", duration, r.p50, r.n, "client"));
  }
  return out;
}
