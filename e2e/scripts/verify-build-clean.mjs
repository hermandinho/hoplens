#!/usr/bin/env node
/**
 * Dev-only guarantee: `next build` on the example app must emit no Hoplens
 * runtime into `.next/server/**`. Hoplens is a dev-time surface; shipping any
 * of its modules into production would be a bug.
 *
 * We can't just grep for the string "hoplens" — the example app's own homepage
 * copy contains "Hoplens example" and a dead href to `/__hoplens`, which are
 * user content, not leaks. Instead we match the two patterns that could only
 * appear if a Hoplens module was actually bundled:
 *
 *   1. `@hoplens/` — any import of a Hoplens workspace package.
 *   2. `withHoplens(` — the config wrap called as a function in bundled code
 *      (as a plain string in HTML text, this would be `withHoplens` without the
 *      open paren, which we don't match).
 *
 * Usage: pnpm --filter hoplens-e2e verify:build
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const APP_DIR = path.join(REPO_ROOT, "examples", "next16-app");
const SERVER_DIR = path.join(APP_DIR, ".next", "server");
const SCAN_EXT = new Set([".js", ".mjs", ".cjs", ".html", ".json", ".txt"]);
const LEAK_PATTERNS = [/@hoplens\//, /\bwithHoplens\s*\(/];

function log(line = "") {
  process.stdout.write(`${line}\n`);
}

function fail(msg) {
  process.stderr.write(`\x1b[31m✗\x1b[0m ${msg}\n`);
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) yield full;
  }
}

function runBuild() {
  log("\n\x1b[35m◆ Hoplens\x1b[0m verify:build\n");
  log(`  Building ${path.relative(REPO_ROOT, APP_DIR)} …`);
  const res = spawnSync("pnpm", ["--filter", "example-next16-app", "exec", "next", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (res.status !== 0) fail(`next build exited ${res.status}`);
}

function scanForLeaks() {
  if (!fs.existsSync(SERVER_DIR)) fail(`Expected server dir not found: ${SERVER_DIR}`);
  const leaks = [];
  let scanned = 0;
  for (const file of walk(SERVER_DIR)) {
    scanned++;
    const content = fs.readFileSync(file, "utf8");
    const matched = LEAK_PATTERNS.filter((re) => re.test(content));
    if (matched.length) leaks.push({ file: path.relative(APP_DIR, file), patterns: matched.map((r) => r.source) });
  }
  log(`  Scanned ${scanned} files under .next/server/**`);
  return leaks;
}

runBuild();
const leaks = scanForLeaks();
if (leaks.length) {
  log("");
  for (const { file, patterns } of leaks)
    process.stderr.write(`  \x1b[31m✗\x1b[0m ${file}  (matches: ${patterns.join(", ")})\n`);
  fail(`${leaks.length} file${leaks.length === 1 ? "" : "s"} leak Hoplens runtime into the production build.`);
}
log("\n  \x1b[32m✓\x1b[0m Clean — no Hoplens runtime shipped into the server bundle.\n");
