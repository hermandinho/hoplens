#!/usr/bin/env node
/**
 * Install-flow smoke: pack the hoplens meta package and every workspace package
 * it depends on (transitively) into tarballs, install them into a scratch Next
 * 16 project, run `hoplens init`, then run `hoplens doctor` and expect it to
 * pass. This simulates `npm i -D hoplens` end-to-end
 * for a greenfield user.
 *
 * Writes to two temp dirs: one for the tarballs, one for the scratch project.
 * Both are removed on success. Pass `--keep` to leave them for inspection.
 *
 * Usage: pnpm --filter hoplens-e2e verify:install
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const KEEP = process.argv.includes("--keep");
const SHELL = process.platform === "win32";

const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
const META_NAME = "hoplens";

function log(line = "") {
  process.stdout.write(`${line}\n`);
}
function step(line) {
  log(`\n  \x1b[36m→\x1b[0m ${line}`);
}
function ok(line) {
  log(`  \x1b[32m✓\x1b[0m ${line}`);
}
function fail(msg) {
  process.stderr.write(`\n  \x1b[31m✗\x1b[0m ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: SHELL });
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

function runCapture(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], shell: SHELL });
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${res.status}`);
  return res.stdout.toString();
}

/** Every workspace package under packages/, by package name. */
function workspacePackages() {
  const byName = new Map();
  for (const dir of fs.readdirSync(PACKAGES_DIR)) {
    const file = path.join(PACKAGES_DIR, dir, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    byName.set(pkg.name, { dir: path.join(PACKAGES_DIR, dir), pkg });
  }
  return byName;
}

/**
 * The meta package plus every workspace package it reaches through `workspace:`
 * dependencies, so a new adapter the meta package depends on is packed (and
 * overridden) without editing this script.
 */
function packSet() {
  const byName = workspacePackages();
  if (!byName.has(META_NAME)) fail(`No workspace package named ${META_NAME}`);
  const seen = new Map();
  const queue = [META_NAME];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const entry = byName.get(name);
    if (!entry) fail(`${name} is a workspace: dependency but no packages/* has that name`);
    seen.set(name, entry);
    for (const [dep, range] of Object.entries(entry.pkg.dependencies ?? {})) {
      if (String(range).startsWith("workspace:")) queue.push(dep);
    }
  }
  return seen;
}

/** `@hoplens/cli` + `0.1.0` → `hoplens-cli-0.1.0.tgz` (npm's packing convention). */
function tarballName(pkgName, version) {
  const flat = pkgName.replace(/^@/, "").replace(/\//g, "-");
  return `${flat}-${version}.tgz`;
}

log("\n\x1b[35m◆ Hoplens\x1b[0m verify:install\n");

step("Building workspaces…");
run("pnpm", ["-r", "--filter", "./packages/**", "build"], REPO_ROOT);
ok("All workspaces built");

const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-pack-"));
step(`Packing tarballs → ${packDir}`);
const tarballs = {};
for (const { dir: absDir, pkg } of packSet().values()) {
  runCapture("pnpm", ["pack", "--pack-destination", packDir], absDir);
  const name = tarballName(pkg.name, pkg.version);
  const abs = path.join(packDir, name);
  if (!fs.existsSync(abs)) fail(`Expected tarball not produced: ${abs}`);
  tarballs[pkg.name] = abs;
}
ok(`${Object.keys(tarballs).length} tarballs packed: ${Object.keys(tarballs).join(", ")}`);

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-scratch-"));
step(`Scratch Next project → ${scratchDir}`);
// Replicate the real user flow: `hoplens` is the only direct dev-dep they add,
// and the @hoplens/* workspaces come in transitively via hoplens → cli/next/
// express → core → ui etc. We use npm `overrides` to redirect those transitive refs to
// the local tarballs instead of hitting the real registry. Installing them all
// as direct deps (as the earlier version did) hid the ERR_PACKAGE_PATH_NOT_EXPORTED
// bug because npm hoisted @hoplens/cli's bin into node_modules/.bin, bypassing
// the meta shim that users actually invoke.
const scratchPkg = {
  name: "hoplens-install-smoke",
  version: "0.0.0",
  private: true,
  dependencies: {
    next: "^16.0.0",
    react: "^19.0.0",
    "react-dom": "^19.0.0",
    hoplens: `file:${tarballs.hoplens}`,
  },
  overrides: Object.fromEntries(
    Object.entries(tarballs)
      .filter(([name]) => name !== META_NAME)
      .map(([name, abs]) => [name, `file:${abs}`]),
  ),
};
fs.writeFileSync(path.join(scratchDir, "package.json"), JSON.stringify(scratchPkg, null, 2));
fs.writeFileSync(path.join(scratchDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
// Minimal app/ so `init` picks root-level instrumentation (not src/).
fs.mkdirSync(path.join(scratchDir, "app"), { recursive: true });
fs.writeFileSync(path.join(scratchDir, "app", "page.tsx"), "export default function Page() { return null; }\n");
ok("Scratch project written");

step("npm install…");
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], scratchDir);
ok("Dependencies installed");

step("npx hoplens init");
run("npx", ["hoplens", "init"], scratchDir);
const nextCfg = path.join(scratchDir, "next.config.ts");
const instr = path.join(scratchDir, "instrumentation.ts");
if (!fs.existsSync(nextCfg)) fail("init didn't create next.config.ts");
const nextCfgSrc = fs.readFileSync(nextCfg, "utf8");
if (!nextCfgSrc.includes("withHoplens")) fail("next.config.ts missing withHoplens");
if (!nextCfgSrc.includes('from "hoplens/next"'))
  fail("next.config.ts should import from hoplens/next (meta subpath), not @hoplens/next");
if (!fs.existsSync(instr)) fail("init didn't create instrumentation.ts");
const instrSrc = fs.readFileSync(instr, "utf8");
if (!instrSrc.includes('"hoplens/node"'))
  fail("instrumentation.ts should import hoplens/node (meta subpath), not @hoplens/next/node");
ok("init produced files that use the meta subpaths (single-install contract)");

step("npx hoplens doctor");
run("npx", ["hoplens", "doctor"], scratchDir);
ok("doctor exited 0 — scratch project is fully wired");

if (KEEP) {
  log(`\n  \x1b[33m!\x1b[0m Keeping temp dirs:\n     ${packDir}\n     ${scratchDir}`);
} else {
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

log("\n  \x1b[32m✓\x1b[0m Install flow verified end-to-end.\n");
