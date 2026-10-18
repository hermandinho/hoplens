import fs from "node:fs";
import path from "node:path";
import { type StringSpan, findJsonString, lineAt } from "../json-edit";
import { c } from "../style";
import { readJson } from "../util";
import { REGISTER_RE, entryFiles } from "./script";

/** The scripts init edits, in order: the first one present is the dev script. */
export const DEV_SCRIPTS = ["dev", "start:dev", "watch"];

/** Where persisted route stats live (`persist` is on by default in the Express adapter). */
export const STATE_DIR = path.join("node_modules", ".cache", "hoplens");

export type DevScript = { key: string; span: StringSpan };

export function readPackageText(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, "package.json"), "utf8");
  } catch {
    return null;
  }
}

/** The first of {@link DEV_SCRIPTS} that is a string in package.json, with its raw span. */
export function findDevScript(src: string, keys = DEV_SCRIPTS): DevScript | null {
  for (const key of keys) {
    const span = findJsonString(src, ["scripts", key]);
    if (span) return { key, span };
  }
  return null;
}

/** nodemon's configured `exec` (nodemon.json or package.json `nodemonConfig`), which overrides node. */
export function nodemonExec(root: string, pkg: any): string | null {
  const fromFile = readJson(path.join(root, "nodemon.json"))?.exec;
  const fromPkg = pkg?.nodemonConfig?.exec;
  const exec = fromFile ?? fromPkg;
  return typeof exec === "string" && exec.trim() ? exec : null;
}

export function majorOf(version: unknown): number {
  return Number(
    String(version ?? "")
      .replace(/^[^\d]*/, "")
      .split(".")[0] || 0,
  );
}

/** A `- old` / `+ new` preview of one changed line of package.json. */
export function diffLines(file: string, before: string, after: string, at: number): string {
  return `${c.dim(`--- ${file}`)}\n${c.red(`- ${lineAt(before, at)}`)}\n${c.green(`+ ${lineAt(after, at)}`)}\n`;
}

/** A port to print in the next steps: PORT= in the dev script or .env, else a literal in the entry file. */
export function guessPort(root: string, devCmd: string | null, pkg: any): string | null {
  const fromCmd = devCmd && /\bPORT=(\d{2,5})\b/.exec(devCmd);
  if (fromCmd) return fromCmd[1]!;
  for (const f of [".env.development.local", ".env.local", ".env.development", ".env"]) {
    try {
      const m = /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})/m.exec(fs.readFileSync(path.join(root, f), "utf8"));
      if (m) return m[1]!;
    } catch {
      /* no such file */
    }
  }
  for (const file of candidateEntries(root, devCmd, pkg)) {
    const src = readSmall(path.join(root, file));
    if (!src) continue;
    const m = /\bPORT\b[^\n;]{0,40}?(?:\?\?|\|\|)\s*["']?(\d{2,5})/.exec(src) ?? /\.listen\(\s*(\d{2,5})\b/.exec(src);
    if (m) return m[1]!;
  }
  return null;
}

/** Files that likely hold the app: entries named in the dev and start scripts, `main`, the usual names. */
export function candidateEntries(root: string, devCmd: string | null, pkg: any): string[] {
  const names = new Set<string>();
  for (const cmd of [devCmd, pkg?.scripts?.start])
    if (typeof cmd === "string") for (const f of entryFiles(cmd)) names.add(f);
  if (typeof pkg?.main === "string") names.add(pkg.main);
  for (const b of ["src/server", "src/app", "src/index", "src/main", "server", "app", "index"])
    for (const e of [".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"]) names.add(b + e);
  return [...names].filter((f) => {
    const abs = path.resolve(root, f);
    return !path.relative(root, abs).startsWith("..") && fs.existsSync(abs);
  });
}

/** Files among the candidate entries that call `hoplens(app)` from hoplens/express. */
export function codeWiring(root: string, devCmd: string | null, pkg: any): string[] {
  return candidateEntries(root, devCmd, pkg).filter((file) => {
    const src = readSmall(path.join(root, file));
    return !!src && /["'](?:hoplens|@hoplens)\/express["']/.test(src) && /\bhoplens\s*\(\s*[A-Za-z_$]/.test(src);
  });
}

function readSmall(abs: string): string | null {
  try {
    if (fs.statSync(abs).size > 512 * 1024) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** `.env*` files at the project root whose NODE_OPTIONS preloads the register hook. */
export function envFilesWithNodeOptions(root: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((f) => f.startsWith(".env"));
  } catch {
    return [];
  }
  return names.filter((f) => {
    const src = readSmall(path.join(root, f));
    return !!src && src.split(/\r?\n/).some((l) => /^\s*(?:export\s+)?NODE_OPTIONS\s*=/.test(l) && REGISTER_RE.test(l));
  });
}

/** A script name or command that reads as production: `start`, `serve`, `*:prod`, `NODE_ENV=production`. */
export function looksProduction(name: string, cmd: string): boolean {
  if (name === "start" || name === "serve" || name === "preview") return true;
  if (/(^|[:_-])(prod|production)($|[:_-])/.test(name)) return true;
  return /\bNODE_ENV=["']?production\b/.test(cmd);
}
