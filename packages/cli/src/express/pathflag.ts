import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./project";

// The request path's sticky flag, `<stateDir>/path.json`, as @hoplens/express reads it at boot
// (packages/express/src/pathflag.ts; the CLI does not depend on the runtime, so the few lines that
// locate, read and write it are repeated here). `hoplens init --path` writes it, `remove` deletes it.

export const PATH_FLAG_FILE = "path.json";

/**
 * The state dir the register hook reads: HOPLENS_OPTIONS `stateDir` (against its `root`), else
 * `<root>/node_modules/.cache/hoplens`, `root` being HOPLENS_OPTIONS `root` or the project root.
 */
export function flagStateDir(root: string, env: Record<string, string | undefined> = process.env): string {
  let o: any;
  try {
    o = env.HOPLENS_OPTIONS ? JSON.parse(env.HOPLENS_OPTIONS) : undefined;
  } catch {
    o = undefined;
  }
  const base = o && typeof o.root === "string" && o.root ? path.resolve(root, o.root) : root;
  const dir = o && typeof o.stateDir === "string" && o.stateDir ? o.stateDir : undefined;
  return dir ? path.resolve(base, dir) : path.join(base, STATE_DIR);
}

/** The flag file's path, and the same relative to the project root for messages. */
export function flagPath(root: string, env?: Record<string, string | undefined>): { abs: string; rel: string } {
  const abs = path.join(flagStateDir(root, env), PATH_FLAG_FILE);
  const rel = path.relative(root, abs) || abs;
  return { abs, rel: rel.split(path.sep).join("/") };
}

/** "on" for a well-formed enabled flag, "corrupt" for a file that is not one, else undefined. */
export function readFlag(abs: string): "on" | "corrupt" | undefined {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text)?.enabled === true ? "on" : "corrupt";
  } catch {
    return "corrupt";
  }
}

/** The flag's JSON, as the UI's Enable button writes it (`by` differs). */
export function flagContent(by: "init" | "ui", now = new Date()): string {
  return `${JSON.stringify({ enabled: true, since: now.toISOString(), by })}\n`;
}

/** Write the flag atomically, creating the state dir. */
export function writeFlag(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** `file` is `dir` itself or under it (false across Windows drives, where path.relative is absolute). */
export function insideDir(dir: string, file: string): boolean {
  const r = path.relative(dir, file);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

/**
 * The env assignments a dev script makes before its command (`A=1 B='x y' node ...`, also after a
 * leading `cross-env` / `env`), which the app process sees and the CLI's own environment does not:
 * shell words with '...' and "..." quoting (backslash escapes inside "..." and bare). Stops at the
 * first word that is not NAME=value.
 */
export function scriptEnv(cmd: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cmd) return out;
  let i = 0;
  const n = cmd.length;
  const space = () => {
    while (i < n && /\s/.test(cmd.charAt(i))) i++;
  };
  const word = (): string => {
    let w = "";
    while (i < n && !/[\s;&|]/.test(cmd.charAt(i))) {
      const ch = cmd.charAt(i);
      if (ch === "'") {
        const end = cmd.indexOf("'", i + 1);
        if (end < 0) return w + cmd.slice(i + 1);
        w += cmd.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '"') {
        i++;
        while (i < n && cmd.charAt(i) !== '"') {
          if (cmd.charAt(i) === "\\" && i + 1 < n && /["\\$`]/.test(cmd.charAt(i + 1))) i++;
          w += cmd.charAt(i++);
        }
        i++;
      } else if (ch === "\\" && i + 1 < n) {
        w += cmd.charAt(i + 1);
        i += 2;
      } else {
        w += ch;
        i++;
      }
    }
    return w;
  };
  space();
  let first = true;
  while (i < n) {
    const start = i;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(cmd.slice(i));
    if (!m) {
      if (first && /^(?:cross-env|env)(?=\s)/.test(cmd.slice(i))) {
        i += cmd.slice(i).startsWith("cross-env") ? 9 : 3;
        first = false;
        space();
        continue;
      }
      break;
    }
    i = start + m[0].length;
    out[m[1] as string] = word();
    first = false;
    space();
  }
  return out;
}

/** The environment the app process gets from the dev script: the CLI's own, then the script's assignments over it. */
export function appEnv(
  cmd: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...env, ...scriptEnv(cmd) };
}
