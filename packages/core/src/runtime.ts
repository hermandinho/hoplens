import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  type HopHandle,
  type HopMeta,
  als,
  beginHop,
  installBodyHooks,
  installConsoleHook,
  installFetchHook,
  installHttpHook,
  installOtel,
  installPgHook,
  installPostgresHook,
  installRedisHook,
  makeEmitDb,
  makeWrap,
  markOwnServer,
} from "./capture";
import { type EpochInfo, EpochTracker, createEpochTracker, nullProbe } from "./epoch";
import { HoplensError } from "./errors";
import { HealthMonitor } from "./health";
import { type Logger, createLogger } from "./logger";
import { DEFAULT_REDACT, type ResolvedOptions } from "./options";
import { type PersistRow, Persister, type PersisterOptions, persistDir, rowToTrace, traceRow } from "./persist";
import { QueryStatsStore } from "./queries";
import { RegressionTracker } from "./regressions";
import { LastRuns } from "./replay";
import { type Redactor, makeRedactor } from "./serialize";
import { handleUi, startApiModules } from "./server";
import { setDistDir } from "./sourcemap";
import { RouteStatsStore } from "./stats";
import { TraceStore } from "./store";
import type { Discovery, DiscoverySource, HopKind, HttpTap, ProxyInfo, RouteInfo, TraceRecord } from "./types";

export interface RuntimeConfig {
  options: ResolvedOptions;
  /** Walks the host framework for routes + proxy info. One per adapter. */
  discovery: DiscoverySource;
  /** Optional per-framework hooks for the HTTP tap (internal URL filter, request classifier). */
  httpTap?: HttpTap;
  /** Pretty-printed banner that runs after the UI port is bound. */
  banner?: (rt: Runtime) => void;
  /** Tests: persistence tuning (dir, file cap, flush interval). Used only with `options.persist`. */
  persist?: PersisterOptions & { dir?: string };
  /**
   * Dev-rebuild epochs. `"build"` (default) watches the build output and the source dirs; `"none"`
   * never bumps on a rebuild, so each process is one epoch (0, or the next one after a `persist`
   * restore), for frameworks with no build output (no watchers, no chunk index).
   */
  epochs?: { mode: "build" | "none" };
  /** The host framework, reported by GET /api/meta. */
  framework?: { name: string; version?: string };
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
  readonly framework?: { name: string; version?: string };
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
  /** Route regressions with their remembered baselines and verdicts (GET /api/regressions). */
  readonly regressions = new RegressionTracker();

  appPort?: number;
  uiPort?: number;
  otel: "own" | "attached" | "none" = "none";
  /** WP10: the persistence writer, when `options.persist` is on. */
  persister?: Persister;
  /** WP10: dev session number (1-based; +1 per restart when persisting, else always 1). */
  session = 1;

  private readonly banner?: (rt: Runtime) => void;
  private cachedDiscovery?: Discovery;
  private discoveredAt = 0;
  private started = false;
  private stopped = false;
  /** stop() ran: the installed hooks pass every request through untouched. */
  get isStopped(): boolean {
    return this.stopped;
  }
  private server?: http.Server;
  private readonly persistCfg?: PersisterOptions & { dir?: string };
  private unsubEpoch?: () => void;

  constructor(cfg: RuntimeConfig) {
    this.options = cfg.options;
    this.root = cfg.options.root;
    this.redactor = makeRedactor([...DEFAULT_REDACT, ...(cfg.options.redact ?? [])]);
    this.store = new TraceStore(cfg.options.maxTraces ?? 300);
    this.discovery = cfg.discovery;
    this.httpTap = cfg.httpTap;
    this.framework = cfg.framework;
    this.banner = cfg.banner;
    this.persistCfg = cfg.persist;
    this.log = createLogger("runtime");
    if (cfg.epochs?.mode === "none") {
      // No build output: the eval-source-map scan has nothing to read either.
      if (this.options.distDir !== "") setDistDir(this.root, this.options.distDir);
      this.epochs = new EpochTracker(nullProbe);
    } else {
      setDistDir(this.root, this.options.distDir);
      // Rebuild signal from the build output, attribution from a watcher on the project's source dirs.
      this.epochs = createEpochTracker(this.root, this.options.distDir ?? ".next");
    }
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
    void installPostgresHook(this);
    installRedisHook(this);
    this.health.start();
    // Before the API modules start: they read the restored epochs and stats.
    if (this.options.persist) this.startPersistence();
    process.once("exit", this.onExit);
    startApiModules(this);
    (globalThis as any).__hoplens = { wrap: makeWrap(this), emitDb: makeEmitDb(this), version: 2 };
    this.listen(this.options.port, 0);
    return this;
  }

  /**
   * Stop background work: health sampling, source and build-output watchers, the persistence timer
   * (after a final flush) and the standalone UI server. Installed hooks stay (they can't be unpatched)
   * but do nothing that outlives the process. Idempotent; also runs on process exit.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    process.off("exit", this.onExit);
    const steps: Array<() => void> = [
      () => this.health.stop(),
      () => this.epochs.close(),
      () => this.unsubEpoch?.(),
      () => this.store.off("done", this.onPersistDone),
      () => this.store.off("clear", this.onPersistClear),
      () => this.persister?.stop(),
      () => this.server?.close(),
    ];
    for (const step of steps) {
      try {
        step();
      } catch (err) {
        this.log.warn(`stop step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private readonly onExit = () => this.stop();

  /** Restore earlier sessions (epochs, then stats) and start writing this one. Never throws. */
  private startPersistence(): void {
    try {
      const dir = this.persistCfg?.dir ?? persistDir(this.root, this.options.distDir, this.options.stateDir);
      const p = new Persister(dir, {
        ...this.persistCfg,
        header: () => this.epochs.list().map((info) => this.epochRow(info)),
      });
      const prior = p.load();
      this.session = prior.session + 1;
      if (prior.nextEpoch > 0) this.epochs.restore(prior.nextEpoch, prior.epochs);
      // Replayed in order, judging regressions at each epoch edge as the live session did: the store
      // keeps few epochs per route, so a verdict whose baseline it drops would otherwise be lost.
      let edge: number | undefined;
      for (const row of prior.traces) {
        const e = row.facts?.epoch;
        if (e !== undefined && edge !== undefined && e > edge) this.regressions.evaluate(this.stats.snapshot());
        if (e !== undefined) edge = Math.max(edge ?? e, e);
        this.stats.add(rowToTrace(row));
      }
      p.begin(this.session);
      // This session's start epoch, so a later restart knows where it began.
      const infos = this.epochs.list();
      const start = infos[infos.length - 1];
      if (start) p.push(this.epochRow(start));
      this.persister = p;
      this.unsubEpoch = this.epochs.onEpoch((info) => p.push(this.epochRow(info)));
      this.store.on("done", this.onPersistDone);
      this.store.on("clear", this.onPersistClear);
    } catch (err) {
      this.log.warn(`persistence off: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private epochRow(info: EpochInfo): PersistRow {
    const { session, ...rest } = info;
    return { k: "e", s: session ?? this.session, info: rest };
  }

  /** Runs in the store's finish timer, off the request path: builds a small row in memory only. */
  private readonly onPersistDone = (t: TraceRecord) => {
    try {
      this.persister?.push(traceRow(t, this.redactor));
    } catch {
      /* best effort */
    }
  };

  private readonly onPersistClear = () => this.persister?.clear();

  private listen(port: number, attempt: number) {
    const server = http.createServer();
    this.server = server;
    markOwnServer(server);
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err?.code === "EADDRINUSE" && attempt < 10) this.listen(port + 1, attempt + 1);
      else {
        this.log.warn(`UI port ${port} unavailable, giving up: ${err.message}`);
        this.banner?.(this);
      }
    });
    try {
      server.listen(port, "127.0.0.1", () => {
        if (this.stopped) return void server.close();
        this.uiPort = port;
        server.unref();
        this.banner?.(this);
      });
    } catch (err) {
      // An invalid port throws synchronously; start() has installed its hooks by now, so report it
      // like a busy port instead of throwing out of start() with the hooks half-owned.
      this.log.warn(`UI port ${port} unavailable, giving up: ${err instanceof Error ? err.message : String(err)}`);
      this.banner?.(this);
    }
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

  /** The trace of the request the caller runs in, for adapters that annotate it. */
  currentTrace(): TraceRecord | undefined {
    return als.getStore()?.trace;
  }

  /**
   * Open a hop in the current request (an adapter's middleware or handler). Undefined outside a
   * request context. The caller must `end()` it; `run(fn)` nests spans started in `fn` under it.
   */
  beginHop(kind: HopKind, meta: HopMeta): HopHandle | undefined {
    return beginHop(kind, meta);
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
