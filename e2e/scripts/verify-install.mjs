#!/usr/bin/env node
/**
 * Install-flow smoke: pack every @hoplens/* workspace into tarballs, install
 * them into a scratch Next 16 project, run `hoplens init`, then run `hoplens
 * doctor` and expect it to pass. This simulates `npm i -D hoplens` end-to-end
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

// Order doesn't matter for packing but reads easily top-down: meta first, then
// its direct deps, then transitive deps.
const WORKSPACE_DIRS = ["meta", "cli", "next", "core", "schema", "transform", "ui"];

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

function readWorkspacePkg(dirName) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages", dirName, "package.json"), "utf8"));
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
for (const dir of WORKSPACE_DIRS) {
  const pkg = readWorkspacePkg(dir);
  const absDir = path.join(REPO_ROOT, "packages", dir);
  runCapture("pnpm", ["pack", "--pack-destination", packDir], absDir);
  const name = tarballName(pkg.name, pkg.version);
  const abs = path.join(packDir, name);
  if (!fs.existsSync(abs)) fail(`Expected tarball not produced: ${abs}`);
  tarballs[pkg.name] = abs;
}
ok(`${Object.keys(tarballs).length} tarballs packed`);

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "hop-scratch-"));
step(`Scratch Next project → ${scratchDir}`);
// Replicate the real user flow: `hoplens` is the only direct dev-dep they add,
// and the six @hoplens/* workspaces come in transitively via hoplens → cli/next
// → core → ui etc. We use npm `overrides` to redirect those transitive refs to
// the local tarballs instead of hitting the real registry. Installing all seven
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
  overrides: {
    "@hoplens/cli": `file:${tarballs["@hoplens/cli"]}`,
    "@hoplens/next": `file:${tarballs["@hoplens/next"]}`,
    "@hoplens/core": `file:${tarballs["@hoplens/core"]}`,
    "@hoplens/schema": `file:${tarballs["@hoplens/schema"]}`,
    "@hoplens/transform": `file:${tarballs["@hoplens/transform"]}`,
    "@hoplens/ui": `file:${tarballs["@hoplens/ui"]}`,
  },
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
if (!fs.readFileSync(nextCfg, "utf8").includes("withHoplens")) fail("next.config.ts missing withHoplens");
if (!fs.existsSync(instr)) fail("init didn't create instrumentation.ts");
if (!fs.readFileSync(instr, "utf8").includes("@hoplens/next/node"))
  fail("instrumentation.ts missing @hoplens/next/node");
ok("init produced the expected files");

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
