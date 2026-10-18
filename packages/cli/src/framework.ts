import fs from "node:fs";
import path from "node:path";

export type Framework = "next" | "express";

/**
 * The `--framework next|express` (or `--framework=express`) flag. `undefined` when absent,
 * `{ error }` when the value isn't one of the two.
 */
export function frameworkFlag(args: string[]): Framework | undefined | { error: string } {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--framework") value = args[i + 1] ?? "";
    else if (a.startsWith("--framework=")) value = a.slice("--framework=".length);
  }
  if (value === undefined) return undefined;
  if (value === "next" || value === "express") return value;
  return { error: `--framework takes next or express${value ? `, not ${value}` : ""}.` };
}

/**
 * Which adapter a project uses, from its package.json dependencies (devDependencies too):
 * `next` wins alone, `express` alone means Express, both need `--framework`.
 */
export function detectFramework(
  pkg: any,
  flag: Framework | undefined,
): { framework: Framework } | { error: string; neither?: true } {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (flag) return { framework: flag };
  const next = !!deps.next;
  const express = !!deps.express;
  if (next && express) {
    return {
      error: "This project depends on both next and express. Pick one with --framework next or --framework express.",
    };
  }
  if (next) return { framework: "next" };
  if (express) return { framework: "express" };
  return { error: "This project doesn't depend on next or express.", neither: true };
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * The project's package manager: package.json `packageManager`, then the nearest lockfile in the
 * project or an enclosing directory, up to the repository root (a `.git` entry) so a workspace
 * lockfile counts. npm when nothing says otherwise.
 */
export function detectPackageManager(root: string, pkg?: any): PackageManager {
  const field = String(pkg?.packageManager ?? "").split("@")[0];
  if (field === "pnpm" || field === "yarn" || field === "bun" || field === "npm") return field;
  let dir = path.resolve(root);
  for (let depth = 0; depth < 10; depth++) {
    const has = (f: string) => fs.existsSync(path.join(dir, f));
    if (has("pnpm-lock.yaml") || has("pnpm-workspace.yaml")) return "pnpm";
    if (has("yarn.lock")) return "yarn";
    if (has("bun.lockb") || has("bun.lock")) return "bun";
    if (has("package-lock.json")) return "npm";
    const parent = path.dirname(dir);
    if (has(".git") || parent === dir) break;
    dir = parent;
  }
  return "npm";
}

export function addDevCommand(pm: PackageManager, name: string): string {
  return pm === "npm" ? `npm i -D ${name}` : `${pm} add -D ${name}`;
}

export function removeCommand(pm: PackageManager, name: string): string {
  return pm === "npm" ? `npm rm ${name}` : `${pm} remove ${name}`;
}

export function runCommand(pm: PackageManager, script: string): string {
  return `${pm} run ${script}`;
}
