import fs from "node:fs";
import path from "node:path";
import { c, skip } from "../style";
import { flagStateDir, scriptEnv } from "./pathflag";
import { REGISTER, entryFiles, nodeCommands } from "./script";

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

/** What the Node running the app can do for function hops (the doctor reads its own Node: `node -v`). */
export interface NodeView {
  version: string;
  /** Node strips types itself, by default (`process.features.typescript`). */
  stripsTypes: boolean;
  /** The ESM hook API Hoplens picks there (@hoplens/transform register.ts hookApi()). */
  hookApi: "sync" | "async";
  /** `--import` modules evaluate in flag order (register.ts importOrderHonored(): Node 20.11+). */
  importOrdered: boolean;
}

/** This process's Node, as the register hook would see it on the same Node. */
export function currentNode(env: Env = process.env): NodeView {
  let hookApi: NodeView["hookApi"] = "async";
  let importOrdered = true;
  try {
    const r = require("@hoplens/transform/register") as typeof import("@hoplens/transform/register");
    hookApi = r.hookApi(env);
    importOrdered = r.importOrderHonored();
  } catch {
    /* an older transform: the defaults */
  }
  return {
    version: process.version,
    stripsTypes: Boolean((process as any).features?.typescript),
    hookApi,
    importOrdered,
  };
}

/** The Node the app will run on, as far as the project pins it: the spec and where it is set. */
export interface AppNode {
  spec: string;
  /** `package.json volta.node`, `.node-version`, `.nvmrc` or `package.json engines.node`. */
  from: string;
}

/** The app's Node version as the project pins it (volta, .node-version, .nvmrc, engines), or null. Exported for tests. */
export function appNodeVersion(root: string): AppNode | null {
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    pkg = undefined;
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const volta = str(pkg?.volta?.node);
  if (volta) return { spec: volta, from: "package.json volta.node" };
  for (const file of [".node-version", ".nvmrc"]) {
    try {
      const line = fs
        .readFileSync(path.join(root, file), "utf8")
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, "").trim())
        .find(Boolean);
      if (line) return { spec: line, from: file };
    } catch {
      /* not there */
    }
  }
  const engines = str(pkg?.engines?.node);
  return engines ? { spec: engines, from: "package.json engines.node" } : null;
}

const LTS: Record<string, number> = { fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };
const vkey = (major: number, minor = 0, patch = 0) => major * 1e6 + minor * 1e3 + patch;
/** Node strips types by default from 22.18 and from 23.6 (not 23.0 - 23.5). */
const STRIP_22 = vkey(22, 18);
const STRIP_23 = vkey(23, 6);

/** One semver comparator set as [lo, hi) over version keys, or null when it cannot be read. */
function interval(part: string): [number, number] | null {
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  const words = part
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const comps = words.length === 3 && words[1] === "-" ? [`>=${words[0]}`, `<=${words[2]}`] : words;
  for (const comp of comps) {
    if (/^[xX*]$/.test(comp)) continue;
    const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(comp);
    if (!m) return null;
    const op = m[1] ?? "=";
    const M = Number(m[2]);
    const mi = m[3] !== undefined && /^\d+$/.test(m[3]) ? Number(m[3]) : undefined;
    const pa = mi !== undefined && m[4] !== undefined && /^\d+$/.test(m[4]) ? Number(m[4]) : undefined;
    const floor = vkey(M, mi ?? 0, pa ?? 0);
    // The first version past the bucket the comparator names (`22` -> 23.0.0, `22.5` -> 22.6.0, `22.5.1` -> 22.5.2).
    const past = mi === undefined ? vkey(M + 1) : pa === undefined ? vkey(M, mi + 1) : vkey(M, mi, pa + 1);
    if (op === "=") {
      lo = Math.max(lo, floor);
      hi = Math.min(hi, past);
    } else if (op === "^") {
      lo = Math.max(lo, floor);
      hi = Math.min(hi, vkey(M + 1));
    } else if (op === "~") {
      lo = Math.max(lo, floor);
      hi = Math.min(hi, mi === undefined ? vkey(M + 1) : vkey(M, mi + 1));
    } else if (op === ">=") lo = Math.max(lo, floor);
    else if (op === ">") lo = Math.max(lo, past);
    else if (op === "<") hi = Math.min(hi, floor);
    else hi = Math.min(hi, past);
  }
  return lo < hi ? [lo, hi] : null;
}

/** Whether every Node the spec allows strips types by default, none does, or it depends. Exported for tests. */
export function specStripsTypes(spec: string): "yes" | "no" | "unknown" {
  const s = spec.trim().toLowerCase();
  const lts = /^lts\/([a-z]+)$/.exec(s);
  if (lts) {
    const major = LTS[lts[1]!];
    return major === undefined ? "unknown" : major >= 24 ? "yes" : "no";
  }
  const says = new Set<"yes" | "no">();
  for (const part of s.split("||")) {
    const r = interval(part);
    if (!r) return "unknown";
    const [lo, hi] = r;
    // A range from 22.18 up counts as stripping: only a pin inside 23.0 - 23.5 (an odd, end-of-life line) does not.
    const in23Gap = lo >= vkey(23) && hi <= STRIP_23;
    if (in23Gap || hi <= STRIP_22) says.add("no");
    else if (lo >= STRIP_22) says.add("yes");
    else return "unknown";
  }
  return says.size === 1 ? [...says][0]! : "unknown";
}

/** A TypeScript loader in a node command or NODE_OPTIONS: Node then does not run the .ts itself. */
const TS_LOADER =
  /(?:^|[\s=/"'])(?:tsx|ts-node|@swc-node\/register|@swc\/register|esbuild-register|@esbuild-kit\/[\w-]+|jiti|sucrase\/register|@babel\/register)(?:\/[\w./-]*)?(?=$|[\s"'])|(?:^|\s)--experimental-(?:strip|transform)-types\b/;
const NO_STRIP = /(?:^|\s)--no-experimental-strip-types\b/;

/**
 * The doctor's lines about the app's Node for this runner: `nope` for a row that cannot work there (a
 * .ts entry under plain node on a Node the project pins below type stripping, or with stripping
 * turned off), `warn` for one that may not (plain node on a .ts entry, the app's Node not known),
 * `note` for one that works differently or that the doctor cannot judge (a runner it does not
 * recognise). `app` is the Node the project pins (appNodeVersion): the doctor's own Node is not
 * necessarily the app's, so it is not used here. Exported for tests.
 */
export function nodeLines(
  cmd: string,
  runner: RunnerView,
  node: NodeView,
  app: AppNode | null = null,
  env: Env = {},
): { nope: string[]; warn: string[]; note: string[] } {
  const nope: string[] = [];
  const warn: string[] = [];
  const note: string[] = [
    node.hookApi === "sync"
      ? `Node ${node.version}: the ESM hook runs in-thread (module.registerHooks, as tsx's does on this Node); a cold start parses on the main thread, a warm one answers from the transform cache`
      : `Node ${node.version}: the ESM hook runs in Node's hooks worker (module.register)`,
  ];
  const isTs = (f: string) => /\.[cm]?ts$/.test(f);
  const nodeOptions = ` ${{ ...env, ...scriptEnv(cmd) }.NODE_OPTIONS ?? ""} `;
  if (runner.kind === "node" && !TS_LOADER.test(nodeOptions)) {
    // The plain node command that runs a .ts entry with no loader of its own.
    const plain = nodeCommands(cmd).find((words) => words.some(isTs) && !TS_LOADER.test(` ${words.join(" ")} `));
    const tsEntry = plain?.find(isTs);
    const fix = (entry: string) => `run it with tsx (tsx --import ${REGISTER} ${entry})`;
    if (plain && tsEntry) {
      const says = app ? specStripsTypes(app.spec) : "unknown";
      if (NO_STRIP.test(` ${plain.join(" ")} `) || NO_STRIP.test(nodeOptions))
        nope.push(
          `${tsEntry} is TypeScript and the dev script runs node with --no-experimental-strip-types — drop the flag (Node 22.18+), or ${fix(tsEntry)}`,
        );
      else if (says === "no")
        nope.push(
          `${tsEntry} is TypeScript and the app's Node (${app!.spec}, from ${app!.from}) does not strip types (22.18+ does by default, 22.6+ with --experimental-strip-types) — ${fix(tsEntry)} or a newer Node`,
        );
      else if (says === "unknown")
        warn.push(
          `${tsEntry} is TypeScript under plain node: that needs Node 22.18+ (22.6+ with --experimental-strip-types)${app ? `, and ${app.from} allows ${app.spec}` : ", and the project pins no Node version (engines.node, .nvmrc, .node-version)"} — on an older Node, ${fix(tsEntry)}`,
        );
    } else if (!plain) {
      const tsEntry = entryFiles(cmd).find(isTs);
      if (tsEntry && !TS_LOADER.test(` ${cmd} `))
        note.push(
          `${tsEntry} is TypeScript and the doctor does not recognise the dev script's runner, so it cannot tell what compiles it — function hops need it loaded through tsx, ts-node or Node 22.18+ type stripping`,
        );
    }
  }
  if (runner.kind === "tsx-first" && !node.importOrdered)
    note.push(
      `Node ${node.version} runs \`--import tsx\` after Hoplens' hook (20.9 / 20.10 do not keep --import order; 20.11+ do): Hoplens rewrites each file as on disk (RAW) and tsx compiles the result, so function hops are the same, but the request path cannot read tsx's output there (HOPLENS_PATH_DEBUGGER=1, or Node 20.11+)`,
    );
  return { nope, warn, note };
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
  node?: NodeView,
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
  const nodeSays = nodeLines(
    dev!.cmd,
    runner,
    node ?? currentNode({ ...env, ...scriptEnv(dev!.cmd) }),
    appNodeVersion(root),
    env,
  );
  for (const l of nodeSays.note) skip(l);
  for (const l of nodeSays.nope) nope(l, true);
  for (const l of nodeSays.warn) nope(l, false);
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
