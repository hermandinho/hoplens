// Cross-request query and host workbench: per-fingerprint (normalized SQL / redis command / method +
// normalized URL) aggregates and per-host fetch aggregates. Incremental, fed from the store's `done`
// event like stats.ts, so it survives ring-buffer eviction; every map is capped. Off the request path.

import { cappedSpans, isMarker, isRedis } from "./facts";
import { methodOf, shapeOf, statementOf, urlOf } from "./insights/context";
import { uncachedReason } from "./insights/rules/cache";
import { LogHistogram, routeKeyOf } from "./stats";
import type { SourceLocation, SpanRecord, TraceRecord } from "./types";

export type QueryKind = "db" | "cache" | "fetch";

export interface QueryCaller {
  /** Nearest enclosing function ("route handler" / "proxy" for those), when known. */
  fn?: string;
  location?: SourceLocation;
  calls: number;
}

export interface QueryRoute {
  /** "GET /api/orders/[id]" */
  route: string;
  calls: number;
}

export interface QueryStat {
  /** Stable key: kind-prefixed shape, e.g. "db:SELECT * FROM t WHERE id = ?". */
  fingerprint: string;
  kind: QueryKind;
  /** Normalized statement / command / "METHOD host/path/:id?keys". */
  shape: string;
  /** db.system for db/cache ("postgresql", "redis", ...). */
  system?: string;
  calls: number;
  /** Distinct traces it ran in. calls / traces > 1 hints at a loop. */
  traces: number;
  /** Calls that carried timing (zero-duration markers such as Drizzle's are counted, not timed). */
  timedCalls: number;
  totalMs: number;
  avgMs?: number;
  p95Ms?: number;
  maxMs?: number;
  /** Errored calls (span error, or HTTP >= 400 for fetch). */
  errors: number;
  /** Average rows returned, when the driver reports them (db.rows). */
  avgRows?: number;
  /** Redis reads: lookups that found / didn't find a value. */
  hits?: number;
  misses?: number;
  /** Top 5 by calls. */
  callers: QueryCaller[];
  /** Top 5 by calls. */
  routes: QueryRoute[];
  /** Last 5 trace ids that ran it, newest first, still retained in the ring buffer. */
  traceIds: string[];
  lastSeen: number;
}

export interface HostStat {
  /** "api.example.com" ("" for relative URLs, i.e. the app itself). */
  host: string;
  calls: number;
  p95Ms?: number;
  avgMs?: number;
  maxMs?: number;
  /** 0..100: calls that errored (network error or HTTP >= 400). */
  errorPct: number;
  /**
   * 0..100: GETs that asked Next's data cache to keep the response (cache: "force-cache", or
   * next.revalidate > 0 / false). Request-side intent, not an observed cache hit.
   */
  cachedPct: number;
  /** 0..100: GETs that explicitly opted out (no-store / no-cache / reload / revalidate: 0). */
  uncachedPct: number;
  /** HTTP status -> calls; "error" for calls that failed without a status. */
  statuses: Record<string, number>;
  lastSeen: number;
}

export interface QueriesResponse {
  queries: QueryStat[];
  hosts: HostStat[];
  /** epoch ms the aggregates started (process start or last clear). */
  since: number;
}

export interface QueryStatsOptions {
  /** Fingerprints kept (least recently seen dropped). Default 1000. */
  maxQueries?: number;
  /** Hosts kept. Default 200. */
  maxHosts?: number;
}

const MAX_SIDE = 20; // callers / routes tracked per fingerprint
const SAMPLE = 5;

interface QueryAgg {
  fingerprint: string;
  kind: QueryKind;
  shape: string;
  system?: string;
  calls: number;
  traces: number;
  hist: LogHistogram;
  errors: number;
  rowsSum: number;
  rowsN: number;
  hits: number;
  misses: number;
  callers: Map<string, QueryCaller>;
  routes: Map<string, number>;
  traceIds: string[];
  lastSeen: number;
}

interface HostAgg {
  host: string;
  calls: number;
  hist: LogHistogram;
  errors: number;
  gets: number;
  cached: number;
  uncached: number;
  statuses: Map<string, number>;
  lastSeen: number;
}

const hostCache = new Map<string, string>();

/** Host part of a URL (lowercased, no credentials); "" for relative URLs. Memoised (capped). */
export function hostOf(url: string): string {
  const hit = hostCache.get(url);
  if (hit !== undefined) return hit;
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(url);
  const host = m ? (m[1] ?? "").replace(/^[^@]*@/, "").toLowerCase() : "";
  if (hostCache.size >= 1000) hostCache.clear();
  hostCache.set(url, host);
  return host;
}

/** Did the request ask Next's data cache to keep this GET? (request-side, as in the fetch-uncached rule) */
export function requestCached(s: SpanRecord): boolean {
  const a = s.attrs;
  const mode = String(a["hoplens.fetch.cache"] ?? "").toLowerCase();
  const hit = String(a["hoplens.fetch.cacheHit"] ?? "").toLowerCase();
  const reval = a["hoplens.fetch.revalidate"];
  if (mode === "force-cache" || hit === "force-cache") return true;
  if (reval === undefined) return false;
  const r = String(reval).toLowerCase();
  if (r === "false") return true;
  const n = Number(r);
  return Number.isFinite(n) && n > 0;
}

function statusOf(s: SpanRecord): number | undefined {
  const v = s.attrs["http.response.status_code"] ?? s.attrs["http.status_code"];
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

function kindOf(s: SpanRecord): QueryKind | undefined {
  if (s.kind === "fetch") return "fetch";
  if (s.kind === "db") return isRedis(s) ? "cache" : "db";
  return undefined;
}

interface Owner {
  fn?: string;
  location?: SourceLocation;
}

function ownerOf(s: SpanRecord, byId: Map<string, SpanRecord>): Owner {
  let cur: SpanRecord | undefined = s.parentId ? byId.get(s.parentId) : undefined;
  for (let guard = 0; cur && guard < 256; guard++) {
    if (cur.kind === "function" || cur.kind === "handler" || cur.kind === "proxy") {
      const fn = cur.kind === "function" ? cur.name : cur.kind === "proxy" ? "proxy" : "route handler";
      return { fn, location: cur.location };
    }
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return {};
}

export class QueryStatsStore {
  private readonly queries = new Map<string, QueryAgg>();
  private readonly hosts = new Map<string, HostAgg>();
  private readonly maxQueries: number;
  private readonly maxHosts: number;
  since: number;

  constructor(
    opts: QueryStatsOptions = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.maxQueries = Math.max(1, opts.maxQueries ?? 1000);
    this.maxHosts = Math.max(1, opts.maxHosts ?? 200);
    this.since = clock();
  }

  /** Feed one finished trace. Never throws. */
  add(t: TraceRecord): void {
    try {
      this.ingest(t);
    } catch {
      /* best effort */
    }
  }

  private ingest(t: TraceRecord): void {
    const { spans } = cappedSpans(t);
    let byId: Map<string, SpanRecord> | undefined;
    // Per-trace caches: the same fingerprint / parent repeats a lot inside one trace (N+1 loops).
    const touched = new Map<string, { q: QueryAgg; calls: number }>();
    const owners = new Map<string, Owner>();
    const routeKey = routeKeyOf(t);
    const seenAt = t.startedAt + (t.duration ?? 0);
    for (const s of spans) {
      const kind = kindOf(s);
      if (!kind) continue;
      const fp = shapeOf(s);
      if (!fp) continue;
      byId ??= new Map(spans.map((x) => [x.id, x]));
      let local = touched.get(fp);
      if (!local) {
        local = { q: this.queryAgg(fp, kind, s), calls: 0 };
        touched.set(fp, local);
        const q = local.q;
        q.traces++;
        q.traceIds.unshift(t.id);
        if (q.traceIds.length > SAMPLE * 4) q.traceIds.length = SAMPLE * 4;
        q.lastSeen = seenAt;
      }
      local.calls++;
      const q = local.q;
      q.calls++;
      const timed = !isMarker(s);
      const dur = Math.max(0, s.end - s.start);
      if (timed) q.hist.add(dur);
      const status = kind === "fetch" ? statusOf(s) : undefined;
      const failed = !!s.error || (status !== undefined && status >= 400);
      if (failed) q.errors++;
      const rows = Number(s.attrs["db.rows"] ?? s.attrs["db.response.returned_rows"]);
      if (s.attrs["db.rows"] !== undefined || s.attrs["db.response.returned_rows"] !== undefined) {
        if (Number.isFinite(rows)) {
          q.rowsSum += rows;
          q.rowsN++;
        }
      }
      if (kind === "cache") {
        const hits = s.attrs["hoplens.redis.hits"];
        const misses = s.attrs["hoplens.redis.misses"];
        if (typeof hits === "number" || typeof misses === "number") {
          q.hits += Number(hits ?? 0);
          q.misses += Number(misses ?? 0);
        } else if (s.attrs["hoplens.redis.hit"] === true) q.hits++;
        else if (s.attrs["hoplens.redis.hit"] === false) q.misses++;
      }
      const pk = s.parentId ?? "";
      let owner = owners.get(pk);
      if (!owner) owners.set(pk, (owner = ownerOf(s, byId)));
      const loc = s.location ?? owner.location;
      const callerKey = `${owner.fn ?? ""}|${loc ? `${loc.file}:${loc.line}` : ""}`;
      const c = q.callers.get(callerKey);
      if (c) c.calls++;
      else if (q.callers.size < MAX_SIDE) {
        const caller: QueryCaller = { calls: 1 };
        if (owner.fn) caller.fn = owner.fn;
        if (loc) caller.location = loc;
        q.callers.set(callerKey, caller);
      }

      if (kind === "fetch") {
        const url = urlOf(s);
        if (url === undefined) continue;
        const h = this.hostAgg(hostOf(url));
        h.calls++;
        h.lastSeen = seenAt;
        if (timed) h.hist.add(dur);
        if (failed) h.errors++;
        const sk = status !== undefined ? String(status) : s.error ? "error" : undefined;
        if (sk) h.statuses.set(sk, (h.statuses.get(sk) ?? 0) + 1);
        if (methodOf(s) === "GET") {
          h.gets++;
          if (requestCached(s)) h.cached++;
          else if (uncachedReason(s)) h.uncached++;
        }
      }
    }
    for (const { q, calls } of touched.values()) {
      const rc = q.routes.get(routeKey);
      if (rc !== undefined) q.routes.set(routeKey, rc + calls);
      else if (q.routes.size < MAX_SIDE) q.routes.set(routeKey, calls);
    }
  }

  private queryAgg(fp: string, kind: QueryKind, s: SpanRecord): QueryAgg {
    let q = this.queries.get(fp);
    if (q) {
      this.queries.delete(fp);
      this.queries.set(fp, q);
      return q;
    }
    const colon = fp.indexOf(":");
    q = {
      fingerprint: fp,
      kind,
      shape: colon >= 0 ? fp.slice(colon + 1) : fp,
      calls: 0,
      traces: 0,
      hist: new LogHistogram(),
      errors: 0,
      rowsSum: 0,
      rowsN: 0,
      hits: 0,
      misses: 0,
      callers: new Map(),
      routes: new Map(),
      traceIds: [],
      lastSeen: 0,
    };
    if (kind !== "fetch") {
      const sys = s.attrs["db.system"];
      if (sys !== undefined) q.system = String(sys);
      else if (statementOf(s) === undefined && s.name.startsWith("prisma:")) q.system = "prisma";
    }
    this.queries.set(fp, q);
    if (this.queries.size > this.maxQueries) {
      const oldest = this.queries.keys().next().value;
      if (oldest !== undefined) this.queries.delete(oldest);
    }
    return q;
  }

  private hostAgg(host: string): HostAgg {
    let h = this.hosts.get(host);
    if (h) {
      this.hosts.delete(host);
      this.hosts.set(host, h);
      return h;
    }
    h = {
      host,
      calls: 0,
      hist: new LogHistogram(),
      errors: 0,
      gets: 0,
      cached: 0,
      uncached: 0,
      statuses: new Map(),
      lastSeen: 0,
    };
    this.hosts.set(host, h);
    if (this.hosts.size > this.maxHosts) {
      const oldest = this.hosts.keys().next().value;
      if (oldest !== undefined) this.hosts.delete(oldest);
    }
    return h;
  }

  clear(): void {
    this.queries.clear();
    this.hosts.clear();
    this.since = this.clock();
  }

  /**
   * Snapshot sorted by total time, heaviest first. `retained(id)` filters the trace-id samples down to
   * traces still in the ring buffer (so every id the UI gets can be opened).
   */
  snapshot(opts: { kind?: QueryKind; limit?: number; retained?: (id: string) => boolean } = {}): QueriesResponse {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
    const queries: QueryStat[] = [];
    for (const q of this.queries.values()) {
      if (opts.kind && q.kind !== opts.kind) continue;
      const out: QueryStat = {
        fingerprint: q.fingerprint,
        kind: q.kind,
        shape: q.shape,
        calls: q.calls,
        traces: q.traces,
        timedCalls: q.hist.n,
        totalMs: r2(q.hist.sum),
        errors: q.errors,
        callers: [...q.callers.values()].sort((a, b) => b.calls - a.calls).slice(0, 5),
        routes: [...q.routes.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([route, calls]) => ({ route, calls })),
        traceIds: (opts.retained ? q.traceIds.filter(opts.retained) : q.traceIds).slice(0, SAMPLE),
        lastSeen: q.lastSeen,
      };
      if (q.system) out.system = q.system;
      if (q.hist.n > 0) {
        out.avgMs = r2(q.hist.mean()!);
        out.p95Ms = r2(q.hist.quantile(0.95)!);
        out.maxMs = r2(q.hist.max);
      }
      if (q.rowsN > 0) out.avgRows = r2(q.rowsSum / q.rowsN);
      if (q.kind === "cache" && q.hits + q.misses > 0) {
        out.hits = q.hits;
        out.misses = q.misses;
      }
      queries.push(out);
    }
    queries.sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls);
    queries.length = Math.min(queries.length, limit);

    const hosts: HostStat[] = [];
    for (const h of this.hosts.values()) {
      const out: HostStat = {
        host: h.host,
        calls: h.calls,
        errorPct: pct(h.errors, h.calls),
        cachedPct: pct(h.cached, h.gets),
        uncachedPct: pct(h.uncached, h.gets),
        statuses: Object.fromEntries(h.statuses),
        lastSeen: h.lastSeen,
      };
      if (h.hist.n > 0) {
        out.avgMs = r2(h.hist.mean()!);
        out.p95Ms = r2(h.hist.quantile(0.95)!);
        out.maxMs = r2(h.hist.max);
      }
      hosts.push(out);
    }
    hosts.sort((a, b) => b.calls - a.calls);
    return { queries, hosts, since: this.since };
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
