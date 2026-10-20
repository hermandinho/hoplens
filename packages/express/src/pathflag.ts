// The request path's sticky switch: `<stateDir>/path.json` ({"enabled":true,"since":ISO,"by":"ui"|"init"}),
// written by the UI's Enable button (POST /__hoplens/api/path/enable) or `hoplens init --path`, and read
// by the register hook at the next start. Core-free and synchronous (node:fs, node:path only), so the
// register hook can decide before anything else loads: one small file read at boot, nothing more.
//
// Resolution (register.ts, before coverage would start):
//   HOPLENS_PATH=1|true          -> on  (source 'env')
//   HOPLENS_PATH set otherwise   -> off (source 'env'; HOPLENS_PATH=0 is the usual spelling)
//   path.json with enabled:true  -> on  (source 'flag')
//   else (absent, corrupt)       -> off (source 'default')
// The gate (NODE_ENV production/test, HOPLENS=0) is checked first and is unchanged.

import fs from "node:fs";
import path from "node:path";
import type { Env } from "./gate";

export const PATH_FLAG_FILE = "path.json";

export type PathSource = "env" | "flag" | "default";

export interface PathFlag {
  enabled: true;
  /** ISO time it was turned on. */
  since: string;
  by: "ui" | "init";
}

export interface PathDecision {
  on: boolean;
  source: PathSource;
  /** The state dir the flag lives in (undefined when HOPLENS_OPTIONS has enabled: false). */
  stateDir?: string;
}

/**
 * The state dir Express uses, known before boot: HOPLENS_OPTIONS `stateDir` (resolved against its
 * `root`), else `<root>/node_modules/.cache/hoplens`, `root` being HOPLENS_OPTIONS `root` or the cwd.
 * Mirrors resolveOptions + core persistDir. Options given to hoplens(app, opts) come too late for
 * the register hook, so the flag always lives here.
 */
export function earlyStateDir(env: Env = process.env, cwd = process.cwd()): string | undefined {
  let o: any;
  try {
    o = env.HOPLENS_OPTIONS ? JSON.parse(env.HOPLENS_OPTIONS) : undefined;
  } catch {
    o = undefined;
  }
  if (o && typeof o === "object" && o.enabled === false) return undefined;
  const root = o && typeof o.root === "string" && o.root ? path.resolve(cwd, o.root) : cwd;
  const dir = o && typeof o.stateDir === "string" && o.stateDir ? o.stateDir : undefined;
  return dir ? path.resolve(root, dir) : path.join(root, "node_modules", ".cache", "hoplens");
}

/** The flag when it is there and says enabled; undefined when absent, unreadable or corrupt. */
export function readPathFlag(stateDir: string | undefined): PathFlag | undefined {
  if (!stateDir) return undefined;
  try {
    const o = JSON.parse(fs.readFileSync(path.join(stateDir, PATH_FLAG_FILE), "utf8"));
    if (!o || typeof o !== "object" || o.enabled !== true) return undefined;
    return {
      enabled: true,
      since: typeof o.since === "string" ? o.since : "",
      by: o.by === "init" ? "init" : "ui",
    };
  } catch {
    return undefined;
  }
}

/** Write the flag atomically (a temp file in the state dir, then a rename over path.json). */
export function writePathFlag(stateDir: string, by: PathFlag["by"], now = new Date()): PathFlag {
  const flag: PathFlag = { enabled: true, since: now.toISOString(), by };
  fs.mkdirSync(stateDir, { recursive: true });
  const target = path.join(stateDir, PATH_FLAG_FILE);
  const tmp = path.join(stateDir, `${PATH_FLAG_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(flag)}\n`);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
  return flag;
}

/** Remove the flag (a no-op when it is not there). */
export function removePathFlag(stateDir: string): void {
  fs.rmSync(path.join(stateDir, PATH_FLAG_FILE), { force: true });
}

/** HOPLENS_PATH when it is set (non-empty): true for 1/true, false for anything else. */
export function envPath(env: Env = process.env): boolean | undefined {
  const v = env.HOPLENS_PATH?.trim();
  if (!v) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

/** Whether the request path starts at this boot, and why. Synchronous and cheap; never throws. */
export function pathDecision(env: Env = process.env, cwd = process.cwd()): PathDecision {
  const stateDir = earlyStateDir(env, cwd);
  const fromEnv = envPath(env);
  if (fromEnv !== undefined) return { on: fromEnv, source: "env", stateDir };
  if (readPathFlag(stateDir)) return { on: true, source: "flag", stateDir };
  return { on: false, source: "default", stateDir };
}

/**
 * The switch core's toggle API drives (core PathControl, structurally): `pending` compares the flag
 * on disk with this boot's decision. Without a state dir (HOPLENS_OPTIONS enabled: false) writes throw.
 */
export function pathControl(d: PathDecision) {
  const dir = () => {
    if (!d.stateDir) throw new Error("no state dir (HOPLENS_OPTIONS has enabled: false)");
    return d.stateDir;
  };
  return {
    source: d.source,
    pending(): "on" | "off" | undefined {
      if (d.source === "env") return undefined;
      const want = !!readPathFlag(d.stateDir);
      if (want === d.on) return undefined;
      return want ? "on" : "off";
    },
    enable(): void {
      writePathFlag(dir(), "ui");
    },
    disable(): void {
      removePathFlag(dir());
    },
  };
}
