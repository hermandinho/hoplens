import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { HoplensOptions, ResolvedOptions } from "@hoplens/core";

export type { HoplensOptions, HoplensProfile, AutoTraceGlobs } from "@hoplens/core";
export { NextDiscoverySource } from "./routes";

type AnyConfig = Record<string, any>;
type ConfigInput = AnyConfig | ((phase: string, ctx: any) => AnyConfig | Promise<AnyConfig>);

const DEV_PHASE = "phase-development-server";
const LOADER = "@hoplens/transform/loader";
const FILE_GLOB = "{*.ts,*.mts,*.cts,*.js,*.mjs,*.cjs}";

/**
 * Wrap your Next.js config to enable Hoplens during `next dev`. Production builds and
 * `next start` get your config back untouched.
 *
 * ```ts
 * // next.config.ts
 * import { withHoplens } from "@hoplens/next";
 *
 * export default withHoplens({
 *   // your Next.js config here
 * }, {
 *   profiles: {
 *     admin: { headers: { authorization: "Bearer ${DEV_ADMIN_TOKEN}" } },
 *   },
 * });
 * ```
 */
export function withHoplens(config: ConfigInput = {}, options: HoplensOptions = {}) {
  return async function hoplensConfig(phase: string, ctx: any) {
    const base: AnyConfig = (typeof config === "function" ? await config(phase, ctx) : config) ?? {};
    const enabled = options.enabled ?? (phase === DEV_PHASE && process.env.HOPLENS !== "0");
    if (!enabled) return base;

    const port = options.port ?? (Number(process.env.HOPLENS_PORT) || 4983);
    const resolved: ResolvedOptions = {
      ...options,
      port,
      basePath: base.basePath ?? "",
      distDir: base.distDir ?? ".next",
      root: process.cwd(),
      configured: true,
    };
    process.env.HOPLENS_ENABLED = "1";
    process.env.HOPLENS_OPTIONS = JSON.stringify(resolved);
    // Next 15 starts the server process before evaluating this config, so env vars never reach it.
    // We leave the options on disk as well.
    try {
      const dir = path.join(resolved.root, resolved.distDir, "cache");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "hoplens.json"), JSON.stringify(resolved));
    } catch {
      /* env var still works where it matters */
    }

    const out: AnyConfig = { ...base };

    // The runtime is loaded with Node's own require from the instrumentation hook so it can patch globals.
    out.serverExternalPackages = unique([...(base.serverExternalPackages ?? []), "@hoplens/core"]);

    // Next 16 loads instrumentation lazily, so the first request can miss the emit hook. The rewrite
    // is a fallback that proxies it to the standalone UI port.
    const ours = [
      { source: "/__hoplens", destination: `http://127.0.0.1:${port}/__hoplens`, basePath: false },
      { source: "/__hoplens/:path*", destination: `http://127.0.0.1:${port}/__hoplens/:path*`, basePath: false },
    ];
    const userRewrites = base.rewrites;
    out.rewrites = async () => {
      const r = typeof userRewrites === "function" ? await userRewrites() : [];
      if (Array.isArray(r)) return { beforeFiles: ours, afterFiles: r, fallback: [] };
      return { ...r, beforeFiles: [...ours, ...(r?.beforeFiles ?? [])] };
    };

    const autoTrace = options.autoTrace ?? true;
    if (autoTrace !== false) {
      const loaderOptions = {
        root: resolved.root,
        include: typeof autoTrace === "object" ? (autoTrace.include ?? []) : [],
        exclude: typeof autoTrace === "object" ? (autoTrace.exclude ?? []) : [],
      };
      // Turbopack runs webpack loaders reliably from Next.js 16. On 15.x, Turbopack fails with
      // an internal TP1006 error — users must `next dev --webpack` for function hops.
      const turbopack = { ...(base.turbopack ?? {}) };
      if (nextMajor(resolved.root) >= 16) {
        turbopack.rules = {
          ...(turbopack.rules ?? {}),
          [FILE_GLOB]: {
            condition: {
              all: [
                { not: "foreign" },
                { not: "browser" },
                { content: /export\s+(default\s+)?(async\s+)?(function|const|let)\b/ },
              ],
            },
            loaders: [{ loader: LOADER, options: loaderOptions }],
          },
        };
      }
      out.turbopack = turbopack;

      const userWebpack = base.webpack;
      out.webpack = (cfg: any, wctx: any) => {
        const result = typeof userWebpack === "function" ? userWebpack(cfg, wctx) : cfg;
        if (wctx?.isServer && wctx?.nextRuntime !== "edge") {
          result.module = result.module ?? {};
          result.module.rules = result.module.rules ?? [];
          result.module.rules.push({
            test: /\.(c|m)?(t|j)s$/,
            exclude: /node_modules|\.next/,
            enforce: "pre",
            use: [
              {
                loader: createRequire(path.join(resolved.root, "package.json")).resolve(LOADER),
                options: loaderOptions,
              },
            ],
          });
        }
        return result;
      };
    }

    return out;
  };
}

function nextMajor(root: string): number {
  try {
    const pkg = createRequire(path.join(root, "package.json"))("next/package.json");
    return Number(String(pkg.version).split(".")[0]) || 0;
  } catch {
    return 0;
  }
}

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

export default withHoplens;
