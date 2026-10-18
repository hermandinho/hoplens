import fs from "node:fs";
import path from "node:path";
import { addDevCommand, detectPackageManager, removeCommand, runCommand } from "../framework";
import { deleteFrom, insertInto } from "../json-edit";
import { c, fail, ok, skip, warn } from "../style";
import { projectPackageJson, readJson } from "../util";
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
export function initExpress(root: string, pkg: any, dryRun: boolean) {
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
    return;
  } else {
    const out = insertInto(src, dev.span, result.at, result.text);
    if (dryRun) console.log(`${diffLines("package.json", src, out, dev.span.start)}`);
    else fs.writeFileSync(path.join(root, "package.json"), out);
    ok(`${dryRun ? "Would add" : "Added"} ${FLAG} to scripts.${dev.key}`);
  }

  installHint(deps, pm);
  const port = guessPort(root, cmd, pkg) ?? "<your port>";
  console.log(
    `\n${c.green("Done.")} Run ${c.bold(runCommand(pm, dev.key))} and open ${c.bold(`http://localhost:${port}/__hoplens`)}\n`,
  );
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

  if (!out && !data) {
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
}
