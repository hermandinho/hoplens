// Shared, precomputed view of a finished trace that every rule reads from. Built once per analyze().

import { cappedSpans, isMarker, isRedis, normalizeSql, normalizeUrl, selfTimes } from "../facts";
import type { Finding, SourceLocation, SpanRecord, TraceFacts, TraceRecord } from "../types";
import type { InsightThresholds } from "./thresholds";

export interface RuleContext {
  trace: TraceRecord;
  facts: TraceFacts;
  th: InsightThresholds;
  spans: SpanRecord[];
  byId: Map<string, SpanRecord>;
  children: Map<string, SpanRecord[]>;
  self: Map<string, number>;
  /** "GET /api/products" — route template when known, else the normalized path. */
  routeKey: string;
  duration: number;
  /** Nearest enclosing user function (the span itself if it is one). */
  owner(s: SpanRecord): { fn?: string; location?: SourceLocation };
  /** Spans claimed by an n-plus-1 finding, so duplicate/parallelizable don't report them again. */
  claimed: Set<string>;
}

export type Rule = (ctx: RuleContext) => Finding[];

export const IO_KINDS = new Set(["db", "fetch"]);

export function buildContext(t: TraceRecord, facts: TraceFacts, th: InsightThresholds): RuleContext {
  const { spans } = cappedSpans(t);
  const byId = new Map(spans.map((s) => [s.id, s]));
  const children = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    if (!s.parentId) continue;
    let list = children.get(s.parentId);
    if (!list) children.set(s.parentId, (list = []));
    list.push(s);
  }
  const ownerCache = new Map<string, { fn?: string; location?: SourceLocation }>();
  const owner = (s: SpanRecord): { fn?: string; location?: SourceLocation } => {
    const hit = ownerCache.get(s.id);
    if (hit) return hit;
    let cur: SpanRecord | undefined = s;
    let out: { fn?: string; location?: SourceLocation } = {};
    for (let guard = 0; cur && guard < 256; guard++) {
      if (cur.kind === "function" || cur.kind === "handler" || cur.kind === "proxy") {
        out = { fn: cur.kind === "function" ? cur.name : cur.kind === "proxy" ? "proxy" : "route handler" };
        if (cur.location) out.location = cur.location;
        break;
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    ownerCache.set(s.id, out);
    return out;
  };
  let self: Map<string, number> | undefined;
  return {
    trace: t,
    facts,
    th,
    spans,
    byId,
    children,
    // Only slow-fn needs self times; compute on first use.
    get self() {
      if (!self) self = selfTimes(spans);
      return self;
    },
    routeKey: `${t.method} ${t.route ?? normalizeUrl(t.path)}`,
    duration: t.duration ?? 0,
    owner,
    claimed: new Set(),
  };
}

/* --------------------------------------------------------------- helpers */

export function statementOf(s: SpanRecord): string | undefined {
  const a = s.attrs;
  const v = a["db.statement"] ?? a["db.query.text"];
  return v === undefined ? undefined : String(v);
}

export function urlOf(s: SpanRecord): string | undefined {
  const v = s.attrs["url.full"] ?? s.attrs["http.url"];
  return v === undefined ? undefined : String(v);
}

export function methodOf(s: SpanRecord): string {
  return String(s.attrs["http.method"] ?? s.attrs["http.request.method"] ?? "GET").toUpperCase();
}

// Shapes are memoized by the raw statement / url string, not per span: a per-span WeakMap entry
// for every span of every trace was the most expensive thing in the analysis (ephemeron inserts
// plus the GC work they cause), while a string-keyed hit costs one lookup on a hash V8 caches in
// the string. The cached shape is also the same string object every time, so the rules' Maps
// keyed on it hash it once. Bounded like facts.ts's normalizer caches.
const SHAPE_MEMO_MAX = 1000;
const dbShapes = new Map<string, string>();
const redisShapes = new Map<string, string>();
const prismaShapes = new Map<string, string>();
const fetchShapes = new Map<string, Map<string, string>>(); // method -> url -> shape

function remember(cache: Map<string, string>, key: string, v: string): string {
  if (cache.size >= SHAPE_MEMO_MAX) cache.clear();
  cache.set(key, v);
  return v;
}

/** Normalized identity of an I/O span (query shape or method+url shape); undefined for other spans. */
export function shapeOf(s: SpanRecord): string | undefined {
  if (s.kind === "db") {
    const q = statementOf(s);
    if (q) {
      const redis = isRedis(s);
      const cache = redis ? redisShapes : dbShapes;
      return cache.get(q) ?? remember(cache, q, `${redis ? "redis" : "db"}:${normalizeSql(q)}`);
    }
    if (!s.name.startsWith("prisma:")) return undefined;
    return prismaShapes.get(s.name) ?? remember(prismaShapes, s.name, `db:${s.name}`);
  }
  if (s.kind === "fetch") {
    const u = urlOf(s);
    if (!u) return undefined;
    const method = methodOf(s);
    let byUrl = fetchShapes.get(method);
    if (!byUrl) {
      if (fetchShapes.size >= 64) fetchShapes.clear();
      fetchShapes.set(method, (byUrl = new Map()));
    }
    return byUrl.get(u) ?? remember(byUrl, u, `fetch:${method} ${normalizeUrl(u)}`);
  }
  return undefined;
}

// `$1`, `?`, `:name` / `@name` placeholders outside quoted strings (`::int` casts excluded).
const PLACEHOLDER = /\$\d+|\?|(?<![:\w])[:@][a-z_]\w*/i;

/** Exact identity (raw query + params, or method + full url). */
export function exactOf(s: SpanRecord): string | undefined {
  if (s.kind === "db") {
    const q = statementOf(s);
    if (!q) return undefined;
    const params = s.attrs["db.params"] ?? s.attrs["hoplens.db.params"];
    // Third-party OTel db spans (pg, mysql2, Prisma) carry the statement but not the bound values:
    // `WHERE id = $1` for id 1 and id 2 would look identical, so we can't call it a duplicate.
    if (params === undefined && PLACEHOLDER.test(q)) return undefined;
    return `db:${q}|${String(params ?? "")}`;
  }
  if (s.kind === "fetch") {
    const u = urlOf(s);
    return u ? `fetch:${methodOf(s)} ${u}` : undefined;
  }
  return undefined;
}

/** Short human label for a span's query or url, for finding titles. */
export function labelOf(s: SpanRecord, max = 60): string {
  let raw: string;
  if (s.kind === "db") raw = normalizeSql(statementOf(s) ?? s.name);
  else if (s.kind === "fetch") {
    const u = urlOf(s);
    raw = u ? `${methodOf(s)} ${normalizeUrl(u)}` : s.name;
  } else raw = s.name;
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

export const dur = (s: SpanRecord) => Math.max(0, s.end - s.start);

export const roundMs = (n: number) => Math.round(n);

export function timed(s: SpanRecord): boolean {
  return !isMarker(s);
}

/** Stable short hash for fingerprints (FNV-1a, 32-bit, base36). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function fingerprint(rule: string, routeKey: string, key: string): string {
  return `${rule}:${hash(`${routeKey}|${key}`)}`;
}

/** First non-empty location among the candidates. */
export function pickLocation(...locs: Array<SourceLocation | undefined>): SourceLocation | undefined {
  return locs.find((l) => !!l?.file);
}
