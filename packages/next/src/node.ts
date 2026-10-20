import fs from "node:fs";
import path from "node:path";
import { type ResolvedOptions, Runtime, createLogger, pathMeta } from "@hoplens/core";
import { type NextPath, startNextPath } from "./path";
import { NextDiscoverySource } from "./routes";

const log = createLogger("next");

/**
 * Hoplens runtime bootstrap for Next.js. Import this from your `instrumentation.ts`:
 *
 * ```ts
 * export async function register() {
 *   if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {
 *     await import("@hoplens/next/node");
 *   }
 * }
 * ```
 *
 * Starts a singleton Runtime on `globalThis.__hoplens_runtime`. Refuses to run in production
 * unless `HOPLENS_FORCE=1`.
 */

const G = globalThis as any;

function shouldStart(): boolean {
  if (process.env.HOPLENS === "0") return false;
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return false;
  if (process.env.NODE_ENV === "production" && process.env.HOPLENS_FORCE !== "1") return false;
  return true;
}

function readOptions(): { options: ResolvedOptions; configured: boolean } {
  const defaults: ResolvedOptions = {
    port: Number(process.env.HOPLENS_PORT) || 4983,
    basePath: "",
    distDir: process.env.HOPLENS_DIST_DIR || ".next",
    root: process.cwd(),
    configured: false,
  };
  if (process.env.HOPLENS_OPTIONS) {
    try {
      return { options: { ...defaults, ...JSON.parse(process.env.HOPLENS_OPTIONS) }, configured: true };
    } catch {
      /* fall through */
    }
  }
  const file = path.join(defaults.root, defaults.distDir, "cache", "hoplens.json");
  if (fs.existsSync(file)) {
    try {
      return { options: { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) }, configured: true };
    } catch {
      /* fall through */
    }
  }
  return { options: defaults, configured: false };
}

if (!G.__hoplens_runtime && shouldStart()) {
  try {
    const { options, configured } = readOptions();
    options.configured = configured;
    // First: block coverage (when the request path is on) must start before any route code is
    // called. This runs in register(), before the first request's proxy and route bundles (path.ts).
    let path: NextPath | undefined;
    if (options.enabled !== false) {
      try {
        path = startNextPath(options);
      } catch (err) {
        log.error("request path setup failed", err);
      }
    }
    const discovery = new NextDiscoverySource(options.root, options.basePath);
    const framework = { name: "next", version: nextVersion(options.root) };
    G.__hoplens_runtime = new Runtime({
      options,
      discovery,
      framework,
      banner: printBanner,
      path: path ? { analyzer: path.analyzer, control: path.control, scripts: path.scripts } : undefined,
    }).start();
    if (path?.on) {
      // Load TypeScript once the server is up, so the first Trace path does not pay for it.
      const t = setTimeout(() => {
        try {
          path?.analyzer.warm?.();
        } catch {
          /* the first analysis reports it */
        }
      }, 1000);
      t.unref?.();
    }
  } catch (err) {
    log.error("failed to start", err);
  }
}

function printBanner(rt: Runtime) {
  const appUrl = process.env.PORT ? `http://localhost:${process.env.PORT}/__hoplens` : "/__hoplens on your dev server";
  const standalone = rt.uiPort ? `  (also http://localhost:${rt.uiPort})` : "";
  const notes: string[] = [];
  if (rt.otel === "none") notes.push("Could not attach to your OpenTelemetry setup; framework hops will be missing.");
  if (!rt.options.configured) notes.push("next.config isn't wrapped with withHoplens — function hops are off.");
  const fnOff = functionTracingReason(rt);
  if (fnOff) notes.push(`Function hops are off: ${fnOff}`);
  const pathLine = requestPathLine(rt);
  if (pathLine) notes.push(pathLine);
  const suffix = notes.length ? `\n   ! ${notes.join("\n   ! ")}` : "";
  process.stdout.write(`\n \x1b[35m◆ Hoplens\x1b[0m  ${appUrl}${standalone}${suffix}\n\n`);
}

/** The banner's request path note: only when it is on, or asked for and not running. */
function requestPathLine(rt: Runtime): string | undefined {
  const m = pathMeta(undefined, process.env, rt.pathControl);
  if (m.state === "on")
    return `Request path: on${m.source === "flag" ? " (enabled in the Path view)" : " (HOPLENS_PATH)"}; block coverage runs, so CPU-heavy code runs slower.`;
  if (m.state === "disabled-c8" || m.state === "error")
    return `Request path: ${m.state} (${m.reason ?? "see the Path view: press x on a request"}).`;
  return undefined;
}

function nextVersion(root: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(require.resolve("next/package.json", { paths: [root] }), "utf8")).version;
  } catch {
    return undefined;
  }
}

function functionTracingReason(rt: Runtime): string | undefined {
  if (rt.options.autoTrace === false) return "autoTrace is off in withHoplens options";
  const major = Number(nextVersion(rt.root)?.split(".")[0]) || 0;
  if (major && major < 16 && process.env.TURBOPACK) {
    return "Next.js 15 with Turbopack: run `next dev --webpack` to see your functions";
  }
  return undefined;
}

export const runtime: Runtime | undefined = G.__hoplens_runtime;
