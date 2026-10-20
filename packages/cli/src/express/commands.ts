import fs from "node:fs";
import path from "node:path";
import { addDevCommand, detectPackageManager, removeCommand, runCommand } from "../framework";
import { deleteFrom, insertInto } from "../json-edit";
import { type PromptIO, askYesNo } from "../prompt";
import { c, fail, ok, skip, warn } from "../style";
import { projectPackageJson, readJson } from "../util";
import { doctorFunctionHops } from "./hops";
import { appEnv, flagContent, flagPath, insideDir, readFlag, writeFlag } from "./pathflag";
import {
  DEV_SCRIPTS,
  STATE_DIR,
  codeWiring,
  diffLines,
  envFilesWithNodeOptions,
  findDevScript,
  guessPort,
  looksProduction,
  majorOf,
  nodemonExec,
  readPackageText,
} from "./project";
import { FLAG, REGISTER, REGISTER_RE, entryFiles, registerSpecifier, unwireScript, wireScript } from "./script";

const SUPPORTED_EXPRESS = [4, 5];

/**
 * `hoplens init` for Express: adds `--import hoplens/express/register` to the dev script and nothing
 * else (never `start`, never the entry file). package.json keeps every other byte.
 */
export async function initExpress(root: string, pkg: any, dryRun: boolean, pathOpt: PathOption = {}) {
  const pm = detectPackageManager(root, pkg);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const major = majorOf(readJson(projectPackageJson("express", root))?.version ?? deps.express);
  if (!deps.express) warn("This project doesn't list express in its dependencies.");
  else if (major && !SUPPORTED_EXPRESS.includes(major))
    warn(`Express ${major} detected. Hoplens supports Express 4 and 5.`);

  const src = readPackageText(root) ?? "";
  const dev = findDevScript(src);
  if (!dev) {
    const start = typeof pkg.scripts?.start === "string" ? pkg.scripts.start : null;
    // A production start (NODE_ENV=production turns the dev gate off) or one that runs built output
    // makes a poor dev line, and so does a `main` in dist/.
    const built = (f: string) => /^(\.\/)?(dist|build)\//.test(f);
    const devLike = !!start && !looksProduction("", start) && !entryFiles(start).some(built);
    const wiredStart = start && devLike ? wireScript(start) : null;
    const main = typeof pkg.main === "string" && !built(pkg.main) ? pkg.main : "<your entry file>";
    let suggestion = `node --watch ${FLAG} ${main}`;
    if (wiredStart?.kind === "wired" && wiredStart.runner === "node") {
      // Derive it from start, with --watch, without touching start itself.
      const watched = /^\s*node\s+--watch\b/.test(start!) ? start! : start!.replace(/\bnode\b/, "node --watch");
      const w = wireScript(watched);
      if (w.kind === "wired") suggestion = w.out;
    }
    warn(`No dev script in package.json (looked for ${DEV_SCRIPTS.join(", ")}). Add one to "scripts":`);
    console.log(`\n    ${c.bold(`"dev": ${JSON.stringify(suggestion)}`)}\n`);
    installHint(deps, pm);
    await initPath(root, null, dryRun, { ...pathOpt, ask: false });
    return;
  }

  const cmd = dev.span.value;
  const result = wireScript(cmd, { nodemonExec: nodemonExec(root, pkg) });
  if (result.kind === "already") {
    skip(`scripts.${dev.key} already wired (loads ${registerSpecifier(cmd)})`);
  } else if (result.kind === "manual") {
    warn(`Didn't edit scripts.${dev.key}: ${result.reason}. Change it yourself:`);
    console.log(
      result.script
        ? `\n    ${c.bold(`"${dev.key}": ${JSON.stringify(result.script)}`)}\n`
        : `\n    ${c.bold(result.hint ?? `add ${FLAG} to the node command that starts your app`)}\n`,
    );
    installHint(deps, pm);
    await initPath(root, { key: dev.key, cmd }, dryRun, { ...pathOpt, ask: false });
    return;
  } else {
    const out = insertInto(src, dev.span, result.at, result.text);
    if (dryRun) console.log(`${diffLines("package.json", src, out, dev.span.start)}`);
    else fs.writeFileSync(path.join(root, "package.json"), out);
    ok(`${dryRun ? "Would add" : "Added"} ${FLAG} to scripts.${dev.key}`);
  }

  installHint(deps, pm);
  await initPath(root, { key: dev.key, cmd }, dryRun, pathOpt);
  const port = guessPort(root, cmd, pkg) ?? "<your port>";
  console.log(
    `\n${c.green("Done.")} Run ${c.bold(runCommand(pm, dev.key))} and open ${c.bold(`http://localhost:${port}/__hoplens`)}\n`,
  );
}

export type PathOption = {
  /** --path (true) / --no-path (false); undefined: ask when interactive, else leave it off. */
  flag?: boolean;
  io?: PromptIO;
  /** false: never ask (the script was not wired). */
  ask?: boolean;
};

export const PATH_QUESTION = "Enable request path tracing? (block coverage; slower for CPU-heavy code) [y/N] ";

/**
 * The request path's sticky flag: --path writes it, --no-path removes it, else ask when interactive
 * (default no, and no question when it is already on). Same file the UI's Enable button writes, in
 * the state dir the register hook resolves (HOPLENS_OPTIONS from the dev script too), or for Next the
 * one @hoplens/next reads (`loc`). HOPLENS_PATH
 * (dev script or environment) wins over the flag at boot: then no question, and --path / --no-path
 * still write / remove it but say it has no effect while HOPLENS_PATH is set.
 */
export async function initPath(
  root: string,
  dev: { key: string; cmd: string } | null,
  dryRun: boolean,
  opt: PathOption,
  /** The flag's location (default: the Express register hook's; Next passes its own). */
  loc: { abs: string; rel: string } = flagPath(root, appEnv(dev?.cmd)),
): Promise<void> {
  const { abs, rel } = loc;
  const now = readFlag(abs);
  const override = pathEnvOverride(dev, process.env);
  const overrideNote = override
    ? `request path is set by HOPLENS_PATH=${override.value} in ${override.where}, which wins over ${rel} at boot`
    : "";
  let want = opt.flag;
  if (want === undefined && override) {
    skip(`The ${overrideNote}; not asking (unset it to use the flag)`);
    return;
  }
  if (want === undefined) {
    if (now === "on") {
      skip(
        `Request path already enabled (${rel}); disable it in the Path view (press x on a request) or with hoplens init --no-path`,
      );
      return;
    }
    if (opt.ask === false || !opt.io?.interactive) return;
    want = await askYesNo(PATH_QUESTION, opt.io);
    if (!want) return;
  }
  if (want) {
    if (now === "on") {
      skip(`Request path already enabled (${rel})`);
      return;
    }
    const content = flagContent("init");
    if (dryRun) console.log(`${c.dim(`--- ${rel} (create)`)}\n${content}`);
    else {
      try {
        writeFlag(abs, content);
      } catch (err) {
        warn(`Couldn't write ${rel}: ${(err as Error).message}`);
        return;
      }
    }
    if (override)
      warn(
        `${dryRun ? "Would write" : "Wrote"} ${rel}, but the ${overrideNote}: the flag has no effect while it is set`,
      );
    else
      ok(
        `${dryRun ? "Would enable" : "Enabled"} request path tracing (${rel}); block coverage runs from the app's start, so CPU-heavy code runs slower. HOPLENS_PATH=0 overrides it`,
      );
    return;
  }
  if (!now) return;
  if (dryRun) console.log(`${c.dim(`--- ${rel} (delete)`)}\n`);
  else {
    try {
      fs.rmSync(abs, { force: true });
    } catch (err) {
      warn(`Couldn't delete ${rel}: ${(err as Error).message}`);
      return;
    }
  }
  if (override)
    warn(
      `${dryRun ? "Would delete" : "Deleted"} ${rel}, but the ${overrideNote}: the flag has no effect while it is set`,
    );
  else ok(`${dryRun ? "Would disable" : "Disabled"} request path tracing (${rel})`);
}

function installHint(deps: Record<string, string>, pm: ReturnType<typeof detectPackageManager>) {
  if (deps.hoplens) return;
  if (deps["@hoplens/express"])
    warn(
      `The script loads ${REGISTER} from the hoplens package; install it too (pnpm doesn't hoist @hoplens/express): ${c.bold(addDevCommand(pm, "hoplens"))}`,
    );
  else warn(`Install the runtime: ${c.bold(addDevCommand(pm, "hoplens"))}`);
}

/** `hoplens remove` for Express: takes init's flag out of the dev script and deletes the state dir. */
export function removeExpress(root: string, pkg: any, dryRun: boolean) {
  const pm = detectPackageManager(root, pkg);
  const src = readPackageText(root) ?? "";
  let out: string | null = null;
  let at = 0;
  let byHand = false;
  for (const key of DEV_SCRIPTS) {
    const dev = findDevScript(src, [key]);
    if (!dev || !REGISTER_RE.test(dev.span.value)) continue;
    const range = unwireScript(dev.span.value);
    if (!range) {
      warn(`scripts.${key} loads ${registerSpecifier(dev.span.value)} in a form init didn't write. Remove it by hand.`);
      byHand = true;
      continue;
    }
    out = deleteFrom(src, dev.span, range.from, range.to);
    at = dev.span.start;
    ok(`${dryRun ? "Would remove" : "Removed"} ${FLAG} from scripts.${key}`);
    break;
  }
  const data = fs.existsSync(path.join(root, STATE_DIR)) ? STATE_DIR : null;
  // The request path flag goes with the state dir; one HOPLENS_OPTIONS moved elsewhere (in the dev
  // script, as the register hook reads it, or in this shell) goes on its own.
  const wired =
    DEV_SCRIPTS.map((k) => findDevScript(src, [k])).find((d) => d && REGISTER_RE.test(d.span.value)) ??
    findDevScript(src);
  const candidates = [flagPath(root, appEnv(wired?.span.value)), flagPath(root)];
  const strayFlag =
    candidates.find(
      (f, i) =>
        candidates.findIndex((g) => g.abs === f.abs) === i &&
        !insideDir(path.join(root, STATE_DIR), f.abs) &&
        fs.existsSync(f.abs),
    ) ?? null;

  if (!out && !data && !strayFlag) {
    skip(
      byHand
        ? "Nothing removed automatically — edit the script above by hand."
        : "Nothing to remove — Hoplens isn't wired into this project.",
    );
    return;
  }
  if (out) {
    if (dryRun) console.log(diffLines("package.json", src, out, at));
    else {
      try {
        fs.writeFileSync(path.join(root, "package.json"), out);
      } catch (err) {
        fail(`Couldn't write package.json: ${(err as Error).message}`);
        return;
      }
    }
  }
  if (data) {
    if (dryRun) console.log(`${c.dim(`--- ${data} (delete)`)}\n`);
    else {
      try {
        fs.rmSync(path.join(root, data), { recursive: true, force: true });
        ok(`Deleted ${data}`);
      } catch (err) {
        warn(`Couldn't delete ${data}: ${(err as Error).message}`);
      }
    }
  }
  if (strayFlag) {
    if (dryRun) console.log(`${c.dim(`--- ${strayFlag.rel} (delete)`)}\n`);
    else {
      try {
        fs.rmSync(strayFlag.abs, { force: true });
        ok(`Deleted ${strayFlag.rel}`);
      } catch (err) {
        warn(`Couldn't delete ${strayFlag.rel}: ${(err as Error).message}`);
      }
    }
  }
  console.log(
    `\n${c.green("Done.")} If you no longer need Hoplens, uninstall it: ${c.bold(removeCommand(pm, "hoplens"))}\n`,
  );
}

type Report = { good: (s: string) => void; nope: (s: string, critical?: boolean) => void };

/** The Install and Wiring sections of `hoplens doctor` for an Express project. */
export function doctorExpress(root: string, pkg: any, { good, nope }: Report) {
  const pm = detectPackageManager(root, pkg);
  const src = readPackageText(root) ?? "";
  const scripts: Record<string, unknown> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};

  // ── Install ─────────────────────────────────────────────────────────────
  console.log(`\n${c.dim("  Install")}`);
  const expressPkg = readJson(projectPackageJson("express", root));
  if (!expressPkg) nope("express is not installed", true);
  else {
    const major = majorOf(expressPkg.version);
    if (SUPPORTED_EXPRESS.includes(major)) good(`Express ${expressPkg.version}`);
    else nope(`Express ${expressPkg.version} isn't supported — Hoplens supports Express 4 and 5`, major < 4);
  }

  const meta = !!projectPackageJson("hoplens", root);
  const scoped = !!projectPackageJson("@hoplens/express", root);
  if (meta) good("hoplens runtime is installed");
  else if (scoped) good("@hoplens/express is installed");
  else nope(`hoplens runtime is not installed — run ${addDevCommand(pm, "hoplens")}`, true);

  // ── Wiring ──────────────────────────────────────────────────────────────
  console.log(`\n${c.dim("  Wiring")}`);
  const dev = findDevScript(src);
  const devCmd = dev?.span.value ?? null;
  const inCode = codeWiring(root, devCmd, pkg);
  const devSpec = devCmd ? registerSpecifier(devCmd) : null;

  if (dev && devSpec) {
    good(`scripts.${dev.key} loads ${devSpec}`);
    const owner = devSpec.startsWith("@") ? "@hoplens/express" : "hoplens";
    if ((owner === "hoplens" && !meta) || (owner === "@hoplens/express" && !scoped)) {
      nope(
        owner === "@hoplens/express"
          ? `scripts.${dev.key} loads @hoplens/express/register but @hoplens/express isn't resolvable from this project (pnpm doesn't hoist it) — install hoplens and use ${REGISTER}`
          : `scripts.${dev.key} loads ${REGISTER} but the hoplens package isn't resolvable — run ${addDevCommand(pm, "hoplens")}`,
        true,
      );
    }
    if (/\bNODE_ENV=["']?production\b/.test(devCmd!))
      nope(`scripts.${dev.key} sets NODE_ENV=production — the dev gate is off, so Hoplens won't start`, false);
  } else if (inCode.length) {
    skip(`hoplens(app) is called in ${inCode.join(", ")} — wired from code, no register hook needed`);
  } else if (dev) {
    nope(`scripts.${dev.key} doesn't load ${REGISTER} — run npx hoplens init`, true);
  } else {
    nope(`No dev script in package.json (looked for ${DEV_SCRIPTS.join(", ")}) — run npx hoplens init`, true);
  }
  if (dev && devSpec && inCode.length)
    skip(`hoplens(app) is also called in ${inCode.join(", ")} — the register hook already covers it`);

  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== "string" || !REGISTER_RE.test(value)) continue;
    if (name !== dev?.key && looksProduction(name, value))
      nope(
        `scripts.${name} loads the Hoplens register hook — keep it out of production scripts (dev scripts only)`,
        true,
      );
    if (/\bNODE_OPTIONS=/.test(value))
      nope(
        `scripts.${name} preloads Hoplens through NODE_OPTIONS — every child node process loads it too; put ${FLAG} on the app's node command instead`,
        false,
      );
  }
  for (const file of envFilesWithNodeOptions(root))
    nope(
      `${file} sets NODE_OPTIONS with the Hoplens register hook — every node process that reads it loads Hoplens; put ${FLAG} in scripts.dev instead`,
      false,
    );

  doctorPath(dev ? { key: dev.key, cmd: devCmd ?? "" } : null, process.env, { nope }, flagPath(root, appEnv(devCmd)));

  // ── Function hops ───────────────────────────────────────────────────────
  const wired = !!(dev && devSpec);
  doctorFunctionHops(
    root,
    dev ? { key: dev.key, cmd: devCmd ?? "" } : null,
    wired,
    inCode,
    wired ? commonJSEntryUnderImport(root, devCmd!, pkg) : null,
    process.env,
    { nope },
  );
}

const PATH_FLAG_RE = /\bHOPLENS_PATH=["']?(?:1|true)\b/i;
const PATH_ENV_RE = /\bHOPLENS_PATH=["']?([^\s"';&|]*)/i;
const V8_COVERAGE_RE = /\bNODE_V8_COVERAGE=|(?:^|[\s;&|])c8(?=$|\s)/;

/**
 * The request path, as the register hook will decide it: HOPLENS_PATH in the dev script or the
 * environment wins (1/true on, anything else off), else the sticky flag file (`hoplens init --path`
 * or the Path view's Enable), else off. Warns when it would be on with NODE_V8_COVERAGE (c8) set too,
 * which keeps it disabled, and when the flag file is not valid JSON. Exported for tests.
 */
/**
 * HOPLENS_PATH as the register hook will see it: a non-empty value in the dev script, else in the
 * environment; undefined when neither sets it (the flag decides). Exported for tests.
 */
export function pathEnvOverride(
  dev: { key: string; cmd: string } | null,
  env: Record<string, string | undefined>,
): { value: string; where: string; on: boolean } | undefined {
  const scriptValue = dev ? PATH_ENV_RE.exec(dev.cmd)?.[1] : undefined;
  if (scriptValue !== undefined && scriptValue !== "")
    return { value: scriptValue, where: `scripts.${dev!.key}`, on: PATH_FLAG_RE.test(dev!.cmd) };
  const envValue = env.HOPLENS_PATH?.trim() || undefined;
  if (envValue === undefined) return undefined;
  return { value: envValue, where: "the environment", on: envValue === "1" || envValue.toLowerCase() === "true" };
}

export function doctorPath(
  dev: { key: string; cmd: string } | null,
  env: Record<string, string | undefined>,
  { nope }: Pick<Report, "nope">,
  flag?: { abs: string; rel: string },
): void {
  const override = pathEnvOverride(dev, env);
  const value = override?.value;
  const where = override?.where;
  const flagState = flag ? readFlag(flag.abs) : undefined;
  let on: boolean;
  if (override) {
    on = override.on;
    if (on)
      skip(
        `request path: on (HOPLENS_PATH) — HOPLENS_PATH=${value} in ${where}: V8 block coverage runs from boot, so CPU-heavy code runs slower; Trace path replays a GET once to show which branches ran`,
      );
    else
      skip(
        `request path: off (HOPLENS_PATH=${value} in ${where}${flagState === "on" ? `; it wins over ${flag!.rel}` : ""})`,
      );
  } else if (flagState === "on") {
    on = true;
    skip(
      `request path: on (flag) — ${flag!.rel}: V8 block coverage runs from boot, so CPU-heavy code runs slower; disable it in the Path view (press x on a request)`,
    );
  } else {
    on = false;
    skip("request path: off — enable it in the Path view (press x on a request) or with hoplens init --path");
  }
  if (flagState === "corrupt")
    nope(
      `${flag!.rel} is not a valid request path flag (ignored, so the path stays off) — delete it or enable again`,
      false,
    );
  const c8 = (!!dev && V8_COVERAGE_RE.test(dev.cmd)) || !!env.NODE_V8_COVERAGE;
  if (on && c8)
    nope(
      value !== undefined
        ? "HOPLENS_PATH=1 is set with NODE_V8_COVERAGE (c8) — the request path stays disabled so c8's coverage is not reset; drop one of them"
        : `the request path flag (${flag!.rel}) is set with NODE_V8_COVERAGE (c8) — the request path stays disabled so c8's coverage is not reset; disable one of them`,
      false,
    );
}

/**
 * The dev script's entry when Hoplens is loaded with `--import` and the entry is a CommonJS file that
 * assigns functions to its exports: Node runs such an entry through its ESM loader, which reads the
 * source itself, so the CommonJS layer cannot rewrite that one file. Null otherwise, and null under tsx
 * (`tsx [watch] --import ...`, `--import tsx`): tsx loads the entry so that it is wrapped.
 */
export function commonJSEntryUnderImport(root: string, devCmd: string, pkg: any): string | null {
  if (!/--import[=\s]+["']?(?:@hoplens\/express|hoplens\/express)\/register\b/.test(devCmd)) return null;
  if (/(?:^|[\s;&|=/"'])tsx(?:\/esm)?(?=$|[\s"';&|])/.test(devCmd)) return null;
  const entry = entryFiles(devCmd)[0];
  // TypeScript Node strips itself (.ts, .cts) reaches the ESM hook with its source, and is wrapped there.
  if (!entry || /\.(m(j|t)s|c?ts)$/.test(entry)) return null;
  if (!/\.cjs$/.test(entry) && pkg?.type === "module") return null;
  let src: string;
  try {
    src = fs.readFileSync(path.join(root, entry), "utf8");
  } catch {
    return null;
  }
  if (/^\s*(?:import\s*[\w{*"']|export\s)/m.test(src)) return null;
  // A function (or an object of them), or a local name (`exports.f = f`, tsc's output) assigned to
  // exports, or Object.defineProperty(exports, ...): the shapes the CommonJS layer wraps.
  const exportsFn =
    /\b(?:module\.)?exports\s*(?:\.\s*[\w$]+)?\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>|\{)|\b(?:module\.)?exports\s*\.\s*[\w$]+\s*=\s*(?!void\b|null\b|undefined\b|true\b|false\b|\d)[\w$]+\s*(?:;|$)|\bdefineProperty\(\s*(?:module\.)?exports\s*,\s*["'](?!__esModule["'])/m;
  return exportsFn.test(src) ? entry : null;
}
