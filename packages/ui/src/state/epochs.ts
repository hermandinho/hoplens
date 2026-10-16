import { computed, effect, signal } from "@preact/signals";
import type {
  EpochStats,
  EpochView,
  EpochsResponse,
  ErrorKinds,
  FindingCount,
  HistogramBucket,
  RegressionStatus,
  RegressionsResponse,
  RouteRegression,
  ServerRouteStats,
  StatsResponse,
  TimeBucket,
  TraceSummary,
} from "../api/types";
import { clearedAt, liveActivity, throttle } from "./activity";
import { mergeBuckets, mergedPercentiles } from "./serverStats";
import { BUCKET_LABELS, fmtMs, isError, routeKeyOf } from "./stats";

/*
 * Edits (dev-rebuild epochs) and what each one changed (plan 3.5, WP9b). Data comes from WP9a's
 * GET /api/epochs, GET /api/regressions and the SSE stream /api/epochs/events (`epoch` on every
 * rebuild, `regression` the first time a route in the newest epoch is judged regressed).
 *
 * The top half of this file is pure (unit-tested in test/epochs.test.ts); the bottom half holds the
 * signals and the live wiring, started by the top bar's EpochRail (startEpochs), never on import.
 */

/* ======================================================================= pure */

/** "src/lib/store.ts" -> "store.ts". */
export function baseName(file: string): string {
  const i = file.lastIndexOf("/");
  return i >= 0 ? file.slice(i + 1) : file;
}

/** A rebuilt-chunk hint as a name: "app/api/feed/route" -> "feed/route", "src/lib/store.ts" -> "store.ts". */
export function candidateName(c: string): string {
  const parts = c.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? c;
  if ((last === "route" || last === "page") && parts.length > 1) return `${parts[parts.length - 2]}/${last}`;
  return last;
}

type EpochNaming = Pick<EpochView, "id" | "files" | "deleted" | "moreFiles" | "via" | "candidates">;

/**
 * What an edit is called on the rail, the strip and the toast: the file saved ("store.ts", or
 * "store.ts +2" for several), else the rebuilt chunks as candidates ("one of: feed/route, store.ts"),
 * else "rebuild" (nothing to attribute it to). Epoch 0 is the session start.
 */
export function epochLabel(e: EpochNaming): string {
  if (e.id === 0 || e.via === "start") return "session start";
  const files = [...e.files, ...e.deleted];
  if (files.length > 0) {
    const extra = files.length - 1 + (e.moreFiles ?? 0);
    const first = baseName(files[0] as string);
    return extra > 0 ? `${first} +${extra}` : first;
  }
  if (e.candidates.length === 1) return candidateName(e.candidates[0] as string);
  if (e.candidates.length > 1) {
    const names = [...new Set(e.candidates.map(candidateName))];
    if (names.length === 1) return names[0] as string;
    return `one of: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ", …" : ""}`;
  }
  return "rebuild";
}

/**
 * An edit of this dev session: not a session start (e0, or the start marker a restart writes) and not
 * restored from an earlier session (`persist: true` tags those with `session`). Pure.
 */
export function isSessionEdit(id: number, info?: Pick<EpochView, "via" | "session">): boolean {
  return id > 0 && info?.via !== "start" && info?.session === undefined;
}

/**
 * Requests per epoch: the retained ones, or the server's per-route epoch counts when those say more
 * (they survive ring eviction and a restart with `persist: true`). Pure.
 */
export function requestsByEpoch(
  traces: readonly Pick<TraceSummary, "kind" | "facts">[],
  serverRoutes?: readonly { epochs: readonly { epoch: number; count: number }[] }[],
): Map<number, number> {
  const local = new Map<number, number>();
  for (const t of traces) {
    const e = t.facts?.epoch;
    if (e === undefined || t.kind === "asset") continue;
    local.set(e, (local.get(e) ?? 0) + 1);
  }
  const server = new Map<number, number>();
  for (const r of serverRoutes ?? [])
    for (const e of r.epochs) server.set(e.epoch, (server.get(e.epoch) ?? 0) + e.count);
  const out = new Map(local);
  for (const [e, n] of server) if (n > (out.get(e) ?? 0)) out.set(e, n);
  return out;
}

/** How the files were found, for the Changes row: "(saved)", "(from rebuilt chunks)", ... */
export function viaLabel(e: Pick<EpochView, "via">): string {
  switch (e.via) {
    case "src-watch":
      return "saved";
    case "chunk-diff":
      return "from rebuilt code";
    case "candidates":
      return "candidates from rebuilt chunks";
    case "start":
      return "session start";
    default:
      return "not attributed";
  }
}

/** A coarse span: "12s", "3m", "2h" (never negative). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** "12s ago", "3m ago", "2h ago". */
export function ago(ms: number, now: number): string {
  return `${elapsed(now - ms)} ago`;
}

/** The `since` route param ("7", later "3:7") as an epoch number; undefined when absent or bad. */
export function sinceNumber(since: string | undefined): number | undefined {
  if (since === undefined || since === "") return undefined;
  const n = Number(since.split(":").pop());
  return Number.isFinite(n) ? n : undefined;
}

export function regressionId(r: Pick<RouteRegression, "key" | "epoch">): string {
  return `${r.key}@${r.epoch}`;
}

/**
 * Keep every verdict seen this session: the server only judges the epochs it still keeps per route
 * (5), so an older edit's verdict would vanish from Changes as you keep editing. A fresh response
 * replaces the same (route, epoch); "no-traffic" rows are only true for the latest edit, so after a
 * full response (GET /api/regressions) the ones it no longer reports are dropped. A `partial` update
 * (one SSE `regression` event) keeps them. Capped at `max` rows, oldest epochs first out.
 */
export function mergeRegressions(
  prev: ReadonlyMap<string, RouteRegression>,
  items: readonly RouteRegression[],
  opts: { partial?: boolean; max?: number } = {},
): Map<string, RouteRegression> {
  const max = opts.max ?? 2000;
  const next = new Map<string, RouteRegression>();
  for (const [id, r] of prev) if (opts.partial || r.status !== "no-traffic") next.set(id, r);
  for (const r of items) next.set(regressionId(r), r);
  if (next.size > max) {
    const oldest = [...next.values()].sort((a, b) => a.epoch - b.epoch).slice(0, next.size - max);
    for (const r of oldest) next.delete(regressionId(r));
  }
  return next;
}

/**
 * Is this verdict's route one the edit affects? Only answerable when the bundler or the import graph
 * named the routes (routesVia "chunks" / "imports"); otherwise (or with the edit unknown) every
 * verdict counts. A route outside the edit moving is traffic drift, not the edit's doing.
 */
export function isAffected(
  r: Pick<RouteRegression, "route">,
  info: Pick<EpochView, "routes" | "routesVia"> | undefined,
): boolean {
  if (!info || (info.routesVia !== "chunks" && info.routesVia !== "imports")) return true;
  return info.routes.includes(r.route);
}

/** Split each edit's verdicts into the routes it affects and the rest (see isAffected). Pure. */
export function splitAffected(
  byEpoch: ReadonlyMap<number, readonly RouteRegression[]>,
  infos: ReadonlyMap<number, Pick<EpochView, "routes" | "routesVia">>,
): { affected: Map<number, RouteRegression[]>; other: Map<number, RouteRegression[]> } {
  const affected = new Map<number, RouteRegression[]>();
  const other = new Map<number, RouteRegression[]>();
  for (const [id, list] of byEpoch) {
    const info = infos.get(id);
    const a: RouteRegression[] = [];
    const o: RouteRegression[] = [];
    for (const r of list) (isAffected(r, info) ? a : o).push(r);
    if (a.length) affected.set(id, a);
    if (o.length) other.set(id, o);
  }
  return { affected, other };
}

/** Order inside one edit: what got worse first, then faster, unchanged, waiting for traffic. */
export const STATUS_RANK: Record<RegressionStatus, number> = {
  regressed: 0,
  improved: 1,
  unchanged: 2,
  insufficient: 3,
  "no-traffic": 4,
};

/** Verdicts grouped by the epoch they judge, each group worst first, then by route. */
/**
 * Credit the edit that undid a regression. Core judges each edit against the route's last good
 * baseline, so a revert after a regressed e5 reads "unchanged" vs e4: when an unchanged / improved
 * verdict's route regressed at an epoch between its baseline and itself, it gets `fixes` = that
 * (newest) epoch. Pure.
 */
export function annotateFixes(items: Iterable<RouteRegression>): RouteRegression[] {
  const list = [...items];
  const regressed = new Map<string, number[]>();
  for (const r of list) if (r.status === "regressed") regressed.set(r.key, [...(regressed.get(r.key) ?? []), r.epoch]);
  return list.map((r) => {
    if ((r.status !== "unchanged" && r.status !== "improved") || r.baselineEpoch === undefined) return r;
    const base = r.baselineEpoch;
    const between = (regressed.get(r.key) ?? []).filter((e) => e > base && e < r.epoch);
    return between.length ? { ...r, fixes: Math.max(...between) } : r;
  });
}

export function regressionsByEpoch(items: Iterable<RouteRegression>): Map<number, RouteRegression[]> {
  const out = new Map<number, RouteRegression[]>();
  for (const r of items) {
    const list = out.get(r.epoch);
    if (list) list.push(r);
    else out.set(r.epoch, [r]);
  }
  for (const list of out.values())
    list.sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        (b.deltaMs ?? 0) - (a.deltaMs ?? 0) ||
        a.key.localeCompare(b.key),
    );
  return out;
}

export function pctText(p: number | undefined): string | undefined {
  if (p === undefined || !Number.isFinite(p)) return undefined;
  const v = Math.round(p * 100);
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v)}%`;
}

export type RegressionTone = "worse" | "better" | "same" | "none";

/** One verdict as the words the Changes table, the strip and the toast print. */
export interface RegressionText {
  /** ! regressed, - faster, = unchanged, ~ too few requests, ? no traffic since the edit. */
  glyph: "!" | "-" | "=" | "~" | "?";
  tone: RegressionTone;
  /** "41ms -> 96ms" */
  p50?: string;
  /** "+134%" */
  pct?: string;
  /** Largest I/O count change: "db 1 -> 50". */
  io?: string;
  /** Bucket that grew most: "db +52ms". */
  grew?: string;
  /** "n 6|7" (warm requests before | after). */
  n?: string;
  /** "low confidence", "no traffic since edit", "needs 3 warm requests (n 1)". */
  note?: string;
}

const IO_LABEL: Record<"db" | "fetch" | "cache" | "fn", string> = {
  db: "db",
  fetch: "fetch",
  cache: "cache",
  fn: "fn",
};

/** "db 1 -> 50": the I/O count that changed most, rounded; undefined when none moved by 1+. */
export function ioDelta(io: RouteRegression["io"]): string | undefined {
  if (!io) return undefined;
  let best: { k: keyof typeof IO_LABEL; before: number; after: number; d: number } | undefined;
  for (const k of ["db", "fetch", "cache"] as const) {
    const v = io[k];
    if (!v) continue;
    const before = Math.round(v.before);
    const after = Math.round(v.after);
    const d = Math.abs(after - before);
    if (d >= 1 && (!best || d > best.d)) best = { k, before, after, d };
  }
  return best ? `${IO_LABEL[best.k]} ${best.before} -> ${best.after}` : undefined;
}

export function describeRegression(r: RouteRegression, minN = 3): RegressionText {
  const n = r.before && r.after ? `n ${r.before.n}|${r.after.n}` : r.after ? `n ${r.after.n}` : undefined;
  const p50 =
    r.before?.p50 !== undefined && r.after?.p50 !== undefined
      ? `${fmtMs(r.before.p50)} -> ${fmtMs(r.after.p50)}`
      : undefined;
  switch (r.status) {
    case "regressed":
    case "improved": {
      const worse = r.status === "regressed";
      const grew =
        worse && r.grew && r.grew.deltaMs >= 1
          ? `${BUCKET_LABELS[r.grew.bucket as TimeBucket] ?? r.grew.bucket} +${fmtMs(r.grew.deltaMs)}`
          : undefined;
      return {
        glyph: worse ? "!" : "-",
        tone: worse ? "worse" : "better",
        p50,
        pct: pctText(r.deltaPct),
        io: ioDelta(r.io),
        grew,
        n,
        note:
          r.fixes !== undefined
            ? `fixed the e${r.fixes} regression${r.lowConfidence ? ", low confidence" : ""}`
            : r.lowConfidence
              ? "low confidence"
              : undefined,
      };
    }
    case "unchanged":
      if (r.fixes !== undefined)
        return {
          glyph: "-",
          tone: "better",
          p50,
          n,
          note: `back to e${r.baselineEpoch}: fixed the e${r.fixes} regression`,
        };
      return { glyph: "=", tone: "same", p50, n, note: r.lowConfidence ? "unchanged, low confidence" : "unchanged" };
    case "insufficient":
      return {
        glyph: "~",
        tone: "none",
        n,
        note: `needs ${minN} warm requests after the edit (has ${r.after?.n ?? 0})`,
      };
    default:
      return { glyph: "?", tone: "none", note: "no traffic since edit" };
  }
}

/* ---------------------------------------------------------------- the toast */

export interface RebuildToast {
  epoch: number;
  /** Regressed routes in that edit, in arrival order (deduped by route key). */
  items: RouteRegression[];
  /** Name of the edit ("store.ts"), or "e7" when it isn't known yet. */
  label: string;
  at: number;
}

/**
 * Fold a `regression` event into the toast (plan 3.5: shown only when a regression is detected). A
 * regression of the same edit joins the open toast; a newer edit replaces it; an older one is ignored.
 */
export function foldToast(
  prev: RebuildToast | null,
  r: RouteRegression,
  label: string | undefined,
  now: number,
): RebuildToast | null {
  if (r.status !== "regressed") {
    // A re-judge flipped a route the toast names (more traffic: "+38%" became "unchanged"): drop it.
    if (!prev || prev.epoch !== r.epoch || !prev.items.some((x) => x.key === r.key)) return prev;
    const items = prev.items.filter((x) => x.key !== r.key);
    return items.length ? { ...prev, items } : null;
  }
  if (prev && r.epoch < prev.epoch) return prev;
  if (prev && prev.epoch === r.epoch) {
    const i = prev.items.findIndex((x) => x.key === r.key);
    if (i < 0) return { ...prev, items: [...prev.items, r], at: now };
    const cur = prev.items[i] as RouteRegression;
    if (cur.deltaPct === r.deltaPct && cur.deltaMs === r.deltaMs) return prev;
    const items = [...prev.items];
    items[i] = r; // same regression, new numbers
    return { ...prev, items };
  }
  return { epoch: r.epoch, items: [r], label: label ?? `e${r.epoch}`, at: now };
}

/**
 * Re-check the open toast against the latest verdicts (after GET /api/regressions): routes no longer
 * regressed leave it (null when none is left), the rest take the fresh numbers. A verdict missing
 * from `verdicts` leaves its item as it is.
 */
export function reconcileToast(
  prev: RebuildToast | null,
  verdicts: ReadonlyMap<string, RouteRegression>,
): RebuildToast | null {
  if (!prev) return prev;
  let next: RebuildToast | null = prev;
  for (const x of prev.items) {
    const v = verdicts.get(regressionId(x));
    if (v && v !== x) next = foldToast(next, v, prev.label, prev.at);
  }
  return next;
}

/** "store.ts rebuilt · /api/products +134%" (plus "and 2 more"). */
export function toastText(t: RebuildToast): string {
  const first = t.items[0];
  if (!first) return `${t.label} rebuilt`;
  const d = pctText(first.deltaPct) ?? (first.deltaMs !== undefined ? `+${fmtMs(first.deltaMs)}` : "slower");
  const more = t.items.length > 1 ? ` and ${t.items.length - 1} more` : "";
  return `${t.label} rebuilt · ${first.route} ${d}${more}`;
}

/* ------------------------------------------------------------------ timeline */

export type DotTone = "ok" | "slow" | "error";

export interface TimelineTick {
  id: number;
  /** 0..1 across the track. */
  x: number;
  at: number;
  label: string;
  /** Draw the label (ticks closer than `minLabelGap` to a labelled newer one stay unlabelled). */
  showLabel: boolean;
  regressed: boolean;
  improved: boolean;
}

export interface TimelineDot {
  id: string;
  x: number;
  tone: DotTone;
}

export interface Timeline {
  t0: number;
  t1: number;
  /** The axis ends at `now`; false when the session went quiet and the axis stops at its last activity. */
  endsNow: boolean;
  ticks: TimelineTick[];
  dots: TimelineDot[];
}

/**
 * A request's dot colour: error (5xx or an exception), slow (over twice its route's median and 20ms
 * past it, among the requests given), else ok.
 */
export function dotTones(traces: readonly TraceSummary[]): Map<string, DotTone> {
  const byRoute = new Map<string, number[]>();
  for (const t of traces) {
    if (t.duration === undefined || t.facts?.cold) continue;
    const k = routeKeyOf(t);
    const list = byRoute.get(k);
    if (list) list.push(t.duration);
    else byRoute.set(k, [t.duration]);
  }
  const median = new Map<string, number>();
  for (const [k, list] of byRoute) {
    list.sort((a, b) => a - b);
    median.set(k, list[Math.floor((list.length - 1) / 2)] as number);
  }
  const out = new Map<string, DotTone>();
  for (const t of traces) {
    if (isError(t) || t.error) out.set(t.id, "error");
    else {
      const m = median.get(routeKeyOf(t));
      const slow = m !== undefined && t.duration !== undefined && t.duration > Math.max(2 * m, m + 20);
      out.set(t.id, slow ? "slow" : "ok");
    }
  }
  return out;
}

/**
 * The Changes track: epochs as ticks and requests as dots on one time axis (session start .. now).
 * x is a 0..1 fraction so the SVG scales without measuring. Assets and unfinished requests are left
 * out; at most `maxDots` of the newest requests are drawn.
 */
export function buildTimeline(
  epochs: readonly Pick<EpochView, "id" | "at" | "files" | "deleted" | "moreFiles" | "via" | "candidates">[],
  traces: readonly TraceSummary[],
  verdicts: ReadonlyMap<number, readonly RouteRegression[]>,
  now: number,
  opts: { maxDots?: number; minLabelGap?: number } = {},
): Timeline {
  const maxDots = opts.maxDots ?? 600;
  const gap = opts.minLabelGap ?? 0.07;
  const reqs = traces.filter((t) => t.done && t.kind !== "asset").slice(0, maxDots);
  let t0 = Number.POSITIVE_INFINITY;
  for (const e of epochs) if (e.at > 0) t0 = Math.min(t0, e.at);
  for (const t of reqs) t0 = Math.min(t0, t.startedAt);
  if (!Number.isFinite(t0)) t0 = now - 60_000;
  let last = t0;
  for (const e of epochs) last = Math.max(last, e.at);
  for (const t of reqs) last = Math.max(last, t.startedAt);
  const span = Math.max(1000, last - t0);
  // A quiet stretch longer than the session itself would squeeze every tick to the left: stop the
  // axis shortly after the last activity instead of at now (the label says so).
  const endsNow = now - last <= Math.max(span, 60_000);
  let t1 = endsNow ? Math.max(now, last) : last + span * 0.05;
  if (t1 - t0 < 1000) t1 = t0 + 1000;
  const xOf = (t: number) => Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));

  const asc = [...epochs].sort((a, b) => a.id - b.id);
  const ticks: TimelineTick[] = asc.map((e) => {
    const v = verdicts.get(e.id) ?? [];
    return {
      id: e.id,
      x: xOf(e.at > 0 ? e.at : t0),
      at: e.at,
      label: `e${e.id} ${epochLabel(e)}`,
      showLabel: false,
      regressed: v.some((r) => r.status === "regressed"),
      improved: v.some((r) => r.status === "improved"),
    };
  });
  // Label from the newest backwards, regressed ticks first; a tick closer than `gap` to a labelled one
  // stays bare (its name is in the tooltip and the table), so labels never overlap.
  const labelled: number[] = [];
  const free = (x: number) => labelled.every((l) => Math.abs(l - x) >= gap);
  for (const pass of [true, false])
    for (let i = ticks.length - 1; i >= 0; i--) {
      const t = ticks[i] as TimelineTick;
      if (t.regressed !== pass || !free(t.x)) continue;
      t.showLabel = true;
      labelled.push(t.x);
    }
  const tones = dotTones(reqs);
  const dots = reqs.map((t) => ({ id: t.id, x: xOf(t.startedAt), tone: tones.get(t.id) ?? "ok" }));
  return { t0, t1, endsNow, ticks, dots };
}

/** Room one Changes tick label takes ("e12 store.ts…": up to ~22 mono characters). */
const TICK_LABEL_PX = 150;

/** Minimum distance between labelled ticks, as a fraction of the track (0.07 before it is measured). Pure. */
export function labelGap(widthPx: number): number {
  return widthPx > 0 ? Math.max(0.07, TICK_LABEL_PX / widthPx) : 0.07;
}

/** The epoch in effect at time `t` (the newest that started at or before it; else the oldest). */
export function epochAt(epochs: readonly Pick<EpochView, "id" | "at">[], t: number): number | undefined {
  let best: Pick<EpochView, "id" | "at"> | undefined;
  let oldest: Pick<EpochView, "id" | "at"> | undefined;
  for (const e of epochs) {
    if (!oldest || e.id < oldest.id) oldest = e;
    if (e.at <= t && (!best || e.at > best.at || (e.at === best.at && e.id > best.id))) best = e;
  }
  return (best ?? oldest)?.id;
}

/** Ids for e / E stepping: the server's edits plus any epoch seen on a retained request, ascending. */
export function knownEpochIds(epochs: readonly Pick<EpochView, "id">[], traces: readonly TraceSummary[]): number[] {
  const set = new Set<number>();
  for (const e of epochs) set.add(e.id);
  for (const t of traces) {
    const e = t.facts?.epoch;
    if (e !== undefined && t.kind !== "asset") set.add(e);
  }
  return [...set].sort((a, b) => a - b);
}

/* ----------------------------------------------------------- row actions */

/** The retained warm request of `key` in `epoch` closest to `p50` (the epoch's typical one). */
function typicalIn(traces: readonly TraceSummary[], key: string, epoch: number, p50: number | undefined) {
  let best: TraceSummary | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const t of traces) {
    if (!t.done || t.duration === undefined || t.facts?.epoch !== epoch || t.facts.cold) continue;
    if (routeKeyOf(t) !== key) continue;
    const d = p50 === undefined ? -t.startedAt : Math.abs(t.duration - p50);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/**
 * "Compare pair" for a verdict: a typical retained request before the edit (baseline epoch) as A
 * and after it as B, each the one closest to its side's p50. undefined when either side is gone.
 */
export function comparePair(
  r: Pick<RouteRegression, "key" | "epoch" | "baselineEpoch" | "before" | "after">,
  traces: readonly TraceSummary[],
): { a: string; b: string } | undefined {
  if (r.baselineEpoch === undefined) return undefined;
  const a = typicalIn(traces, r.key, r.baselineEpoch, r.before?.p50);
  const b = typicalIn(traces, r.key, r.epoch, r.after?.p50);
  return a && b ? { a: a.id, b: b.id } : undefined;
}

/**
 * What "Replay x10" sends for a verdict's route: the newest retained request's URL (path + query)
 * for that method and route, else the route itself when it has no dynamic segment. GET/HEAD only:
 * a repeated write needs the builder's confirmation (WP7). undefined = can't replay from here.
 */
export function replayPath(
  r: Pick<RouteRegression, "key" | "method" | "route">,
  traces: readonly TraceSummary[],
): string | undefined {
  if (r.method !== "GET" && r.method !== "HEAD") return undefined;
  for (const t of traces) if (t.kind !== "asset" && routeKeyOf(t) === r.key && t.url) return t.url;
  return r.route.includes("[") ? undefined : r.route;
}

/* --------------------------------------------------------------- since scope */

/** Weighted mean of per-epoch averages (`w` = the weight of each). */
function weighted(
  list: readonly EpochStats[],
  get: (e: EpochStats) => number | undefined,
  w: (e: EpochStats) => number,
) {
  let sum = 0;
  let n = 0;
  for (const e of list) {
    const v = get(e);
    const k = w(e);
    if (v === undefined || k <= 0) continue;
    sum += v * k;
    n += k;
  }
  return n > 0 ? sum / n : undefined;
}

/**
 * Several epochs of one route as one aggregate (the since scope's numbers): counts summed,
 * percentiles from the merged histograms, averages weighted by their sample, findings summed by
 * fingerprint. undefined for an empty list.
 */
export function mergeEpochStats(list: readonly EpochStats[]): EpochStats | undefined {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const p = mergedPercentiles(list);
  const sum = (f: (e: EpochStats) => number) => list.reduce((s, e) => s + f(e), 0);
  const warmW = (e: EpochStats) => e.warm;
  const countW = (e: EpochStats) => e.count;
  let time: Record<TimeBucket, number> | undefined;
  for (const e of list) {
    if (!e.time) continue;
    time ??= {} as Record<TimeBucket, number>;
    for (const k of Object.keys(e.time) as TimeBucket[]) time[k] = 0;
  }
  if (time) for (const k of Object.keys(time) as TimeBucket[]) time[k] = weighted(list, (e) => e.time?.[k], warmW) ?? 0;
  const ioList = list.filter((e) => e.io);
  const io = ioList.length
    ? {
        db: weighted(ioList, (e) => e.io?.db, countW) ?? 0,
        fetch: weighted(ioList, (e) => e.io?.fetch, countW) ?? 0,
        cache: weighted(ioList, (e) => e.io?.cache, countW) ?? 0,
        fn: weighted(ioList, (e) => e.io?.fn, countW) ?? 0,
      }
    : undefined;
  const findings = new Map<string, FindingCount>();
  for (const e of list)
    for (const f of e.findings) {
      const cur = findings.get(f.fingerprint);
      findings.set(f.fingerprint, cur ? { ...cur, count: cur.count + f.count } : { ...f });
    }
  const kinds = list.every((e) => e.errorKinds)
    ? list.reduce<ErrorKinds>(
        (k, e) => ({
          fivexx: k.fivexx + (e.errorKinds?.fivexx ?? 0),
          thrown: k.thrown + (e.errorKinds?.thrown ?? 0),
          swallowed: k.swallowed + (e.errorKinds?.swallowed ?? 0),
        }),
        { fivexx: 0, thrown: 0, swallowed: 0 },
      )
    : undefined;
  const mins = list.map((e) => e.min).filter((v): v is number => v !== undefined);
  const maxs = list.map((e) => e.max).filter((v): v is number => v !== undefined);
  const buckets: HistogramBucket[] | undefined = list.some((e) => e.buckets)
    ? mergeBuckets(list.map((e) => e.buckets))
    : undefined;
  const out: EpochStats = {
    epoch: Math.max(...list.map((e) => e.epoch)),
    count: sum((e) => e.count),
    errors: sum((e) => e.errors),
    cold: sum((e) => e.cold),
    warm: sum((e) => e.warm),
    p50: p.p50,
    p95: p.p95,
    min: mins.length ? Math.min(...mins) : undefined,
    max: maxs.length ? Math.max(...maxs) : undefined,
    avg: weighted(list, (e) => e.avg, warmW),
    time,
    io,
    findings: [...findings.values()],
    firstSeen: Math.min(...list.map((e) => e.firstSeen)),
    lastSeen: Math.max(...list.map((e) => e.lastSeen)),
    buckets,
  };
  if (kinds) out.errorKinds = kinds;
  return out;
}

export interface ScopedStats {
  stats: StatsResponse;
  /**
   * Some route had traffic in epochs the server no longer keeps per route (it keeps 5), and the scope
   * reaches back into them: its counts for the scope are a lower bound.
   */
  partial: boolean;
}

/**
 * /api/stats narrowed to "since edit `since`": each route's kept epochs at or after it, merged into
 * `all`; routes with no traffic in the scope are dropped; totals re-summed. Pure.
 */
export function scopeStatsSince(s: StatsResponse, since: number): ScopedStats {
  let partial = false;
  const routes: ServerRouteStats[] = [];
  for (const r of s.routes) {
    const kept = r.epochs.filter((e) => e.epoch >= since);
    // Core counts the requests of the epochs it dropped (`evicted`): when the scope reaches back past
    // the oldest kept epoch and some were dropped, they may have been in scope.
    if (r.epochs.length > 0 && (r.evicted ?? 0) > 0) {
      const oldestKept = Math.min(...r.epochs.map((e) => e.epoch));
      if (since < oldestKept) partial = true;
    }
    const all = mergeEpochStats(kept);
    if (!all) continue;
    const exemplars =
      r.exemplars &&
      r.exemplars.fast.epoch >= since &&
      r.exemplars.typical.epoch >= since &&
      r.exemplars.slow.epoch >= since
        ? r.exemplars
        : undefined;
    routes.push({ ...r, all, epochs: kept, exemplars });
  }
  let requests = 0;
  let errors = 0;
  let cold = 0;
  let kinds: ErrorKinds | undefined = { fivexx: 0, thrown: 0, swallowed: 0 };
  for (const r of routes) {
    requests += r.all.count;
    errors += r.all.errors;
    cold += r.all.cold;
    const k = r.all.errorKinds;
    if (k && kinds)
      kinds = {
        fivexx: kinds.fivexx + k.fivexx,
        thrown: kinds.thrown + k.thrown,
        swallowed: kinds.swallowed + k.swallowed,
      };
    else kinds = undefined;
  }
  const totals = { ...s.totals, requests, errors, cold, routes: routes.length };
  if (kinds) totals.errorKinds = kinds;
  else totals.errorKinds = undefined;
  return { stats: { ...s, routes, totals }, partial };
}

/** Requests in the since scope (epoch >= since). Assets stay in: the caller filters further. */
export function tracesSince<T extends Pick<TraceSummary, "facts">>(list: readonly T[], since: number): T[] {
  return list.filter((t) => (t.facts?.epoch ?? -1) >= since);
}

/* ============================================================ state + live */

export type EpochsLoad = "idle" | "loading" | "ready" | "error" | "unavailable";

/** GET /api/epochs, kept up to date by the `epoch` SSE event. */
export const epochsData = signal<EpochsResponse | null>(null);
export const epochsState = signal<EpochsLoad>("idle");
/** Every verdict seen this session, by `key@epoch` (see mergeRegressions). */
export const regressionMap = signal<ReadonlyMap<string, RouteRegression>>(new Map());
export const regressionRule = signal<RegressionsResponse["rule"] | null>(null);
export const rebuildToast = signal<RebuildToast | null>(null);
/** Wall clock for "12s ago" labels, ticking while the rail is mounted. */
export const nowTick = signal(Date.now());

/** Edits, oldest first. */
export const epochList = computed<EpochView[]>(() => [...(epochsData.value?.items ?? [])].sort((a, b) => a.id - b.id));
export const epochById = computed(() => new Map(epochList.value.map((e) => [e.id, e])));
const verdictSplit = computed(() =>
  splitAffected(regressionsByEpoch(annotateFixes(regressionMap.value.values())), epochById.value),
);
/**
 * Each edit's verdicts for the routes it affects (every verdict when the edit's routes aren't known).
 * This is what the rail, the track, the strip, Changes and the toast judge an edit by.
 */
export const verdictsByEpoch = computed(() => verdictSplit.value.affected);
/** Verdicts for routes the edit doesn't touch (traffic drift); Changes lists them muted. */
export const otherVerdictsByEpoch = computed(() => verdictSplit.value.other);
/** The newest edit after the session start, if any. */
export const latestEdit = computed<EpochView | undefined>(() => {
  const list = epochList.value;
  const last = list[list.length - 1];
  return last && last.id > 0 ? last : undefined;
});

export function labelOfEpoch(id: number): string {
  const e = epochById.peek().get(id);
  return e ? epochLabel(e) : `e${id}`;
}

const API = "/__hoplens/api";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const err = new Error(`${res.status} ${path}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function refreshEpochs(): Promise<void> {
  if (epochsState.value === "unavailable") return;
  if (!epochsData.value) epochsState.value = "loading";
  try {
    epochsData.value = await getJson<EpochsResponse>("/epochs");
    epochsState.value = "ready";
  } catch (err) {
    // 404: a core without WP9a. Stop asking; the rail falls back to the epochs on requests.
    epochsState.value = (err as { status?: number }).status === 404 ? "unavailable" : "error";
  }
}

export async function refreshRegressions(): Promise<void> {
  if (epochsState.value === "unavailable") return;
  try {
    const res = await getJson<RegressionsResponse>("/regressions");
    regressionRule.value = res.rule;
    regressionMap.value = mergeRegressions(regressionMap.peek(), res.items);
    const toast = reconcileToast(rebuildToast.peek(), regressionMap.peek());
    if (toast !== rebuildToast.peek()) {
      if (toast) rebuildToast.value = toast;
      else dismissToast();
    }
  } catch {
    /* keep the last verdicts */
  }
}

const scheduleRegressions = throttle(() => void refreshRegressions(), 2000);

function upsertEpoch(view: EpochView): void {
  const cur = epochsData.peek();
  const items = (cur?.items ?? []).filter((e) => e.id !== view.id);
  items.unshift(view);
  items.sort((a, b) => b.id - a.id);
  epochsData.value = {
    epoch: Math.max(cur?.epoch ?? 0, view.id),
    sourceWatch: cur?.sourceWatch ?? false,
    items: items.slice(0, 50),
  };
}

let users = 0;
let stop: (() => void) | null = null;

/**
 * Load the edits and verdicts and follow /api/epochs/events. Ref-counted: the first caller starts
 * it, the last disposer stops it.
 */
export function startEpochs(): () => void {
  users++;
  if (users === 1) stop = connect();
  return () => {
    users--;
    if (users === 0) {
      stop?.();
      stop = null;
    }
  };
}

const TOAST_MS = 12_000;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Hide the toast after a while; `hold` (pointer on it) postpones that. */
export function scheduleToastHide(hold = false): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (hold || !rebuildToast.peek()) return;
  toastTimer = setTimeout(() => {
    rebuildToast.value = null;
    toastTimer = null;
  }, TOAST_MS);
}

export function dismissToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  rebuildToast.value = null;
}

function connect(): () => void {
  void refreshEpochs().then(() => refreshRegressions());
  let source: EventSource | null = null;
  if (typeof EventSource !== "undefined") {
    source = new EventSource(`${API}/epochs/events`);
    // Every (re)connect: catch up on what was missed while away.
    source.addEventListener("hello", () => {
      void refreshEpochs();
      scheduleRegressions();
    });
    source.addEventListener("epoch", (e) => {
      try {
        upsertEpoch(JSON.parse((e as MessageEvent).data) as EpochView);
        if (epochsState.peek() !== "ready") epochsState.value = "ready";
      } catch {
        /* malformed */
      }
      scheduleRegressions();
    });
    source.addEventListener("regression", (e) => {
      let r: RouteRegression;
      try {
        r = JSON.parse((e as MessageEvent).data) as RouteRegression;
      } catch {
        return;
      }
      regressionMap.value = mergeRegressions(regressionMap.peek(), [r], { partial: true });
      // A slower route the edit doesn't touch is drift, not the edit's doing: no toast for it.
      if (r.status === "regressed" && !isAffected(r, epochById.peek().get(r.epoch))) return;
      const prev = rebuildToast.peek();
      const next = foldToast(prev, r, labelOfEpoch(r.epoch), Date.now());
      if (next === prev) return;
      if (!next) dismissToast();
      else {
        rebuildToast.value = next;
        // Only a new regression restarts the timer; a flip or fresh numbers keep it running.
        if (!prev || next.at !== prev.at) scheduleToastHide();
      }
    });
    source.onerror = () => {
      // A core without the stream answers 404: EventSource gives up (CLOSED). Nothing else to do;
      // a transient drop reconnects by itself and `hello` catches up.
    };
  }
  // New traffic moves the p50s: re-judge (throttled). Clear empties the server's verdicts too.
  const stopActivity = effect(() => {
    if (liveActivity.value === 0) return;
    scheduleRegressions();
  });
  const stopClear = effect(() => {
    if (clearedAt.value === 0) return;
    regressionMap.value = new Map();
    dismissToast();
  });
  const clock = setInterval(() => {
    nowTick.value = Date.now();
  }, 5000);
  return () => {
    source?.close();
    stopActivity();
    stopClear();
    clearInterval(clock);
    scheduleRegressions.cancel();
  };
}
