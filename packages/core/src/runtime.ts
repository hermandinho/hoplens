import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
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
import { type EpochInfo, EpochTracker, MAX_EPOCH_FILES, createEpochTracker, nullProbe } from "./epoch";
import { HoplensError } from "./errors";
import { HealthMonitor } from "./health";
import { type Logger, createLogger } from "./logger";
import {
  MAX_MANIFEST_FILES,
  type RestartCheck,
  type TypeScriptLike,
  checkRestart,
  isEdit,
  manifestPath,
  sameFiles,
  sweepTempFiles,
  writeManifest,
} from "./manifest";
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
   * restore), for frameworks with no build output (no watchers, no chunk index). `"restart"` is for
   * apps a watcher restarts on every save (node --watch, tsx watch, nodemon): no watchers or chunk
   * index either, but with `persist` each start hashes the source files and compares them with the
   * previous process's manifest, so a restart that changed code opens a new epoch (`via: "restart"`,
   * naming the files) and one that changed nothing (a formatter-only save) continues the last one.
   * `typescript` loads the TypeScript used to normalize sources (default: the project's, if any).
   */
  epochs?: { mode: "build" | "none" | "restart"; typescript?: () => TypeScriptLike | null | undefined };
  /**
   * When the UI port is busy at start, keep retrying that same port for up to this many ms before
   * moving to the next one: under a watcher the previous process can hold it for a moment after a
   * restart. Default 0 (move on at once).
   */
  samePortRetryMs?: number;
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
  private readonly epochCfg: NonNullable<RuntimeConfig["epochs"]>;
  private readonly samePortRetryMs: number;

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
    this.epochCfg = cfg.epochs ?? { mode: "build" };
    this.samePortRetryMs = Math.max(0, cfg.samePortRetryMs ?? 0);
    if (cfg.epochs?.mode === "none" || cfg.epochs?.mode === "restart") {
      // No build output: the eval-source-map scan has nothing to read either. "restart" finds its
      // edits once, at start (startPersistence): no build-output probe and no chunk index here.
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
    this.listen(this.options.port, 0, Date.now());
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
      const restartMode = this.epochCfg.mode === "restart";
      const p = new Persister(dir, {
        // A watcher kills the process on the next save (no exit handler runs): write rows sooner.
        ...(restartMode ? { flushMs: RESTART_FLUSH_MS } : {}),
        ...this.persistCfg,
        header: () => this.epochs.list().map((info) => this.epochRow(info)),
      });
      const prior = p.load();
      this.session = prior.session + 1;
      const restart = restartMode ? this.checkRestart(dir) : undefined;
      let opened = false;
      if (restart?.diff && prior.nextEpoch > 0) {
        if (isEdit(restart.diff)) {
          this.epochs.restore(prior.nextEpoch, prior.epochs, restartInfo(restart));
          opened = true;
        } else {
          // Nothing changed (a formatter-only save, `touch`, a manual restart): the same epoch goes on.
          const last = prior.nextEpoch - 1;
          const { id: _id, ...cont } = prior.epochs.find((i) => i.id === last) ?? startInfo(Date.now());
          this.epochs.restore(last, prior.epochs, cont);
        }
      } else if (prior.nextEpoch > 0) this.epochs.restore(prior.nextEpoch, prior.epochs);
      // Replayed in order, judging regressions at each epoch edge as the live session did: the store
      // keeps few epochs per route, so a verdict whose baseline it drops would otherwise be lost.
      let edge: number | undefined;
      for (const row of prior.traces) {
        const e = row.facts?.epoch;
        if (e !== undefined && edge !== undefined && e > edge) this.regressions.evaluate(this.stats.snapshot());
        if (e !== undefined) edge = Math.max(edge ?? e, e);
        this.stats.add(rowToTrace(row));
      }
      // A restart edit is an epoch edge too: lock in each route's last good baseline, as onBump does.
      if (opened) this.regressions.evaluate(this.stats.snapshot());
      p.begin(this.session);
      // This session's start epoch, so a later restart knows where it began.
      const infos = this.epochs.list();
      const start = infos[infos.length - 1];
      if (start) p.push(this.epochRow(start));
      if (restart) {
        if (restart.truncated)
          this.log.warn(
            `source manifest: more than ${MAX_MANIFEST_FILES} source files, edits to files past the cut are not seen`,
          );
        // The epoch row reaches the disk before the manifest that marks its files as seen: a kill in
        // between (or a flush that failed and is retried by the timer) finds the same edit again next
        // time instead of losing it.
        const file = manifestPath(dir);
        sweepTempFiles(file);
        if (restart.prev && sameFiles(restart.prev, restart.next)) {
          // Nothing to record (the file map is the same): no rewrite, so a watcher of the state dir sees nothing.
        } else {
          const write = () => {
            if (!writeManifest(file, restart.next)) this.log.warn("could not write the source manifest");
          };
          if (p.flush()) write();
          else p.afterFlush(write);
        }
      }
      this.persister = p;
      this.unsubEpoch = this.epochs.onEpoch((info) => p.push(this.epochRow(info)));
      this.store.on("done", this.onPersistDone);
      this.store.on("clear", this.onPersistClear);
    } catch (err) {
      this.log.warn(`persistence off: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Hash the sources and compare them with the previous process's manifest. Never throws. */
  private checkRestart(dir: string): RestartCheck | undefined {
    try {
      const typescript = this.epochCfg.typescript ?? (() => projectTypeScript(this.root));
      return checkRestart(this.root, dir, { typescript });
    } catch (err) {
      this.log.warn(`source manifest skipped: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
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

  private listen(port: number, attempt: number, since: number) {
    const server = http.createServer();
    this.server = server;
    markOwnServer(server);
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (this.stopped) return;
      const busy = err?.code === "EADDRINUSE";
      if (busy && attempt === 0 && this.samePortRetryMs > 0 && Date.now() - since < this.samePortRetryMs) {
        // The configured port only: the previous process of a watch restart may still be closing it.
        const t = setTimeout(() => this.listen(port, 0, since), SAME_PORT_RETRY_STEP_MS);
        t.unref?.();
      } else if (busy && attempt < 10) this.listen(port + 1, attempt + 1, since);
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
    // Several entries can share a template (Express lists one per registration file): prefer the one
    // that declares the method. An entry with no file (a route registered before the adapter could
    // see its call site) names no location.
    const all: RouteInfo[] = this.discover().routes.filter((r) => r.nextRoute === nextRoute && r.file);
    const route =
      all.find((r) => r.methods.some((x) => x.method === method)) ??
      all.find((r) => r.methods.some((x) => x.method === "ANY")) ??
      all[0];
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

/** Persist flush interval in epochs mode "restart" (the default 2s loses the last rows to a restart). */
const RESTART_FLUSH_MS = 250;
/** Pause between two binds of the same busy UI port (samePortRetryMs). */
const SAME_PORT_RETRY_STEP_MS = 50;

function startInfo(at: number): EpochInfo {
  return { id: 0, at, rebuiltAt: 0, files: [], deleted: [], moreFiles: 0, via: "start", candidates: [] };
}

/** The epoch a restart that changed sources opens (restore sets its id). */
function restartInfo(r: RestartCheck): Omit<EpochInfo, "id"> {
  const d = r.diff!;
  const files = [...d.changed, ...d.added, ...d.deleted].sort();
  return {
    at: Date.now(),
    rebuiltAt: r.newestMtime,
    files: files.slice(0, MAX_EPOCH_FILES),
    deleted: d.deleted.slice(0, MAX_EPOCH_FILES),
    moreFiles: Math.max(0, files.length - MAX_EPOCH_FILES),
    via: "restart",
    candidates: [],
  };
}

/** The project's own TypeScript (epochs mode "restart" default normalizer); null without a usable one. */
function projectTypeScript(root: string): TypeScriptLike | null {
  for (const base of [root, __dirname]) {
    try {
      const ts = createRequire(path.join(base, "package.json"))("typescript");
      if (typeof ts?.createScanner === "function") return ts;
    } catch {
      /* next */
    }
  }
  return null;
}
