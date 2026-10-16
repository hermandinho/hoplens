import type http from "node:http";
import type { EpochInfo } from "../epoch";
import { ImportGraph } from "../importgraph";
import { type AffectedRoutes, RegressionTracker, type RegressionsResponse, type RouteRegression } from "../regressions";
import type { Runtime } from "../runtime";
import type { TraceRecord } from "../types";
import { type ApiEndpoint, type ApiHandle, sendJson } from "./module";

/*
 * Epochs, attribution and regressions (plan 3.5 / WP9a).
 *
 *   GET /api/epochs              -> EpochsResponse   (?limit=N, newest first)
 *   GET /api/regressions         -> RegressionsResponse (?epoch=N, ?status=regressed|improved|...)
 *   GET /api/epochs/events       -> SSE: `event: epoch` (EpochView) on every rebuild, and
 *                                   `event: regression` (RouteRegression) the first time a route in the
 *                                   newest epoch is judged regressed (drives the rebuild toast).
 *
 * The SSE stream is its own endpoint because /api/events lives in server.ts, which work packages
 * only touch with one registration line. All work happens in handlers or after the response
 * finished; nothing here runs on the request path.
 */

/** How the affected routes of an epoch were found. */
export type AffectedVia =
  /** Import closure of each route file contains a changed source file. */
  | "imports"
  /** Route files named by rebuilt chunks (no source change seen). */
  | "candidates"
  | "none";

export interface EpochView extends EpochInfo {
  /** Route templates ("/api/orders/[id]") the change affects, sorted. */
  routes: string[];
  routesVia: AffectedVia;
}

export interface EpochsResponse {
  /** Newest epoch. */
  epoch: number;
  /** True when source files are being watched (attribution via "src-watch" is possible). */
  sourceWatch: boolean;
  /** Newest first. */
  items: EpochView[];
}

const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_ANNOUNCED = 500;
/** Coalesces `done` events into one regression check while a stream client is connected. */
const CHECK_DELAY_MS = 150;

type Subscriber = (event: "epoch" | "regression", data: unknown) => void;

class EpochsService {
  readonly regressions = new RegressionTracker();
  private readonly graph: ImportGraph;
  private readonly affectedCache = new Map<number, { routes: string[]; via: AffectedVia }>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly announced = new Set<string>();
  private checkTimer: NodeJS.Timeout | undefined;

  constructor(private readonly rt: Runtime) {
    this.graph = new ImportGraph(rt.root);
    rt.epochs.onEpoch((info) => {
      // Off the finalize path: attribution walks the import graph.
      setImmediate(() => this.onBump(info)).unref?.();
    });
    rt.store.on("clear", () => {
      this.regressions.clear();
      this.announced.clear();
    });
  }

  view(info: EpochInfo): EpochView {
    const a = this.affected(info);
    return { ...info, routes: a.routes, routesVia: a.via };
  }

  list(limit?: number): EpochsResponse {
    const infos = this.rt.epochs.list().reverse();
    const items = (limit ? infos.slice(0, limit) : infos).map((i) => this.view(i));
    return { epoch: this.rt.epochs.epoch, sourceWatch: this.rt.epochs.watchingSources, items };
  }

  evaluate(): RegressionsResponse {
    return this.regressions.evaluate(this.rt.stats.snapshot(), this.latestAffected());
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    if (this.subscribers.size === 1) this.rt.store.on("done", this.onDone);
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) {
        this.rt.store.off("done", this.onDone);
        if (this.checkTimer) clearTimeout(this.checkTimer);
        this.checkTimer = undefined;
      }
    };
  }

  private latestAffected(): AffectedRoutes | undefined {
    const id = this.rt.epochs.epoch;
    const info = id > 0 ? this.rt.epochs.info(id) : undefined;
    if (!info) return undefined;
    const routes = new Set(this.affected(info).routes);
    if (!routes.size) return undefined;
    const out: AffectedRoutes = { epoch: id, routes: [] };
    for (const r of this.rt.discover().routes) {
      if (!routes.has(r.nextRoute)) continue;
      const methods = [...new Set(r.methods.map((m) => (m.method === "ANY" ? "GET" : m.method)))].filter((m) =>
        ROUTE_METHODS.has(m),
      );
      out.routes.push({ route: r.nextRoute, methods: methods.length ? methods : ["GET"] });
    }
    return out;
  }

  private affected(info: EpochInfo): { routes: string[]; via: AffectedVia } {
    const hit = this.affectedCache.get(info.id);
    if (hit) return hit;
    let result: { routes: string[]; via: AffectedVia } = { routes: [], via: "none" };
    try {
      result = this.computeAffected(info);
    } catch {
      /* attribution is best effort */
    }
    this.affectedCache.set(info.id, result);
    // Same ring size as the tracker (50): drop the oldest.
    if (this.affectedCache.size > 64) {
      const oldest = this.affectedCache.keys().next().value;
      if (oldest !== undefined) this.affectedCache.delete(oldest);
    }
    return result;
  }

  private computeAffected(info: EpochInfo): { routes: string[]; via: AffectedVia } {
    if (info.id === 0 || (!info.files.length && !info.candidates.length)) return { routes: [], via: "none" };
    const routes = this.rt.discover().routes;
    const byFile = new Map(routes.map((r) => [r.file.replace(/\\/g, "/"), r.nextRoute]));
    const out = new Set<string>();
    if (info.files.length) {
      for (const f of this.graph.affected([...byFile.keys()], info.files)) out.add(byFile.get(f)!);
      return { routes: [...out].sort(), via: "imports" };
    }
    // Candidates: route stems ("app/api/feed/route") match a route file with `src/` and the
    // extension dropped; module candidates ("src/lib/store.ts") go through the import graph.
    const stems = new Map<string, string>();
    for (const [file, route] of byFile) stems.set(file.replace(/^src\//, "").replace(/\.[cm]?[jt]sx?$/, ""), route);
    const modules: string[] = [];
    for (const c of info.candidates) {
      const route = stems.get(c);
      if (route) out.add(route);
      else if (/\.[cm]?[jt]sx?$/.test(c)) modules.push(c);
    }
    if (modules.length) for (const f of this.graph.affected([...byFile.keys()], modules)) out.add(byFile.get(f)!);
    return { routes: [...out].sort(), via: out.size ? "candidates" : "none" };
  }

  private onBump(info: EpochInfo): void {
    try {
      // Lock in each route's last good baseline before the store's epoch window moves on.
      this.regressions.evaluate(this.rt.stats.snapshot(), undefined);
    } catch {
      /* best effort */
    }
    if (!this.subscribers.size) return;
    const view = this.view(info);
    for (const fn of this.subscribers) fn("epoch", view);
  }

  private readonly onDone = (t: TraceRecord) => {
    // Only traffic in the newest epoch can produce a new "regressed" verdict worth a toast.
    if ((t.facts?.epoch ?? 0) < this.rt.epochs.epoch || this.rt.epochs.epoch === 0 || this.checkTimer) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      this.check();
    }, CHECK_DELAY_MS);
    this.checkTimer.unref?.();
  };

  private check(): void {
    if (!this.subscribers.size) return;
    let res: RegressionsResponse;
    try {
      res = this.evaluate();
    } catch {
      return;
    }
    for (const item of res.items) {
      if (item.epoch !== res.epoch) break; // sorted newest epoch first
      if (item.status !== "regressed") continue;
      const id = `${item.key}@${item.epoch}`;
      if (this.announced.has(id)) continue;
      this.announced.add(id);
      if (this.announced.size > MAX_ANNOUNCED) {
        const oldest = this.announced.values().next().value;
        if (oldest !== undefined) this.announced.delete(oldest);
      }
      for (const fn of this.subscribers) fn("regression", item);
    }
  }
}

const services = new WeakMap<Runtime, EpochsService>();

/**
 * Created at Runtime.start (module `start` hook), so the onEpoch hook that locks each route's last
 * good baseline sees every edit, not only those after the first UI call. Exported for tests.
 */
export function epochsService(rt: Runtime): EpochsService {
  let s = services.get(rt);
  if (!s) {
    s = new EpochsService(rt);
    services.set(rt, s);
  }
  return s;
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export const listEpochs: ApiHandle = (_req, res, rt, ctx) => {
  const limit = intParam(ctx.url, "limit");
  sendJson(res, 200, epochsService(rt).list(limit && limit > 0 ? limit : undefined));
};

export const listRegressions: ApiHandle = (_req, res, rt, ctx) => {
  const out = epochsService(rt).evaluate();
  const epoch = intParam(ctx.url, "epoch");
  const status = ctx.url.searchParams.get("status");
  let items: RouteRegression[] = out.items;
  if (epoch !== undefined) items = items.filter((i) => i.epoch === epoch);
  if (status) {
    const want = new Set(status.split(","));
    items = items.filter((i) => want.has(i.status));
  }
  sendJson(res, 200, { ...out, items });
};

export const epochEvents: ApiHandle = (req: http.IncomingMessage, res: http.ServerResponse, rt) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ epoch: rt.epochs.epoch })}\n\n`);
  const unsubscribe = epochsService(rt).subscribe((event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const beat = setInterval(() => res.write(": ping\n\n"), 15000);
  beat.unref?.();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(beat);
    unsubscribe();
  };
  req.on("close", stop);
  res.on("error", stop);
  res.on("close", stop);
};

/** ApiModule start hook: create the service with the runtime (see epochsService). */
export function start(rt: Runtime): void {
  epochsService(rt);
}

export const endpoints: ApiEndpoint[] = [
  { method: "GET", path: "/api/epochs", handle: listEpochs },
  { method: "GET", path: "/api/epochs/events", handle: epochEvents },
  { method: "GET", path: "/api/regressions", handle: listRegressions },
];
