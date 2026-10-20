import fs from "node:fs";
import path from "node:path";
import { c, skip } from "../style";
import { flagStateDir, scriptEnv } from "./pathflag";
import { REGISTER } from "./script";

// The "Function hops" section of `hoplens doctor` for Express. The CLI does not depend on the runtime,
// so the few rules the register hook applies at boot are repeated here (packages/express/src/
// autotrace.ts: readAutoTrace, defaultInclude, FALLBACK_DIRS, transformCacheDir; a CLI test keeps
// FALLBACK_DIRS equal). Refusal reasons use the names the transform reports and the debug log prints
// (`refused=<reason>`: compiled, unmapped, commonjs, esm-loader, large).

type Report = { good: (s: string) => void; nope: (s: string, critical?: boolean) => void };
type Env = Record<string, string | undefined>;

/** Directories searched when the app has no `src/` (same list as @hoplens/express FALLBACK_DIRS). */
export const FALLBACK_DIRS = [
  "app",
  "pages",
  "lib",
  "server",
  "components",
  "utils",
  "services",
  "features",
  "modules",
  "db",
  "prisma",
  "drizzle",
  "routes",
  "controllers",
  "middleware",
  "models",
];

const OFF = /^(?:0|false|off)$/i;

/** Where an env var the app sees comes from: the dev script's own assignment, else the environment. */
function whereSet(name: string, dev: { key: string; cmd: string } | null, env: Env): string | undefined {
  if (dev && scriptEnv(dev.cmd)[name] !== undefined) return `scripts.${dev.key}`;
  return env[name] !== undefined ? "the environment" : undefined;
}

function parseOptions(appEnv: Env): any {
  try {
    const o = appEnv.HOPLENS_OPTIONS ? JSON.parse(appEnv.HOPLENS_OPTIONS) : undefined;
    return o && typeof o === "object" ? o : undefined;
  } catch {
    return undefined;
  }
}

export interface AutoTraceView {
  on: boolean;
  /** What decided it, for the message: `default`, or `HOPLENS_AUTOTRACE=0 in scripts.dev`. */
  from: string;
  include?: string[];
  exclude?: string[];
}

/** autoTrace as the register hook will read it (express readAutoTrace). Exported for tests. */
export function autoTraceView(dev: { key: string; cmd: string } | null, env: Env): AutoTraceView {
  const app = { ...env, ...scriptEnv(dev?.cmd) };
  const flag = app.HOPLENS_AUTOTRACE?.trim();
  if (flag && OFF.test(flag))
    return { on: false, from: `HOPLENS_AUTOTRACE=${flag} in ${whereSet("HOPLENS_AUTOTRACE", dev, env)}` };
  const o = parseOptions(app);
  const where = () => `HOPLENS_OPTIONS in ${whereSet("HOPLENS_OPTIONS", dev, env)}`;
  if (o?.enabled === false) return { on: false, from: `enabled: false in ${where()}` };
  if (o?.autoTrace === false) return { on: false, from: `autoTrace: false in ${where()}` };
  if (o?.autoTrace && typeof o.autoTrace === "object") {
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined;
    const include = strings(o.autoTrace.include);
    const exclude = strings(o.autoTrace.exclude);
    return {
      on: true,
      from: `autoTrace in ${where()}`,
      ...(include?.length ? { include } : {}),
      ...(exclude?.length ? { exclude } : {}),
    };
  }
  return { on: true, from: "default" };
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The default scope: `src/**`, else each FALLBACK_DIRS dir present (express defaultInclude). */
export function defaultScope(root: string): string[] {
  const dirs = isDir(path.join(root, "src")) ? ["src"] : FALLBACK_DIRS.filter((d) => isDir(path.join(root, d)));
  return dirs.map((d) => `${d}/**`);
}

export type RunnerView =
  | { kind: "tsx-first" }
  | { kind: "hoplens-first" }
  | { kind: "ts-node-esm" }
  | { kind: "ts-node-cjs" }
  | { kind: "node"; preload: "import" | "require" };

/** `--import x` / `--import=x` / `-r x` / `--require x` / `--loader x` / `--experimental-loader x`: their values, in order. */
function preloads(cmd: string): { flag: string; value: string; at: number }[] {
  const out: { flag: string; value: string; at: number }[] = [];
  const re = /(?:^|\s)(--import|--require|-r|--loader|--experimental-loader)(?:=|\s+)["']?([^\s"']+)/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) out.push({ flag: m[1]!, value: m[2]!, at: m.index });
  return out;
}

/** How the dev script loads Hoplens relative to a TypeScript loader. Exported for tests. */
export function runnerView(cmd: string): RunnerView {
  const pre = preloads(cmd);
  const ours = pre.find((p) => /(?:@hoplens\/express|hoplens\/express)\/register\b/.test(p.value));
  const tsx = pre.find((p) => /^tsx(?:\/esm)?$/.test(p.value));
  const tsNodeEsm =
    pre.some((p) => /^ts-node\/esm\b/.test(p.value)) ||
    /(?:^|[\s;&|/])ts-node-esm(?=$|[\s;&|])/.test(cmd) ||
    /(?:^|[\s;&|/])ts-node\s+(?:[^;&|]*\s)?--esm\b/.test(cmd);
  if (tsNodeEsm) return { kind: "ts-node-esm" };
  // Node runs every -r / --require before any --import (the tsx CLI's own loader included), so a -r
  // register hook is registered first and sees each file as on disk, wherever it sits in the command.
  const oursRequired = ours?.flag === "-r" || ours?.flag === "--require";
  const tsxCli = /(?:^|[\s;&|/"'])tsx(?:\s+watch)?\s/.test(cmd);
  if ((tsxCli || tsx) && oursRequired) return { kind: "hoplens-first" };
  // The tsx CLI registers its loader before any --import it is given.
  if (tsxCli && !tsx) return { kind: "tsx-first" };
  if (tsx && ours) return tsx.at < ours.at ? { kind: "tsx-first" } : { kind: "hoplens-first" };
  if (tsx) return { kind: "tsx-first" };
  if (pre.some((p) => /^ts-node\/register\b/.test(p.value)) || /(?:^|[\s;&|/])ts-node(?=$|[\s;&|])/.test(cmd))
    return { kind: "ts-node-cjs" };
  return { kind: "node", preload: oursRequired ? "require" : "import" };
}

/** What the runner gets from function hops, in one line. Exported for tests. */
export function runnerLine(r: RunnerView): string {
  switch (r.kind) {
    case "tsx-first":
      return "runner: tsx, then Hoplens — tsx compiles each .ts/.mts first and Hoplens maps its output back to the source (COMPILED); a file it cannot map loads untouched (refused=unmapped). CommonJS goes through the CommonJS layer";
    case "hoplens-first":
      return "runner: Hoplens, then tsx — Hoplens rewrites each file as it is on disk (RAW) and tsx compiles the result. CommonJS goes through the CommonJS layer";
    case "ts-node-cjs":
      return "runner: ts-node (CommonJS) — the CommonJS layer hands ts-node each file as on disk plus the trailer";
    case "ts-node-esm":
      return "runner: ts-node's ESM loader";
    case "node":
      return r.preload === "require"
        ? "runner: node -r — CommonJS modules, the entry included, go through the CommonJS layer; ES modules are rewritten as on disk (RAW)"
        : "runner: node --import — ES modules (and TypeScript Node strips itself) are rewritten as on disk (RAW); CommonJS modules they require go through the CommonJS layer";
  }
}

/** The transform cache's dir as the register hook resolves it, or why it is off. Exported for tests. */
export function cacheView(
  root: string,
  dev: { key: string; cmd: string } | null,
  env: Env,
): { dir: string } | { off: string } {
  const app = { ...env, ...scriptEnv(dev?.cmd) };
  const flag = app.HOPLENS_TRANSFORM_CACHE?.trim();
  if (flag && OFF.test(flag))
    return { off: `HOPLENS_TRANSFORM_CACHE=${flag} in ${whereSet("HOPLENS_TRANSFORM_CACHE", dev, env)}` };
  if (parseOptions(app)?.transformCache === false)
    return { off: `transformCache: false in HOPLENS_OPTIONS in ${whereSet("HOPLENS_OPTIONS", dev, env)}` };
  return { dir: path.join(flagStateDir(root, app), "transform") };
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `hoplens doctor`'s Function hops section. `wired`: the dev script loads the register hook (function
 * hops need it); `inCode`: files that call hoplens(app); `cjsEntry`: a CommonJS entry with exports
 * loaded under --import (commonJSEntryUnderImport), or null.
 */
export function doctorFunctionHops(
  root: string,
  dev: { key: string; cmd: string } | null,
  wired: boolean,
  inCode: string[],
  cjsEntry: string | null,
  env: Env,
  { nope }: Pick<Report, "nope">,
): void {
  if (!wired && !inCode.length) return;
  console.log(`\n${c.dim("  Function hops")}`);
  if (!wired) {
    skip(
      `function hops: off — hoplens(app) runs after your modules loaded; load ${REGISTER} in the dev script to wrap their exported functions`,
    );
    return;
  }
  const at = autoTraceView(dev, env);
  if (!at.on) {
    skip(`function hops: off (${at.from})`);
    return;
  }
  const scope = at.include ?? defaultScope(root);
  const from = at.from === "default" ? "on by default" : `on (${at.from})`;
  if (!scope.length)
    skip(
      `function hops: ${from}, but nothing is in scope (no src/ and none of ${FALLBACK_DIRS.slice(0, 4).join(", ")}, ...) — set autoTrace.include in HOPLENS_OPTIONS`,
    );
  else
    skip(
      `function hops: ${from} — the exported functions of ${scope.join(", ")}${at.exclude?.length ? `, except ${at.exclude.join(", ")}` : ""}`,
    );

  const runner = runnerView(dev!.cmd);
  skip(runnerLine(runner));
  if (runner.kind === "ts-node-esm")
    nope(
      "ts-node's ESM loader is untested with function hops (its output may be refused, refused=compiled / unmapped) — use tsx, or ts-node's CommonJS register (-r ts-node/register)",
      false,
    );
  if (cjsEntry)
    skip(
      `${cjsEntry} is a CommonJS entry with exports: under --import Node loads it through its ESM loader, so its own functions get no function hops (refused=esm-loader; the modules it requires do) — preload with -r ${REGISTER} to cover it too`,
    );

  const cache = cacheView(root, dev, env);
  if ("off" in cache) skip(`transform cache: off (${cache.off}) — every start parses each file with TypeScript`);
  else {
    const rel = (path.relative(root, cache.dir) || cache.dir).split(path.sep).join("/");
    let entries = 0;
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(cache.dir)) {
        // Entries are `<key>.hlc` (@hoplens/transform cache.ts ENTRY_EXT); temp files and the stamp are not counted.
        if (!name.endsWith(".hlc")) continue;
        try {
          bytes += fs.statSync(path.join(cache.dir, name)).size;
          entries++;
        } catch {
          /* gone meanwhile */
        }
      }
    } catch {
      /* not there yet */
    }
    skip(
      entries
        ? `transform cache: ${rel} (${plural(entries, "file")}, ${kb(bytes)}) — a restart with unchanged files loads no TypeScript; HOPLENS_TRANSFORM_CACHE=0 turns it off`
        : `transform cache: ${rel} (empty until the app starts) — a restart with unchanged files loads no TypeScript`,
    );
  }
  skip(
    `skip files: HOPLENS_OPTIONS='{"autoTrace":{"exclude":["src/generated/**"]}}'; HOPLENS_DEBUG=transform prints each file with export syntax, its mode and why one was refused`,
  );
}
