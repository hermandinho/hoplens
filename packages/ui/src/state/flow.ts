import { computed } from "@preact/signals";
import type { HopKind, SpanRecord, TraceRecord } from "../api/types";
import { selectedTrace } from "./store";

/**
 * Resource classification for the Flow view's "Touched" grid.
 *
 * Instead of dumping every span in a left-to-right line, we categorize spans
 * by what they *touched* (which database, which cache, which external host)
 * so the diagram answers the only real question: "what did this request
 * actually do?"
 */

export type ResourceCategory = "db" | "cache" | "external" | "internal" | "render";

export interface ResourceItem {
  /** The underlying span — click → selectHop(span.id). */
  span: SpanRecord;
  /** Short label: "SELECT users", "GET /charges", "renderUser.tsx". */
  label: string;
  /** Sub-label: "3 rows", "stripe.com", etc. */
  sub?: string;
  /** Milliseconds spent in this call. */
  duration: number;
  /** Non-zero when the call errored. */
  errored: boolean;
}

export interface ResourceGroup {
  category: ResourceCategory;
  /** Human-readable group name: "PostgreSQL", "Redis", "api.stripe.com", "src/lib/*.ts". */
  name: string;
  /** Icon slug — maps to a CSS class. */
  icon: string;
  items: ResourceItem[];
  /** Sum of item durations. */
  totalMs: number;
}

export interface FlowModel {
  trace: TraceRecord;
  /** The spans that make up the request pipeline (request / proxy / router / handler / response). */
  pipeline: SpanRecord[];
  /** Everything the handler touched, grouped. Sorted by totalMs desc. */
  groups: ResourceGroup[];
  /** Totals for the header strip. */
  totals: {
    dbMs: number;
    cacheMs: number;
    externalMs: number;
    internalMs: number;
    renderMs: number;
  };
}

const PIPELINE_KINDS: HopKind[] = ["request", "proxy", "router", "handler", "response"];

/** Everything the Flow view's left/right/center panels read from. */
export const flowModel = computed<FlowModel | null>(() => {
  const t = selectedTrace.value;
  if (!t) return null;

  const pipeline: SpanRecord[] = [];
  for (const kind of PIPELINE_KINDS) {
    const s = t.spans.find((x) => x.kind === kind);
    if (s) pipeline.push(s);
  }

  // Bucket resource calls.
  const buckets = new Map<string, ResourceGroup>();
  const totals = { dbMs: 0, cacheMs: 0, externalMs: 0, internalMs: 0, renderMs: 0 };
  for (const s of t.spans) {
    const resource = classify(s);
    if (!resource) continue;
    const key = `${resource.category}::${resource.group}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        category: resource.category,
        name: resource.group,
        icon: resource.icon,
        items: [],
        totalMs: 0,
      };
      buckets.set(key, bucket);
    }
    const duration = Math.max(0, s.end - s.start);
    bucket.items.push({ span: s, label: resource.label, sub: resource.sub, duration, errored: !!s.error });
    bucket.totalMs += duration;
    switch (resource.category) {
      case "db":
        totals.dbMs += duration;
        break;
      case "cache":
        totals.cacheMs += duration;
        break;
      case "external":
        totals.externalMs += duration;
        break;
      case "internal":
        totals.internalMs += duration;
        break;
      case "render":
        totals.renderMs += duration;
        break;
    }
  }

  // Sort items inside each bucket by time; sort buckets by category then by totalMs.
  const CAT_ORDER: ResourceCategory[] = ["db", "cache", "external", "internal", "render"];
  const groups = Array.from(buckets.values())
    .map((g) => ({ ...g, items: g.items.sort((a, b) => b.duration - a.duration) }))
    .sort((a, b) => {
      const ca = CAT_ORDER.indexOf(a.category);
      const cb = CAT_ORDER.indexOf(b.category);
      if (ca !== cb) return ca - cb;
      return b.totalMs - a.totalMs;
    });

  return { trace: t, pipeline, groups, totals };
});

/* ---------------------------------------------------------- classification */

interface Classification {
  category: ResourceCategory;
  /** Grouping key (same group → same panel). */
  group: string;
  /** Short left-side label on the row. */
  label: string;
  /** Dim right-side detail. */
  sub?: string;
  icon: string;
}

function classify(s: SpanRecord): Classification | null {
  const a = s.attrs ?? {};
  const system = String(a["db.system"] ?? "").toLowerCase();

  if (s.kind === "db" || system) {
    // Redis = cache lane, SQL / document = db lane.
    if (system === "redis" || system === "memcached") {
      const op = String(a["db.operation"] ?? "").toUpperCase();
      const key = String(a["hoplens.redis.key"] ?? "");
      return {
        category: "cache",
        group: titleOf(system),
        label: op || "command",
        sub: key || undefined,
        icon: "cache",
      };
    }
    const parsed = parseSqlTarget(String(a["db.statement"] ?? s.name ?? ""));
    return {
      category: "db",
      group: titleOf(system || "database"),
      label: parsed.operation,
      sub: parsed.table,
      icon: dbIcon(system),
    };
  }

  if (s.kind === "fetch") {
    const url = String(a["url.full"] ?? a["http.url"] ?? "");
    if (!url) return null;
    const method = String(a["http.method"] ?? "GET").toUpperCase();
    try {
      const u = new URL(url);
      // Local calls to the same app are "internal"; truly external to another host.
      const host = u.host;
      const isLocal = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(host);
      return {
        category: isLocal ? "internal" : "external",
        group: isLocal ? "Local HTTP" : host,
        label: `${method} ${pathOnly(u.pathname)}`,
        sub: a["hoplens.fetch.cacheHit"] ? String(a["hoplens.fetch.cacheHit"]) : undefined,
        icon: isLocal ? "fn" : "cloud",
      };
    } catch {
      return { category: "external", group: "Unknown host", label: `${method} …`, icon: "cloud" };
    }
  }

  if (s.kind === "function") {
    const file = s.location?.file ?? String(a["hoplens.file"] ?? "");
    const group = file ? dirname(file) : "Functions";
    return {
      category: "internal",
      group: group || "Functions",
      label: s.name,
      sub: file ? baseName(file) : undefined,
      icon: "fn",
    };
  }

  if (s.kind === "render") {
    return {
      category: "render",
      group: "React Server Components",
      label: s.name,
      icon: "render",
    };
  }

  return null;
}

function parseSqlTarget(sql: string): { operation: string; table?: string } {
  const trimmed = sql.trim().replace(/\s+/g, " ");
  if (!trimmed) return { operation: "query" };
  const m = trimmed.match(/^(SELECT|INSERT|UPDATE|DELETE|UPSERT|BEGIN|COMMIT|ROLLBACK|WITH|CREATE|DROP|ALTER)\b/i);
  const op = (m?.[1] ?? "query").toUpperCase();
  // Rough table-name extraction. Covers "FROM x", "INTO x", "UPDATE x", "DELETE FROM x".
  const t = trimmed.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+["`]?([a-zA-Z_][\w.]*)["`]?/i);
  const table = t?.[1];
  return { operation: op, table };
}

function pathOnly(p: string): string {
  if (p.length > 48) return `${p.slice(0, 46)}…`;
  return p;
}

function dirname(file: string): string {
  const i = file.lastIndexOf("/");
  return i >= 0 ? file.slice(0, i) : "";
}

function baseName(file: string): string {
  const i = file.lastIndexOf("/");
  return i >= 0 ? file.slice(i + 1) : file;
}

function titleOf(system: string): string {
  switch (system) {
    case "postgresql":
    case "postgres":
      return "PostgreSQL";
    case "mysql":
      return "MySQL";
    case "sqlite":
      return "SQLite";
    case "mongodb":
    case "mongo":
      return "MongoDB";
    case "redis":
      return "Redis";
    case "memcached":
      return "Memcached";
    case "sql":
      return "SQL";
    default:
      return system ? system[0]!.toUpperCase() + system.slice(1) : "Database";
  }
}

function dbIcon(system: string): string {
  if (system === "mongodb" || system === "mongo") return "mongo";
  if (system === "mysql") return "mysql";
  if (system === "sqlite") return "sqlite";
  if (system === "postgresql" || system === "postgres") return "postgres";
  return "db";
}
