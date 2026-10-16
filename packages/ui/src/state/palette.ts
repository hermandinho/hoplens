import { signal } from "@preact/signals";
import type { FindingSeverity, QueryStat, TraceSummary } from "../api/types";
import { findingQuery, quoteValue } from "./querySuggest";
import { type FindingGroup, RULE_LABELS, type RouteStats, fmtMs, isError, rankFindingGroups } from "./stats";
import { findingSentence } from "./verdict";

/*
 * Command palette (plan 3.8): Ctrl/Cmd+K. One input over every kind of thing the UI can open:
 * findings, routes, recent requests, query shapes, edits, views and actions. This module is the
 * pure half (items, matching, ranking, recents) so it can be unit-tested; components/Palette.tsx
 * gathers the live data, renders, and runs the server search.
 *
 *   Enter       primary action (open)
 *   Ctrl+Enter  secondary action (filter, scope, ...), when the row has one
 */

export type PaletteGroup = "recent" | "findings" | "routes" | "requests" | "shapes" | "edits" | "views" | "actions";

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  recent: "Recent",
  findings: "Findings",
  routes: "Routes",
  requests: "Recent requests",
  shapes: "Query shapes",
  edits: "Edits",
  views: "Views",
  actions: "Actions",
};

/** Display order when scores tie (plan 3.8). */
const GROUP_ORDER: readonly PaletteGroup[] = [
  "recent",
  "findings",
  "routes",
  "requests",
  "shapes",
  "edits",
  "views",
  "actions",
];

export interface PaletteAction {
  label: string;
  run: () => void;
}

export interface PaletteItem {
  /** Stable across openings ("route:GET /api/feed", "req:<id>"): recents are stored by it. */
  id: string;
  group: Exclude<PaletteGroup, "recent">;
  title: string;
  /** Secondary text, shown dim and matched with a lower weight. */
  detail?: string;
  /** Matched but not shown (routes of a finding, rule names, file paths). */
  keywords?: string;
  /** Shortcut shown on the right, already formatted ("1", "Ctrl+\\"). */
  shortcut?: string;
  /** Severity dot (findings, failed requests). */
  sev?: "err" | "warn" | "info";
  /** Enter. */
  primary: PaletteAction;
  /** Ctrl/Cmd+Enter. */
  secondary?: PaletteAction;
}

export interface PaletteSection {
  group: PaletteGroup;
  items: PaletteItem[];
}

/* ------------------------------------------------------------------ matching */

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? "";
  const cur = text[i] ?? "";
  if (!/[a-z0-9]/i.test(prev)) return true;
  // camelCase: getUser -> "User"
  return /[a-z]/.test(prev) && /[A-Z]/.test(cur);
}

/**
 * How well one query token matches a text: 0 = no match. Word-start prefix beats a plain
 * substring, which beats an in-order subsequence.
 */
export function scoreToken(token: string, text: string): number {
  if (!token) return 1;
  const lower = text.toLowerCase();
  const t = token.toLowerCase();
  let best = 0;
  let from = 0;
  for (;;) {
    const i = lower.indexOf(t, from);
    if (i < 0) break;
    const s = isWordStart(text, i) ? (i === 0 ? 100 : 80) : 50;
    if (s > best) best = s;
    if (best === 100) break;
    from = i + 1;
  }
  if (best) return best + (lower.length === t.length ? 20 : 0);
  // Subsequence: every char in order, scored by how tight the span is.
  let j = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < lower.length && j < t.length; i++) {
    if (lower[i] === t[j]) {
      if (first < 0) first = i;
      last = i;
      j++;
    }
  }
  if (j < t.length) return 0;
  const spread = last - first + 1 - t.length;
  return Math.max(5, 30 - spread * 2);
}

/** Score an item for a query: every whitespace token must match the title, detail or keywords. */
export function scoreItem(item: Pick<PaletteItem, "title" | "detail" | "keywords">, query: string): number {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  let total = 0;
  for (const tok of tokens) {
    const s = Math.max(
      scoreToken(tok, item.title),
      item.detail ? scoreToken(tok, item.detail) * 0.6 : 0,
      item.keywords ? scoreToken(tok, item.keywords) * 0.5 : 0,
    );
    if (s <= 0) return 0;
    total += s;
  }
  return total / tokens.length;
}

/* ------------------------------------------------------------------- ranking */

export interface RankOptions {
  /** Rows per group while typing. */
  perGroup?: number;
  /** Rows per group before typing. */
  idlePerGroup?: number;
  /** Item ids of recent picks, newest first (shown as "Recent" before typing). */
  recents?: readonly string[];
}

/**
 * Group and rank items for a query. Before typing: Recent, then the first few rows of each group in
 * their given order (the caller orders findings by impact, requests newest first). While typing:
 * matching rows by score within each group, and groups ordered by their best match (ties keep the
 * plan's order), so Enter takes the best match whatever its kind.
 */
export function rankItems(items: readonly PaletteItem[], query: string, opts: RankOptions = {}): PaletteSection[] {
  const q = query.trim();
  const perGroup = opts.perGroup ?? 6;
  const idle = opts.idlePerGroup ?? 3;
  const byGroup = new Map<PaletteGroup, { item: PaletteItem; score: number; i: number }[]>();
  items.forEach((item, i) => {
    const score = q ? scoreItem(item, q) : 1;
    if (score <= 0) return;
    const list = byGroup.get(item.group) ?? [];
    list.push({ item, score, i });
    byGroup.set(item.group, list);
  });

  const sections: (PaletteSection & { best: number })[] = [];
  if (!q && opts.recents?.length) {
    const byId = new Map(items.map((it) => [it.id, it]));
    const recent = opts.recents.map((id) => byId.get(id)).filter((x): x is PaletteItem => !!x);
    if (recent.length) sections.push({ group: "recent", items: recent.slice(0, 5), best: Number.POSITIVE_INFINITY });
  }
  const shownRecent = new Set(sections[0]?.items.map((it) => it.id) ?? []);
  for (const [group, list] of byGroup) {
    const sorted = q ? [...list].sort((a, b) => b.score - a.score || a.i - b.i) : list;
    const rows = sorted.filter((x) => !shownRecent.has(x.item.id)).slice(0, q ? perGroup : idleLimit(group, idle));
    if (rows.length) sections.push({ group, items: rows.map((x) => x.item), best: rows[0]?.score ?? 0 });
  }
  const order = (g: PaletteGroup) => GROUP_ORDER.indexOf(g);
  sections.sort((a, b) => (q ? b.best - a.best : 0) || order(a.group) - order(b.group));
  return sections.map(({ group, items: rows }) => ({ group, items: rows }));
}

/** Before typing, views and actions are short lists worth showing whole. */
function idleLimit(group: PaletteGroup, idle: number): number {
  return group === "views" ? 4 : group === "actions" ? 6 : idle;
}

/** Flattened rows in display order (for the keyboard cursor). */
export function flatRows(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items);
}

/* ------------------------------------------------------------------- recents */

const RECENT_KEY = "hoplens.palette.recent";
const RECENT_MAX = 8;

export function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Put an id first in the recents list (deduped, capped). Pure: returns the new list. */
export function pushRecent(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
}

export function writeRecents(list: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* blocked storage: recents just aren't remembered */
  }
}

/* -------------------------------------------------------------- open / close */

/** Palette and cheatsheet visibility. Opening one closes the other. */
export const paletteOpen = signal(false);
export const cheatsheetOpen = signal(false);

export function togglePalette(): void {
  const next = !paletteOpen.value;
  cheatsheetOpen.value = false;
  paletteOpen.value = next;
}

export function toggleCheatsheet(): void {
  const next = !cheatsheetOpen.value;
  paletteOpen.value = false;
  cheatsheetOpen.value = next;
}

/* -------------------------------------------------------------------- items */

export interface PaletteEdit {
  epoch: number;
  /** Retained requests in it. */
  n: number;
  /** First request seen in it (ms epoch). */
  first: number;
}

/** Everything the palette lists, as plain data (components/Palette.tsx reads the signals). */
export interface PaletteData {
  findings: readonly FindingGroup[];
  routes: readonly RouteStats[];
  /** Newest first. */
  traces: readonly TraceSummary[];
  shapes: readonly QueryStat[];
  /** Newest first. */
  edits: readonly PaletteEdit[];
  /** Server search (`/traces?q=`) hits for `searchQuery`: they matched in logs or bodies too. */
  search?: { q: string; ids: ReadonlySet<string> };
  /** Views and actions, built by the caller from the keymap. */
  extra?: readonly PaletteItem[];
  /** A finding's culprit line (state/callSite: an N+1's loop call); default its own location. */
  locOf?: (f: FindingGroup) => { file: string; line: number } | undefined;
}

/** What the rows do. Injected so the items stay testable without the store. */
export interface PaletteActs {
  openTrace(id: string): void;
  openRoute(key: string): void;
  filterRequests(query: string): void;
  openShape(fingerprint: string): void;
  openEdit(epoch: number): void;
  scopeSince(epoch: number): void;
}

/** Requests considered for matching (newest first). The server search covers older ones. */
const MAX_REQUESTS = 300;

const SEV: Record<FindingSeverity, PaletteItem["sev"]> = { error: "err", warn: "warn", info: "info" };

/**
 * The Overview's impact figure for a finding: "~311ms/req × 12 = 3.73s", "~2.00s in 1 request (seen
 * once)", or the request count when there is no saving estimate.
 */
export function findingImpact(
  f: Pick<FindingGroup, "savedMsPerRequest" | "requests" | "impactMs" | "seenOnce">,
): string {
  const per = f.savedMsPerRequest !== undefined && f.savedMsPerRequest >= 1 ? f.savedMsPerRequest : undefined;
  if (per === undefined) return `${f.requests} req${f.requests === 1 ? "" : "s"}`;
  if (f.seenOnce) return `~${fmtMs(per)} in 1 request (seen once)`;
  return `~${fmtMs(per)}/req × ${f.requests} = ${fmtMs(f.impactMs)}`;
}

function routeFilter(method: string, route: string): string {
  return `method:${method} route:${quoteValue(route)}`;
}

function clock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "";
  }
}

export function buildItems(d: PaletteData, act: PaletteActs): PaletteItem[] {
  const out: PaletteItem[] = [];

  // The Overview's ranking and sentence (plan 3.7): actionable before seen-once / dev-compile, then
  // saveable ms per request x requests. So the palette's first finding is the Overview's hero.
  for (const f of rankFindingGroups(d.findings)) {
    const at = d.locOf ? d.locOf(f) : f.location;
    const loc = at ? `${at.file.split("/").pop()}:${at.line}` : undefined;
    const filter = { label: "Filter requests", run: () => act.filterRequests(findingQuery(f.rule, f.routes)) };
    out.push({
      id: `finding:${f.fingerprint}`,
      group: "findings",
      title: findingSentence({ rule: f.rule, title: f.title, fn: f.fn, count: f.maxCount }),
      detail: [RULE_LABELS[f.rule] ?? f.rule, findingImpact(f), loc].filter(Boolean).join(" · "),
      keywords: [f.title, f.rule, f.fn, f.location?.file, ...f.routes].filter(Boolean).join(" "),
      sev: SEV[f.severity],
      // A server-only row whose example request was evicted can still filter.
      ...(f.latestTraceId
        ? { primary: { label: "Open example", run: () => act.openTrace(f.latestTraceId) }, secondary: filter }
        : { primary: filter }),
    });
  }

  for (const r of d.routes) {
    out.push({
      id: `route:${r.key}`,
      group: "routes",
      title: `${r.method} ${r.route}`,
      detail: [
        `${r.hits} req${r.hits === 1 ? "" : "s"}`,
        r.latency.p50 !== undefined ? `p50 ${fmtMs(r.latency.p50)}` : undefined,
        r.errors ? `${r.errors} failed` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      sev: r.errors ? "err" : undefined,
      primary: { label: "Open route", run: () => act.openRoute(r.key) },
      secondary: { label: "Filter requests", run: () => act.filterRequests(routeFilter(r.method, r.route)) },
    });
  }

  const hits = d.search?.ids;
  let n = 0;
  for (const t of d.traces) {
    if (t.kind === "asset") continue;
    const hit = hits?.has(t.id) ?? false;
    if (n >= MAX_REQUESTS && !hit) continue;
    n++;
    const status = t.status ?? (t.error ? "ERR" : t.done ? "" : "...");
    const title = `${t.method} ${t.url}`;
    const own = [t.route, t.error, ...(t.findings ?? []).map((f) => f.title)].filter(Boolean).join(" ");
    // A server hit the summary can't explain matched in its logs or body: say so, and make the
    // query match it here too.
    const deep = hit && !!d.search && scoreItem({ title, keywords: own }, d.search.q) === 0;
    out.push({
      id: `req:${t.id}`,
      group: "requests",
      title,
      detail: [
        String(status),
        t.duration !== undefined ? fmtMs(t.duration) : undefined,
        clock(t.startedAt),
        deep ? "matched in logs/body" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: deep ? `${own} ${d.search?.q}` : own,
      sev: isError(t) || t.error ? "err" : undefined,
      primary: { label: "Open request", run: () => act.openTrace(t.id) },
      secondary: {
        label: "Filter by its route",
        run: () => act.filterRequests(routeFilter(t.method, t.route ?? t.path)),
      },
    });
  }

  for (const q of d.shapes) {
    const latest = q.traceIds[0];
    out.push({
      id: `shape:${q.fingerprint}`,
      group: "shapes",
      title: q.shape,
      detail: [
        q.system ?? q.kind,
        `${q.calls} call${q.calls === 1 ? "" : "s"} in ${q.traces} req${q.traces === 1 ? "" : "s"}`,
        q.p95Ms !== undefined ? `p95 ${fmtMs(q.p95Ms)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: [q.kind, ...q.routes.map((r) => r.route), ...q.callers.map((c) => c.fn)].filter(Boolean).join(" "),
      sev: q.errors ? "err" : undefined,
      primary: { label: "Open shape", run: () => act.openShape(q.fingerprint) },
      secondary: latest ? { label: "Open latest request", run: () => act.openTrace(latest) } : undefined,
    });
  }

  for (const e of d.edits) {
    out.push({
      id: `edit:${e.epoch}`,
      group: "edits",
      title: `e${e.epoch}`,
      detail: `${e.n} request${e.n === 1 ? "" : "s"} · from ${clock(e.first)}`,
      keywords: "edit rebuild epoch change",
      primary: { label: "Open in Changes", run: () => act.openEdit(e.epoch) },
      secondary: { label: "Scope lists since this edit", run: () => act.scopeSince(e.epoch) },
    });
  }

  if (d.extra) out.push(...d.extra);
  return out;
}

/** Edits (dev-rebuild epochs) seen in the retained requests, newest first. */
export function editsOf(traces: readonly TraceSummary[]): PaletteEdit[] {
  const m = new Map<number, PaletteEdit>();
  for (const t of traces) {
    const e = t.facts?.epoch;
    if (e === undefined || t.kind === "asset") continue;
    const cur = m.get(e);
    if (!cur) m.set(e, { epoch: e, n: 1, first: t.startedAt });
    else {
      cur.n++;
      if (t.startedAt < cur.first) cur.first = t.startedAt;
    }
  }
  return [...m.values()].sort((a, b) => b.epoch - a.epoch);
}
