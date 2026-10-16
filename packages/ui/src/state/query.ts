// COPY of packages/core/src/query.ts (the `@hoplens/core/query` subpath). The UI can't depend on
// @hoplens/core (core embeds the UI's dist, so that would be a workspace cycle), and the file has no
// imports, so it is mirrored verbatim below this header. Keep the two in sync: the server answers
// `GET /__hoplens/api/traces?q=` with the same grammar the query bar filters with client-side.
//
// Trace search language shared by the server (`GET /__hoplens/api/traces?q=`) and the UI's query bar.
// Pure: no Node imports, no runtime state. Parsing never throws: a bad term is reported in `errors`
// and dropped, the rest of the query still applies.
//
//   status:5xx  status:404  status:>=400  status:400..499  status:404,500
//   dur:>200  dur:<=50ms  dur:>1.5s  dur:100..500       (bare number = at least, e.g. dur:200)
//   route:/api/*  route:/api/orders                      (glob; no `*` = exact or path prefix)
//   method:POST  method:get,put                          kind:route  kind:page,action
//   has:n-plus-1  has:n+1  has:error  has:findings       cold:true  cold:false
//   timeout  "connection refused"  text:"upstream 503"   (free text, all must match)
//   -status:2xx  -"health"                               (leading `-` negates any term)

export type QueryKey = "status" | "dur" | "route" | "method" | "has" | "kind" | "cold" | "text";

export type QueryTerm =
  | { key: "status"; neg: boolean; ranges: Array<[number, number]> }
  | { key: "dur"; neg: boolean; min: number; max: number; minExcl: boolean; maxExcl: boolean }
  | { key: "route"; neg: boolean; glob: string; re: GlobMatcher }
  | { key: "method"; neg: boolean; values: string[] }
  | { key: "has"; neg: boolean; values: string[] }
  | { key: "kind"; neg: boolean; values: string[] }
  | { key: "cold"; neg: boolean; value: boolean }
  | { key: "text"; neg: boolean; value: string };

export interface ParsedQuery {
  /** All terms are AND-ed. */
  terms: QueryTerm[];
  /** Human-readable problems with terms that were dropped. Empty for a clean query. */
  errors: string[];
}

/**
 * What a query is matched against. The server builds one from a full TraceRecord (free text then
 * also covers logs and bodies); the UI builds one from a TraceSummary with `summaryTarget()`.
 */
export interface QueryTarget {
  method?: string;
  path?: string;
  /** Framework route template, e.g. `/api/orders/[id]`. */
  route?: string;
  kind?: string;
  status?: number;
  /** ms; undefined while in flight (dur: terms don't match then). */
  duration?: number;
  cold?: boolean;
  /** Finding rules present on the trace. */
  rules?: readonly string[];
  /** The trace captured an error (thrown/errored span). */
  error?: boolean;
  /** Free-text sources, searched case-insensitively. Functions are called lazily, at most once. */
  text?: ReadonlyArray<string | undefined | (() => string | undefined)>;
}

const KEYS = new Set<QueryKey>(["status", "dur", "route", "method", "has", "kind", "cold", "text"]);
const MAX_INPUT = 2000;

const RULE_ALIASES: Record<string, string> = {
  "n+1": "n-plus-1",
  nplus1: "n-plus-1",
  "n-plus-one": "n-plus-1",
  nplusone: "n-plus-1",
  dup: "duplicate",
  duplicates: "duplicate",
  parallel: "parallelizable",
  slow: "slow-fn",
  uncached: "fetch-uncached",
  cold: "cold-compile",
  payload: "large-payload",
  swallowed: "swallowed-error",
  logs: "logs-on-success",
  errors: "error",
  finding: "findings",
};

/** Parse a query string. Never throws; problems end up in `errors`. */
export function parseQuery(input: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], errors: [] };
  try {
    const src = typeof input === "string" ? input.slice(0, MAX_INPUT) : "";
    for (const tok of tokenize(src, out.errors)) {
      const term = toTerm(tok, out.errors);
      if (term) out.terms.push(term);
    }
  } catch (err) {
    out.terms = [];
    out.errors.push(`Could not parse query: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

interface Token {
  neg: boolean;
  key?: string;
  value: string;
  quoted: boolean;
  raw: string;
}

function tokenize(src: string, errors: string[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    while (i < n && isSpace(src[i])) i++;
    if (i >= n) break;
    const start = i;
    let neg = false;
    if (src[i] === "-" && i + 1 < n && !isSpace(src[i + 1])) {
      neg = true;
      i++;
    }
    let key: string | undefined;
    const km = /^([a-zA-Z]+):/.exec(src.slice(i, i + 12));
    if (km && KEYS.has(km[1]!.toLowerCase() as QueryKey)) {
      key = km[1]!.toLowerCase();
      i += km[0].length;
    }
    let value = "";
    let quoted = false;
    if (src[i] === '"') {
      quoted = true;
      i++;
      let closed = false;
      while (i < n) {
        const c = src[i]!;
        if (c === "\\" && i + 1 < n) {
          value += src[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) errors.push(`Unterminated quote in ${src.slice(start, Math.min(n, start + 40))}`);
    } else {
      while (i < n && !isSpace(src[i])) value += src[i++];
    }
    out.push({ neg, key, value, quoted, raw: src.slice(start, i) });
  }
  return out;
}

function toTerm(tok: Token, errors: string[]): QueryTerm | undefined {
  const { neg } = tok;
  if (!tok.key || tok.key === "text") {
    // `-` alone (half-typed negation, e.g. `foo -`) or an empty quoted string carries nothing to match.
    if (!tok.value || (!tok.key && !tok.quoted && tok.value === "-")) return undefined;
    return { key: "text", neg, value: tok.value.toLowerCase() };
  }
  const v = tok.value.trim();
  if (!v) {
    errors.push(`${tok.key}: needs a value`);
    return undefined;
  }
  switch (tok.key) {
    case "status": {
      const ranges: Array<[number, number]> = [];
      for (const part of v.split(",")) {
        const r = statusRange(part.trim());
        if (!r) {
          errors.push(`status:${part} is not a status (try 5xx, 404, >=400, 400..499)`);
          return undefined;
        }
        ranges.push(r);
      }
      return { key: "status", neg, ranges };
    }
    case "dur": {
      const d = durRange(v);
      if (!d) {
        errors.push(`dur:${v} is not a duration (try >200, <=50ms, >1.5s, 100..500)`);
        return undefined;
      }
      return { key: "dur", neg, ...d };
    }
    case "route":
      return { key: "route", neg, glob: v, re: compileGlob(v) };
    case "method":
      return { key: "method", neg, values: list(v).map((m) => m.toUpperCase()) };
    case "kind":
      return { key: "kind", neg, values: list(v).map((m) => m.toLowerCase()) };
    case "has":
      return {
        key: "has",
        neg,
        values: list(v).map((m) => {
          const lower = m.toLowerCase();
          return RULE_ALIASES[lower] ?? lower;
        }),
      };
    case "cold": {
      const b = bool(v);
      if (b === undefined) {
        errors.push(`cold:${v} must be true or false`);
        return undefined;
      }
      return { key: "cold", neg, value: b };
    }
  }
  return undefined;
}

function list(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(v: string): boolean | undefined {
  const l = v.toLowerCase();
  if (l === "true" || l === "yes" || l === "1") return true;
  if (l === "false" || l === "no" || l === "0") return false;
  return undefined;
}

function statusRange(v: string): [number, number] | undefined {
  let m = /^([1-5])xx$/i.exec(v);
  if (m) {
    const c = Number(m[1]) * 100;
    return [c, c + 99];
  }
  m = /^(\d{3})\.\.(\d{3})$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a <= b ? [a, b] : [b, a];
  }
  m = /^(>=|<=|>|<|=)?(\d{3})$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[2]);
  switch (m[1]) {
    case ">=":
      return [n, Number.POSITIVE_INFINITY];
    case ">":
      return [n + 1, Number.POSITIVE_INFINITY];
    case "<=":
      return [Number.NEGATIVE_INFINITY, n];
    case "<":
      return [Number.NEGATIVE_INFINITY, n - 1];
    default:
      return [n, n];
  }
}

const NUM = "(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(ms|s)?";

function ms(num: string, unit: string | undefined): number {
  const n = Number(num);
  return unit?.toLowerCase() === "s" ? n * 1000 : n;
}

function durRange(v: string): Omit<Extract<QueryTerm, { key: "dur" }>, "key" | "neg"> | undefined {
  let m = new RegExp(`^${NUM}\\.\\.${NUM}$`, "i").exec(v);
  if (m) {
    const a = ms(m[1]!, m[2]);
    const b = ms(m[3]!, m[4]);
    return { min: Math.min(a, b), max: Math.max(a, b), minExcl: false, maxExcl: false };
  }
  m = new RegExp(`^(>=|<=|>|<|=)?${NUM}$`, "i").exec(v);
  if (!m) return undefined;
  const n = ms(m[2]!, m[3]);
  if (!Number.isFinite(n)) return undefined;
  const inf = Number.POSITIVE_INFINITY;
  switch (m[1]) {
    case ">":
      return { min: n, max: inf, minExcl: true, maxExcl: false };
    case "<":
      return { min: 0, max: n, minExcl: false, maxExcl: true };
    case "<=":
      return { min: 0, max: n, minExcl: false, maxExcl: false };
    case "=":
      return { min: n, max: n, minExcl: false, maxExcl: false };
    default:
      // A bare number reads as "at least": dur:200 finds the slow ones.
      return { min: n, max: inf, minExcl: false, maxExcl: false };
  }
}

/** A compiled `route:` glob. Same shape as RegExp#test so call sites read the same. */
export interface GlobMatcher {
  test(s: string): boolean;
}

/**
 * `*` (and `**`) match anything including `/`, `?` matches one character, case-insensitive. Without a
 * `*` the pattern matches exactly or as a path prefix: `/api` matches `/api` and `/api/x`, not `/apix`.
 *
 * Deliberately not a RegExp: `*` as `.*` backtracks catastrophically (`/*a*a*a*a*z` against a long
 * path ran for minutes), and this runs in the user's dev server and the UI tab. The two-pointer walk
 * below is O(pattern x input) worst case.
 */
export function compileGlob(glob: string): GlobMatcher {
  const p = glob.toLowerCase();
  if (!p.includes("*")) {
    return {
      test(input: string): boolean {
        const s = input.toLowerCase();
        if (s.length < p.length || !segMatch(p, s, 0, p.length)) return false;
        if (s.length === p.length || p.endsWith("/")) return true;
        return s[p.length] === "/";
      },
    };
  }
  return {
    test(input: string): boolean {
      const s = input.toLowerCase();
      let pi = 0;
      let si = 0;
      let starP = -1;
      let starS = 0;
      while (si < s.length) {
        if (pi < p.length && p[pi] !== "*" && (p[pi] === "?" || p[pi] === s[si])) {
          pi++;
          si++;
        } else if (pi < p.length && p[pi] === "*") {
          while (pi < p.length && p[pi] === "*") pi++;
          starP = pi;
          starS = si;
        } else if (starP >= 0) {
          // Let the last `*` swallow one more character and retry from there.
          pi = starP;
          si = ++starS;
        } else return false;
      }
      while (pi < p.length && p[pi] === "*") pi++;
      return pi === p.length;
    },
  };
}

/** Does `p` (no `*`; `?` = any one char) equal `s[from, from + len)`? */
function segMatch(p: string, s: string, from: number, len: number): boolean {
  for (let k = 0; k < len; k++) if (p[k] !== "?" && p[k] !== s[from + k]) return false;
  return true;
}

/** Does `t` satisfy every term of `q`? An empty query matches everything. */
export function matchQuery(q: ParsedQuery, t: QueryTarget): boolean {
  if (q.terms.length === 0) return true;
  let texts: Array<string | undefined> | undefined;
  const textAt = (i: number): string | undefined => {
    texts ??= [];
    if (i in texts) return texts[i];
    const src = t.text?.[i];
    let s: string | undefined;
    try {
      s = typeof src === "function" ? src() : src;
    } catch {
      s = undefined;
    }
    texts[i] = s === undefined ? undefined : s.toLowerCase();
    return texts[i];
  };
  for (const term of q.terms) {
    let hit: boolean;
    switch (term.key) {
      case "status":
        hit = t.status !== undefined && term.ranges.some(([a, b]) => t.status! >= a && t.status! <= b);
        break;
      case "dur": {
        const d = t.duration;
        hit =
          d !== undefined &&
          (term.minExcl ? d > term.min : d >= term.min) &&
          (term.maxExcl ? d < term.max : d <= term.max);
        break;
      }
      case "route":
        hit = (t.route !== undefined && term.re.test(t.route)) || (t.path !== undefined && term.re.test(t.path));
        break;
      case "method":
        hit = t.method !== undefined && term.values.includes(t.method.toUpperCase());
        break;
      case "kind":
        hit = t.kind !== undefined && term.values.includes(t.kind.toLowerCase());
        break;
      case "has":
        hit = term.values.some((v) =>
          v === "error" ? !!t.error : v === "findings" ? (t.rules?.length ?? 0) > 0 : (t.rules?.includes(v) ?? false),
        );
        break;
      case "cold":
        hit = (t.cold ?? false) === term.value;
        break;
      case "text": {
        hit = false;
        const n = t.text?.length ?? 0;
        for (let i = 0; i < n && !hit; i++) hit = textAt(i)?.includes(term.value) ?? false;
        break;
      }
    }
    if (hit === term.neg) return false;
  }
  return true;
}

/** The fields of a TraceSummary the query reads (structural, so the UI's own mirror type fits). */
export interface SummaryLike {
  method: string;
  path: string;
  url?: string;
  route?: string;
  kind?: string;
  status?: number;
  duration?: number;
  error?: string;
  facts?: { cold?: boolean };
  findings?: ReadonlyArray<{ rule: string }>;
}

/** Client-side target: free text covers path, url, route and the error message (no logs or bodies). */
export function summaryTarget(s: SummaryLike): QueryTarget {
  return {
    method: s.method,
    path: s.path,
    route: s.route,
    kind: s.kind,
    status: s.status,
    duration: s.duration,
    cold: s.facts?.cold,
    rules: s.findings?.map((f) => f.rule),
    error: !!s.error,
    text: [s.url ?? s.path, s.route, s.error],
  };
}

/** Parse once, match many. */
export function compileQuery(input: string): { query: ParsedQuery; test: (t: QueryTarget) => boolean } {
  const query = parseQuery(input);
  return { query, test: (t) => matchQuery(query, t) };
}
