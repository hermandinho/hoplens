// The request path's sticky switch, for adapters that load core before they decide (Next: node.ts
// runs in the instrumentation hook, with core already loaded). `<stateDir>/path.json`
// ({"enabled":true,"since":ISO,"by":"ui"|"init"}), written by the UI's Enable button (POST
// /api/path/enable) or `hoplens init --path`, read at the next start. The Express register hook
// decides before core loads, so @hoplens/express keeps its own core-free copy of these few lines
// (packages/express/src/pathflag.ts): the file format is the same.
//
// Resolution at start (the adapter's gate first):
//   HOPLENS_PATH=1|true          -> on  (source 'env')
//   HOPLENS_PATH set otherwise   -> off (source 'env')
//   path.json with enabled:true  -> on  (source 'flag')
//   else (absent, corrupt)       -> off (source 'default')

import fs from "node:fs";
import path from "node:path";
import type { PathControl, PathSource } from "./capture";

export const PATH_FLAG_FILE = "path.json";

export interface PathFlagFile {
  enabled: true;
  since: string;
  by: "ui" | "init";
}

/** The flag when it is there and says enabled; undefined when absent, unreadable or corrupt. */
export function readPathFlagFile(stateDir: string | undefined): PathFlagFile | undefined {
  if (!stateDir) return undefined;
  try {
    const o = JSON.parse(fs.readFileSync(path.join(stateDir, PATH_FLAG_FILE), "utf8"));
    if (!o || typeof o !== "object" || o.enabled !== true) return undefined;
    return { enabled: true, since: typeof o.since === "string" ? o.since : "", by: o.by === "init" ? "init" : "ui" };
  } catch {
    return undefined;
  }
}

/** Write the flag atomically (a temp file in the state dir, then a rename over path.json). */
export function writePathFlagFile(stateDir: string, by: PathFlagFile["by"], now = new Date()): PathFlagFile {
  const flag: PathFlagFile = { enabled: true, since: now.toISOString(), by };
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
export function removePathFlagFile(stateDir: string): void {
  fs.rmSync(path.join(stateDir, PATH_FLAG_FILE), { force: true });
}

/** HOPLENS_PATH when it is set (non-empty): true for 1/true, false for anything else. */
export function envPathSetting(env: Record<string, string | undefined> = process.env): boolean | undefined {
  const v = env.HOPLENS_PATH?.trim();
  if (!v) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

/** This start's decision and the switch behind POST /api/path/enable|disable, for `stateDir`. */
export function flagPathControl(
  stateDir: string,
  env: Record<string, string | undefined> = process.env,
): { on: boolean; control: PathControl } {
  const fromEnv = envPathSetting(env);
  const source: PathSource = fromEnv !== undefined ? "env" : readPathFlagFile(stateDir) ? "flag" : "default";
  const on = fromEnv ?? source === "flag";
  return {
    on,
    control: {
      source,
      pending() {
        if (source === "env") return undefined;
        const want = !!readPathFlagFile(stateDir);
        if (want === on) return undefined;
        return want ? "on" : "off";
      },
      enable() {
        writePathFlagFile(stateDir, "ui");
      },
      disable() {
        removePathFlagFile(stateDir);
      },
    },
  };
}
