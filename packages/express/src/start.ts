// Boot. Nothing here loads @hoplens/core at import time: `require("@hoplens/core")` runs inside
// boot(), after the callers checked the gate, so a gated-off process never loads the runtime.

import http from "node:http";
import https from "node:https";
import type { HoplensOptions, Runtime } from "@hoplens/core";
import { appListening, uiReady } from "./banner";
import { ExpressDiscoverySource } from "./discovery";
import { resolveOptions } from "./options";
import { resolveExpress } from "./resolve";
import { adapterState } from "./state";
import { createTap } from "./tap";

const G = globalThis as any;
/** Core's marker on the Runtime's own UI server (capture.ts markOwnServer). */
const OWN_SERVER = Symbol.for("hoplens.server");
const WRAPPED = Symbol.for("hoplens.express.listen");

/** Logs the first failure only; later calls stay quiet and boot is never retried. */
function failOnce(msg: string, err?: unknown) {
  const s = adapterState();
  if (s.failed) return;
  s.failed = true;
  const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : "";
  try {
    process.stderr.write(`! hoplens:express ${msg}${detail ? `: ${detail}` : ""}; your app runs without Hoplens\n`);
  } catch {
    /* nothing left to tell */
  }
}

/**
 * Wrap http/https Server.prototype.listen so the Runtime boots (and its emit tap is in place) before
 * the app's first server binds and takes a request. One shot: the first app listen restores the
 * originals. A process that never listens never boots, so it never binds the UI port.
 */
export function install(): void {
  const s = adapterState();
  if (s.listenPatched) return;
  s.listenPatched = true;
  const undo: Array<() => void> = [];
  try {
    for (const proto of [http.Server.prototype, https.Server.prototype] as any[]) {
      if (proto.listen?.[WRAPPED]) continue;
      // Both inherit net.Server's listen; the wrapper is an own property, deleted again on restore.
      const hadOwn = Object.prototype.hasOwnProperty.call(proto, "listen");
      const orig = proto.listen;
      const wrapped = function (this: http.Server, ...args: unknown[]) {
        onListen(this, args);
        return orig.apply(this, args);
      };
      (wrapped as any)[WRAPPED] = true;
      proto.listen = wrapped;
      undo.push(() => {
        // Someone wrapped listen after us: leave their chain alone; ours is a no-op from now on.
        if (proto.listen !== wrapped) return;
        if (hadOwn) proto.listen = orig;
        else Reflect.deleteProperty(proto, "listen");
      });
    }
  } catch (err) {
    failOnce("could not hook server.listen", err);
  }
  s.restoreListen = () => {
    for (const fn of undo.splice(0)) {
      try {
        fn();
      } catch {
        /* best effort */
      }
    }
  };
}

/** The TCP port a `listen(...)` call asks for, when it names one (not 0, a path or a handle). */
export function requestedPort(args: unknown[]): number | undefined {
  const a = args[0];
  const raw = a && typeof a === "object" ? (a as { port?: unknown }).port : a;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

function onListen(server: http.Server, args: unknown[]): void {
  const s = adapterState();
  try {
    // The Runtime's own UI server, or a listen made while we boot, is not the app's.
    if ((server as any)[OWN_SERVER] || s.inListen || !s.restoreListen) return;
    s.inListen = true;
    try {
      // The UI binds before the app's own listen runs: keep it off the port the app asked for.
      const rt = boot(s.pendingOpts, requestedPort(args));
      if (rt) watchAppServer(server, rt);
    } finally {
      s.inListen = false;
      s.restoreListen?.();
      s.restoreListen = undefined;
    }
  } catch (err) {
    failOnce("listen hook failed", err);
  }
}

function watchAppServer(server: http.Server, rt: Runtime): void {
  server.once("listening", () => {
    try {
      const addr = server.address();
      if (!addr || typeof addr !== "object") return;
      rt.appPort ??= addr.port;
      appListening(addr.port);
    } catch {
      /* banner only */
    }
  });
}

/** How long hoplens() waits for an app listen before booting without one (HOPLENS_LATE_BOOT_MS). */
const LATE_BOOT_MS = 3000;

/**
 * hoplens(app, opts) from code. Booting right away bound the UI before the app's listen, so an app
 * on the UI's port lost it (EADDRINUSE). Instead wait for that listen, like the register hook.
 * Called after the app already listens (no listen left to hook): boot after a short wait, by when
 * the app holds its port and the UI's EADDRINUSE retry steps past it.
 */
export function bootDeferred(opts?: HoplensOptions): Runtime | undefined {
  if (G.__hoplens_runtime) return G.__hoplens_runtime;
  const s = adapterState();
  if (opts) s.pendingOpts = { ...s.pendingOpts, ...opts };
  install();
  // The register hook already saw the app's listen: nothing left to wait for.
  if (!s.restoreListen) return boot(s.pendingOpts);
  if (!s.lateTimer) {
    const ms = Number(process.env.HOPLENS_LATE_BOOT_MS) || LATE_BOOT_MS;
    s.lateTimer = setTimeout(() => {
      s.lateTimer = undefined;
      s.restoreListen?.();
      s.restoreListen = undefined;
      s.banner.noAppListen = true;
      boot(s.pendingOpts);
    }, ms);
    s.lateTimer.unref?.();
  }
  return undefined;
}

/** The UI tries `port` and the next 9 on EADDRINUSE (core Runtime.listen). */
const UI_PORT_TRIES = 10;

/**
 * Start the singleton Runtime, or return the running one. Never throws. `appPort` is the port the
 * app is about to listen on: when it falls in the UI's retry range, the UI starts just above it.
 */
export function boot(opts?: HoplensOptions, appPort?: number): Runtime | undefined {
  if (G.__hoplens_runtime) return G.__hoplens_runtime;
  const s = adapterState();
  if (s.lateTimer) {
    clearTimeout(s.lateTimer);
    s.lateTimer = undefined;
  }
  if (s.failed || s.booting) return undefined;
  s.booting = true;
  let rt: Runtime | undefined;
  try {
    const options = resolveOptions(opts);
    if (options.enabled === false) return undefined;
    if (appPort !== undefined && appPort >= options.port && appPort < options.port + UI_PORT_TRIES) {
      options.port = appPort + 1;
    }
    const core = require("@hoplens/core") as typeof import("@hoplens/core");
    s.express = resolveExpress(options.root);
    rt = new core.Runtime({
      options,
      discovery: new ExpressDiscoverySource(options.root),
      httpTap: createTap(core.normalizeUrl, process.env, s.express?.version),
      banner: uiReady,
      framework: { name: "express", version: s.express?.version },
      epochs: { mode: "none" },
    });
    rt.start();
    G.__hoplens_runtime = rt;
    return rt;
  } catch (err) {
    // A half-started Runtime: stop its timers, watchers and UI server. Core's http hook cannot be
    // unpatched, but it passes every request through once its runtime is stopped.
    try {
      rt?.stop();
    } catch {
      /* best effort */
    }
    failOnce("failed to start", err);
    return undefined;
  } finally {
    s.booting = false;
  }
}
