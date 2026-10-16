import type { SpanRecord, TimeBucket } from "../api/types";

/*
 * Per-trace helpers for the single-request view: span self time and bucket (mirrors
 * @hoplens/core facts.ts), I/O shapes for "x50" grouping (mirrors core insights/context.ts),
 * the span tree with "xN" groups and copy-as-curl/fetch.
 * Everything here is pure: no signals, no DOM.
 */

/* ------------------------------------------------------------------ buckets */

/** Zero-duration markers (e.g. Drizzle) are counted but never timed. */
export function isMarker(s: SpanRecord): boolean {
  return !(s.end > s.start);
}

export function isRedis(s: SpanRecord): boolean {
  return s.kind === "db" && String(s.attrs["db.system"] ?? "").toLowerCase() === "redis";
}

/** Same mapping as core's bucketOf(): the request root's own time is "idle". */
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

/** Length of the union of [start, end] intervals. */
export function unionLength(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [lo, hi] = sorted[0] as [number, number];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i] as [number, number];
    if (a > hi) {
      total += Math.max(0, hi - lo);
      lo = a;
      hi = b;
    } else if (b > hi) hi = b;
  }
  return total + Math.max(0, hi - lo);
}

/** Span duration minus the union of its children (clipped to the span). */
export function selfTimes(spans: readonly SpanRecord[]): Map<string, number> {
  const children = new Map<string, Array<[number, number]>>();
  for (const s of spans) {
    if (!s.parentId || isMarker(s)) continue;
    let list = children.get(s.parentId);
    if (!list) {
      list = [];
      children.set(s.parentId, list);
    }
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
    out.set(s.id, Math.max(0, dur - unionLength(clipped.filter(([a, b]) => b > a))));
  }
  return out;
}

export interface SpanSelf {
  span: SpanRecord;
  self: number;
}

/** The spans with the most self time in each bucket, for the budget-bar tooltips. */
export function topSpansByBucket(
  spans: readonly SpanRecord[],
  self: Map<string, number>,
  limit = 5,
): Record<TimeBucket, SpanSelf[]> {
  const out: Record<TimeBucket, SpanSelf[]> = {
    db: [],
    cache: [],
    ext: [],
    fn: [],
    framework: [],
    compile: [],
    idle: [],
  };
  for (const s of spans) {
    const v = self.get(s.id) ?? 0;
    if (v <= 0) continue;
    out[bucketOf(s)].push({ span: s, self: v });
  }
  for (const k of Object.keys(out) as TimeBucket[]) {
    out[k] = out[k].sort((a, b) => b.self - a.self).slice(0, limit);
  }
  return out;
}

/* ------------------------------------------------------------------- shapes */

const SQL_LITERALS = /'(?:[^']|'')*'|\$\d+|(?<![\w$."])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b(?:true|false)\b/gi;
const SQL_IN_LIST = /\bIN \( ?\?(?: ?, ?\?)* ?\)/gi;
const SQL_ROWS = /(\( ?\?(?: ?, ?\?)* ?\))(?: ?, ?\( ?\?(?: ?, ?\?)* ?\))+/g;

/** Same normalization as core's normalizeSql (literals → ?, IN lists and VALUES rows collapsed). */
export function normalizeSql(sql: string): string {
  let s = sql.length > 4096 ? sql.slice(0, 4096) : sql;
  s = s.replace(SQL_LITERALS, "?").replace(/\s+/g, " ").trim();
  if (s.includes("(")) s = s.replace(SQL_IN_LIST, "IN (?)").replace(SQL_ROWS, "$1");
  return s;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXID = /^[0-9a-f]{16,}$/i;

/** Same normalization as core's normalizeUrl: host + path with id segments as :id, query keys only. */
export function normalizeUrl(url: string): string {
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(url);
  let host = "";
  let pathname: string;
  let search: string;
  if (m) {
    host = (m[1] ?? "").replace(/^[^@]*@/, "").toLowerCase();
    pathname = m[2] || "/";
    search = m[3] ?? "";
  } else {
    const clean = url.split("#")[0] ?? "";
    const q = clean.indexOf("?");
    pathname = q >= 0 ? clean.slice(0, q) : clean;
    search = q >= 0 ? clean.slice(q) : "";
  }
  const path = pathname
    .split("/")
    .map((seg) => (seg && (/^\d+$/.test(seg) || UUID.test(seg) || HEXID.test(seg)) ? ":id" : seg))
    .join("/");
  const keys = search.length > 1 ? search.slice(1).split("&").filter(Boolean) : [];
  return `${host}${path}${keys.length ? `?${keys.map((kv) => kv.split("=")[0]).join("&")}` : ""}`;
}

function statementOf(s: SpanRecord): string | undefined {
  const v = s.attrs["db.statement"] ?? s.attrs["db.query.text"];
  return v === undefined ? undefined : String(v);
}

function urlOf(s: SpanRecord): string | undefined {
  const v = s.attrs["url.full"] ?? s.attrs["http.url"];
  return v === undefined ? undefined : String(v);
}

function methodOf(s: SpanRecord): string {
  return String(s.attrs["http.method"] ?? s.attrs["http.request.method"] ?? "GET").toUpperCase();
}

/** Normalized identity of an I/O span (query or method+url shape); undefined for other spans. */
export function shapeOf(s: SpanRecord): string | undefined {
  if (s.kind === "db") {
    const q = statementOf(s);
    if (q) return `${isRedis(s) ? "redis" : "db"}:${normalizeSql(q)}`;
    return s.name.startsWith("prisma:") ? `db:${s.name}` : undefined;
  }
  if (s.kind === "fetch") {
    const u = urlOf(s);
    return u ? `fetch:${methodOf(s)} ${normalizeUrl(u)}` : undefined;
  }
  return undefined;
}

/**
 * Grouping key for the Tree/Flame "xN" rows: the I/O shape, or `fn:<name>` for a traced function, so
 * an N+1 hidden one level down (12 getProductRating wrappers, each with one pg.query) folds too.
 */
export function groupShapeOf(s: SpanRecord): string | undefined {
  const io = shapeOf(s);
  if (io) return io;
  return s.kind === "function" && s.name ? `fn:${s.name}` : undefined;
}

/** Display label for a shape ("SELECT … WHERE id = ?", "GET api.x.com/users/:id"). */
export function shapeLabel(shape: string): string {
  const i = shape.indexOf(":");
  return i >= 0 ? shape.slice(i + 1) : shape;
}

/* ---------------------------------------------------------------- waterfall */

/** Siblings sharing a shape collapse into one "xN" row at this count. */
export const GROUP_MIN = 5;

export interface SpanTree {
  total: number;
  roots: SpanRecord[];
  children: Map<string, SpanRecord[]>;
  byId: Map<string, SpanRecord>;
  /** Collapsible groups by id (`parentKey|shape`). */
  groups: Map<string, SpanGroup>;
  /** Direct group membership: span id → group id. */
  memberOf: Map<string, string>;
}

export interface SpanGroup {
  id: string;
  shape: string;
  label: string;
  kind: SpanRecord["kind"];
  members: SpanRecord[];
  start: number;
  end: number;
  /** Wall time covered by the members (union). */
  wallMs: number;
  /** Sum of member durations. */
  sumMs: number;
  errored: number;
}

export type WaterfallItem =
  | { type: "span"; span: SpanRecord; depth: number }
  | { type: "group"; group: SpanGroup; depth: number; expanded: boolean };

/** Build the parent/child tree once per trace; spans whose parent is missing become roots. */
export function buildSpanTree(spans: readonly SpanRecord[]): SpanTree {
  const byId = new Map<string, SpanRecord>();
  for (const s of spans) byId.set(s.id, s);
  const children = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];
  for (const s of spans) {
    if (s.parentId && s.parentId !== s.id && byId.has(s.parentId)) {
      let list = children.get(s.parentId);
      if (!list) {
        list = [];
        children.set(s.parentId, list);
      }
      list.push(s);
    } else roots.push(s);
  }
  const byStart = (a: SpanRecord, b: SpanRecord) => a.start - b.start || b.end - a.end;
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);

  const groups = new Map<string, SpanGroup>();
  const memberOf = new Map<string, string>();
  const collect = (parentKey: string, list: SpanRecord[]) => {
    if (list.length < GROUP_MIN) return;
    const byShape = new Map<string, SpanRecord[]>();
    for (const s of list) {
      const sh = groupShapeOf(s);
      if (!sh) continue;
      const g = byShape.get(sh);
      if (g) g.push(s);
      else byShape.set(sh, [s]);
    }
    for (const [shape, members] of byShape) {
      if (members.length < GROUP_MIN) continue;
      const id = `${parentKey}|${shape}`;
      let start = Number.POSITIVE_INFINITY;
      let end = Number.NEGATIVE_INFINITY;
      let sumMs = 0;
      let errored = 0;
      for (const m of members) {
        start = Math.min(start, m.start);
        end = Math.max(end, m.end);
        sumMs += Math.max(0, m.end - m.start);
        if (m.error) errored++;
        memberOf.set(m.id, id);
      }
      groups.set(id, {
        id,
        shape,
        label: shapeLabel(shape),
        kind: (members[0] as SpanRecord).kind,
        members,
        start,
        end,
        wallMs: unionLength(members.map((m): [number, number] => [m.start, m.end])),
        sumMs,
        errored,
      });
    }
  };
  collect("root", roots);
  for (const [pid, list] of children) collect(pid, list);

  let total = 1;
  for (const s of spans) if (s.end > total) total = s.end;
  return { total, roots, children, byId, groups, memberOf };
}

/** Flatten the tree depth-first, emitting one row per collapsed group. */
export function flattenTree(tree: SpanTree, expanded: ReadonlySet<string>): WaterfallItem[] {
  const out: WaterfallItem[] = [];
  const visit = (list: SpanRecord[], depth: number) => {
    const emitted = new Set<string>();
    for (const s of list) {
      const gid = tree.memberOf.get(s.id);
      if (gid) {
        if (emitted.has(gid)) continue;
        emitted.add(gid);
        const group = tree.groups.get(gid) as SpanGroup;
        const open = expanded.has(gid);
        out.push({ type: "group", group, depth, expanded: open });
        if (open) {
          for (const m of group.members) {
            out.push({ type: "span", span: m, depth: depth + 1 });
            visit(tree.children.get(m.id) ?? [], depth + 2);
          }
        }
        continue;
      }
      out.push({ type: "span", span: s, depth });
      visit(tree.children.get(s.id) ?? [], depth + 1);
    }
  };
  visit(tree.roots, 0);
  return out;
}

/** Group ids that hide `spanId` (itself a member, or a descendant of one), outermost last. */
export function hidingGroups(tree: SpanTree, spanId: string): string[] {
  const out: string[] = [];
  let cur = tree.byId.get(spanId);
  let guard = 0;
  while (cur && guard++ < 1000) {
    const gid = tree.memberOf.get(cur.id);
    if (gid) out.push(gid);
    cur = cur.parentId ? tree.byId.get(cur.parentId) : undefined;
  }
  return out;
}

/* ------------------------------------------------------------ critical path */

// The critical path, idle gaps and "Where to look" live in ./flame.ts (Flame / Tree canvas).

/* --------------------------------------------------------------- copy as … */

export interface ReplayableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
]);

export const REDACTED = "<redacted>";

/** Copy of `headers` with credentials replaced by a placeholder (when `redact`). */
export function redactHeaders(headers: Record<string, string>, redact: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = redact && SECRET_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  return out;
}

function absolute(url: string, origin: string): string {
  return /^https?:\/\//i.test(url) ? url : `${origin.replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function toCurl(req: ReplayableRequest, origin: string, redact = true): string {
  const parts = ["curl"];
  const method = req.method.toUpperCase();
  if (method !== "GET" || req.body) parts.push(`-X ${method}`);
  parts.push(shellQuote(absolute(req.url, origin)));
  for (const [k, v] of Object.entries(redactHeaders(req.headers, redact))) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (req.body) parts.push(`--data-raw ${shellQuote(req.body)}`);
  return parts.join(" \\\n  ");
}

export function toFetch(req: ReplayableRequest, origin: string, redact = true): string {
  const init: Record<string, unknown> = { method: req.method.toUpperCase() };
  const headers = redactHeaders(req.headers, redact);
  if (Object.keys(headers).length > 0) init.headers = headers;
  if (req.body) init.body = req.body;
  return `await fetch(${JSON.stringify(absolute(req.url, origin))}, ${JSON.stringify(init, null, 2)});`;
}
