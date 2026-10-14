import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import { c, ok, warn } from "../style";
import { readJson, safeResolve } from "../util";

/**
 * Check that Hoplens is wired correctly in the current project. Non-destructive.
 *
 * ```bash
 * npx hoplens doctor
 * ```
 */
export async function doctor(_args: string[]) {
  const root = process.cwd();
  console.log(`\n${c.magenta("◆ Hoplens")} doctor\n`);
  let good = true;
  const check = (pass: boolean, yes: string, no: string) => {
    (pass ? ok : warn)(pass ? yes : no);
    if (!pass) good = false;
  };
  const nextPkg = readJson(safeResolve("next/package.json", root));
  check(!!nextPkg, `Next.js ${nextPkg?.version}`, "Next.js not installed");
  check(
    !!safeResolve("@hoplens/next/package.json", root) || !!safeResolve("hoplens/package.json", root),
    "hoplens is installed",
    "hoplens is not installed (npm i -D hoplens)",
  );
  const cfg = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"].find((f) =>
    fs.existsSync(path.join(root, f)),
  );
  check(
    !!cfg && fs.readFileSync(path.join(root, cfg), "utf8").includes("withHoplens"),
    `${cfg} uses withHoplens`,
    "next.config doesn't use withHoplens (run npx hoplens init)",
  );
  const ins = ["src/instrumentation.ts", "src/instrumentation.js", "instrumentation.ts", "instrumentation.js"].find(
    (f) => fs.existsSync(path.join(root, f)),
  );
  check(
    !!ins && fs.readFileSync(path.join(root, ins), "utf8").includes("@hoplens/next/node"),
    `${ins} loads @hoplens/next/node`,
    "instrumentation doesn't load @hoplens/next/node (run npx hoplens init)",
  );
  if (ins && fs.existsSync(path.join(root, "src", "app")) && !ins.startsWith("src/")) {
    warn("Your app lives in src/, so instrumentation must be in src/ too.");
  }
  check(
    !!loadTypeScript(root),
    "TypeScript available (schemas and auto-tracing)",
    "TypeScript not found: Zod pre-fill and function tracing are off",
  );
  console.log(good ? `\n${c.green("All set.")}\n` : "");
}
