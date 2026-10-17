import path from "node:path";
import type { HoplensOptions, ResolvedOptions } from "@hoplens/core";
import type { Env } from "./gate";

/**
 * Defaults, then `HOPLENS_OPTIONS` (JSON `HoplensOptions`), then the options given to
 * `hoplens(app, opts)`. Express has no build output: `distDir` is empty, and `persist` (on by
 * default here) writes under `<root>/node_modules/.cache/hoplens` unless `stateDir` says otherwise.
 */
export function resolveOptions(code?: HoplensOptions, env: Env = process.env, cwd = process.cwd()): ResolvedOptions {
  let options: ResolvedOptions = {
    port: Number(env.HOPLENS_PORT) || 4983,
    basePath: "",
    distDir: "",
    root: cwd,
    configured: true,
    persist: true,
  };
  if (env.HOPLENS_OPTIONS) {
    try {
      const fromEnv = JSON.parse(env.HOPLENS_OPTIONS);
      if (fromEnv && typeof fromEnv === "object") options = { ...options, ...fromEnv };
    } catch {
      process.stderr.write("! hoplens:express HOPLENS_OPTIONS is not valid JSON; ignored\n");
    }
  }
  if (code && typeof code === "object") options = { ...options, ...code };
  if (!validPort(options.port)) {
    process.stderr.write(`! hoplens:express UI port ${String(options.port)} is not a port (0-65535); using 4983\n`);
    options.port = 4983;
  }
  options.stateDir ??= path.join(options.root, "node_modules", ".cache", "hoplens");
  return options;
}

function validPort(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 0 && p < 65536;
}

/** `HOPLENS_IGNORE=/health,/metrics`: extra path prefixes never traced. */
export function ignoredPrefixes(env: Env = process.env): string[] {
  return (env.HOPLENS_IGNORE ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}
