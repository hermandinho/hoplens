import fs from "node:fs";
import path from "node:path";
import { readDistDir } from "../commands/remove";
import { PATH_FLAG_FILE } from "../express/pathflag";
import { CONFIG_FILES } from "./wiring";

/**
 * Where @hoplens/next reads the request path flag at the first request (packages/next/src/path.ts):
 * the state dir core persists to, `<distDir>/cache/hoplens`, or withHoplens' `stateDir` (against the
 * project root). Both are read from next.config only when they are plain string literals.
 */
export function nextFlagPath(root: string): { abs: string; rel: string } {
  let stateDir: string | undefined;
  const name = CONFIG_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (name) {
    try {
      const m = /\bstateDir\s*:\s*(["'`])([^"'`\r\n]+)\1/.exec(fs.readFileSync(path.join(root, name), "utf8"));
      stateDir = m?.[2]?.trim() || undefined;
    } catch {
      /* the default */
    }
  }
  const dir = stateDir ? path.resolve(root, stateDir) : path.join(root, readDistDir(root), "cache", "hoplens");
  const abs = path.join(dir, PATH_FLAG_FILE);
  const rel = path.relative(root, abs) || abs;
  return { abs, rel: rel.split(path.sep).join("/") };
}
