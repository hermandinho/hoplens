import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  installBodyHooks,
  installConsoleHook,
  installFetchHook,
  installHttpHook,
  installOtel,
  installPgHook,
  installRedisHook,
  makeEmitDb,
  makeWrap,
  markOwnServer,
} from "./capture";
import { type EpochTracker, createEpochTracker } from "./epoch";
import { HoplensError } from "./errors";
import { HealthMonitor } from "./health";
import { type Logger, createLogger } from "./logger";
import { DEFAULT_REDACT, type ResolvedOptions } from "./options";
import { QueryStatsStore } from "./queries";
import { LastRuns } from "./replay";
import { type Redactor, makeRedactor } from "./serialize";
import { handleUi, startApiModules } from "./server";
import { setDistDir } from "./sourcemap";
import { RouteStatsStore } from "./stats";
import { TraceStore } from "./store";
import type { Discovery, DiscoverySource, HttpTap, ProxyInfo, RouteInfo } from "./types";

export interface RuntimeConfig {
  options: ResolvedOptions;
  /** Walks the host framework for routes + proxy info. One per adapter. */
  discovery: DiscoverySource;
  /** Optional per-framework hooks for the HTTP tap (internal URL filter, request classifier). */
  httpTap?: HttpTap;
  /** Pretty-printed banner that runs after the UI port is bound. */
  banner?: (rt: Runtime) => void;
}

/**
 * The composition root. Adapters build one with their own `DiscoverySource` and start it from
 * their `instrumentation` entry.
 *
 * ```ts
 * // @hoplens/next uses this directly:
 * new Runtime({ options, discovery: new NextDiscoverySource(root, basePath) }).start();
 * ```
 */
export class Runtime {
  readonly options: ResolvedOptions;
  readonly root: string;
  readonly redactor: Redactor;
  readonly store: TraceStore;
  readonly discovery: DiscoverySource;
  readonly httpTap?: HttpTap;
  readonly log: Logger;
  readonly startedAt = Date.now();
  /** Coarse dev-rebuild epochs for the cold/epoch facts. See epoch.ts for the signal. */
  readonly epochs: EpochTracker;
  /** Per-route, per-epoch rolling aggregates (GET /api/stats). Survive ring-buffer eviction. */
  readonly stats = new RouteStatsStore();
  /** Cross-request query / host aggregates (GET /api/queries). */
  readonly queries = new QueryStatsStore();
  /** Event-loop delay, memory, GC and process errors (GET /api/health). Listeners attach in start(). */
  readonly health = new HealthMonitor();
  /** WP7 Replay xN: last batch per method+path+profile, for "vs last run" (LRU of 100). */
  readonly lastRuns = new LastRuns(100);

  appPort?: number;
  uiPort?: number;
  otel: "own" | "attached" | "none" = "none";

  private readonly banner?: (rt: Runtime) => void;
  private cachedDiscovery?: Discovery;
  private discoveredAt = 0;
  private started = false;

  constructor(cfg: RuntimeConfig) {
    this.options = cfg.options;
    this.root = cfg.options.root;
    this.redactor = makeRedactor([...DEFAULT_REDACT, ...(cfg.options.redact ?? [])]);
    this.store = new TraceStore(cfg.options.maxTraces ?? 300);
    this.discovery = cfg.discovery;
    this.httpTap = cfg.httpTap;
    this.banner = cfg.banner;
    this.log = createLogger("runtime");
    setDistDir(this.root, this.options.distDir);
    // Rebuild signal from the build output, attribution from a watcher on the project's source dirs.
    this.epochs = createEpochTracker(this.root, this.options.distDir ?? ".next");
    // Both aggregates swallow their own errors: a listener that threw would surface in finish()'s timer.
    this.store.on("done", (t) => {
      this.stats.add(t);
      this.queries.add(t);
    });
    this.store.on("clear", () => {
      this.stats.clear();
      this.queries.clear();
    });
  }

  start(): this {
    if (this.started) throw new HoplensError("runtime-already-started", "Runtime.start() called twice");
    this.started = true;
    this.otel = installOtel(this);
    installHttpHook(this);
    installBodyHooks(this);
    installConsoleHook(this);
    installFetchHook(this);
    installPgHook(this);
    installRedisHook(this);
    this.health.start();
    startApiModules(this);
    (globalThis as any).__hoplens = { wrap: makeWrap(this), emitDb: makeEmitDb(this), version: 2 };
    this.listen(this.options.port, 0);
    return this;
  }

  private listen(port: number, attempt: number) {
    const server = http.createServer();
    markOwnServer(server);
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "EADDRINUSE" && attempt < 10) this.listen(port + 1, attempt + 1);
      else {
        this.log.warn(`UI port ${port} unavailable, giving up: ${err.message}`);
        this.banner?.(this);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      this.uiPort = port;
      server.unref();
      this.banner?.(this);
    });
  }

  handleUi(req: http.IncomingMessage, res: http.ServerResponse): void {
    handleUi(this, req, res).catch((err) => {
      this.log.error("UI handler crashed", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  }

  discover(force = false): Discovery {
    if (force || !this.cachedDiscovery || Date.now() - this.discoveredAt > 1500) {
      try {
        this.cachedDiscovery = this.discovery.scan();
        this.discoveredAt = Date.now();
      } catch (err) {
        this.log.error("Discovery scan failed", err);
        this.cachedDiscovery = { routes: [], typescript: false, scannedAt: Date.now() };
      }
    }
    return this.cachedDiscovery;
  }

  routeInfo(nextRoute: string, method: string): { file: string; line: number } | undefined {
    const route: RouteInfo | undefined = this.discover().routes.find((r) => r.nextRoute === nextRoute);
    if (!route) return undefined;
    const m =
      route.methods.find((x) => x.method === method) ??
      route.methods.find((x) => x.method === "ANY") ??
      route.methods[0];
    return { file: route.file, line: m?.line ?? 1 };
  }

  proxyFile(): ProxyInfo | undefined {
    return this.discover().proxy;
  }

  /** Resolve a project-relative source path and reject anything outside the root or in forbidden areas. */
  resolveFile(rel: string): string | null {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) return null;
    if (/[\\/]node_modules[\\/]|[\\/]\.env/.test(abs.slice(this.root.length))) return null;
    return fs.existsSync(abs) ? abs : null;
  }
}
