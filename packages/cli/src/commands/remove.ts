import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import { removeExpress } from "../express/commands";
import { detectFramework, frameworkFlag } from "../framework";
import { CONFIG_FILES, KNOWN_BLOCKS, configState, unguardConfig } from "../next/wiring";
import { c, fail, ok, skip, warn } from "../style";
import { readJson } from "../util";

const INSTRUMENTATION_FILES = [
  "instrumentation.ts",
  "instrumentation.js",
  "instrumentation.mjs",
  "src/instrumentation.ts",
  "src/instrumentation.js",
  "src/instrumentation.mjs",
];

type Edit = [file: string, content: string | null]; // null = delete file

/**
 * Reverse of `init`: unwraps `withHoplens(...)` in next.config, strips the Hoplens
 * block from `instrumentation.register()`, and deletes files that we created in the
 * first place when there's nothing left in them. Idempotent and dry-run-friendly.
 */
export async function remove(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const root = process.cwd();

  console.log(`\n${c.magenta("◆ Hoplens")} remove\n`);

  // Express projects get their own undo; no package.json, or neither framework, keeps the Next path.
  const flag = frameworkFlag(args);
  if (typeof flag === "object") return fail(flag.error);
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const fw = detectFramework(pkg, flag);
    if ("error" in fw && !fw.neither) return fail(fw.error);
    if ("framework" in fw && fw.framework === "express") return removeExpress(root, pkg, dryRun);
  }

  const ts = loadTypeScript(root);
  const edits: Edit[] = [];

  const cfg = unpatchConfig(ts, root);
  if (cfg) edits.push(cfg);

  const ins = unpatchInstrumentation(ts, root);
  if (ins) edits.push(ins);

  // Read distDir before the config is rewritten (or deleted) below.
  const data = hoplensData(root);

  if (edits.length === 0 && data.length === 0) {
    skip("Nothing to remove — Hoplens isn't wired into this project.");
    return;
  }

  for (const [file, content] of edits) {
    const abs = path.join(root, file);
    if (dryRun) {
      const header = content === null ? `${c.dim(`--- ${file} (delete)`)}\n` : `${c.dim(`--- ${file}`)}\n`;
      console.log(`${header}${content ?? ""}\n`);
      continue;
    }
    try {
      if (content === null) fs.unlinkSync(abs);
      else fs.writeFileSync(abs, content);
    } catch (err) {
      fail(`Couldn't write ${file}: ${(err as Error).message}`);
      return;
    }
  }

  for (const rel of data) {
    if (dryRun) {
      console.log(`${c.dim(`--- ${rel} (delete)`)}\n`);
      continue;
    }
    try {
      fs.rmSync(path.join(root, rel), { recursive: true, force: true });
      ok(`Deleted ${rel}`);
    } catch (err) {
      warn(`Couldn't delete ${rel}: ${(err as Error).message}`);
    }
  }

  console.log(`\n${c.green("Done.")} If you no longer need Hoplens, uninstall it: ${c.bold("npm rm hoplens")}\n`);
}

/**
 * Files Hoplens writes under the build output: the persisted stats (`persist: true`, a directory) and
 * the resolved options written by withHoplens. Project-relative paths of the ones that exist.
 */
export function hoplensData(root: string): string[] {
  const cache = path.join(readDistDir(root), "cache");
  return [path.join(cache, "hoplens"), path.join(cache, "hoplens.json")].filter((rel) =>
    fs.existsSync(path.join(root, rel)),
  );
}

/** `distDir` from next.config when it's a plain string literal, else Next's default `.next`. */
export function readDistDir(root: string): string {
  const name = CONFIG_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (name) {
    try {
      const m = /\bdistDir\s*:\s*(["'`])([^"'`\r\n]+)\1/.exec(fs.readFileSync(path.join(root, name), "utf8"));
      const dir = m?.[2]?.trim();
      // Never follow a distDir out of the project.
      if (dir && !path.isAbsolute(dir) && !path.normalize(dir).startsWith("..")) return path.normalize(dir);
    } catch {
      /* fall back to the default */
    }
  }
  return ".next";
}

function unpatchConfig(ts: any, root: string): Edit | null {
  const name = CONFIG_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!name) return null;

  const src = fs.readFileSync(path.join(root, name), "utf8");
  if (configState(src) === "none") {
    skip(`${name} has no withHoplens wrap`);
    return null;
  }
  const r = ts ? unguardConfig(ts, name, src) : { error: "no-ts" };
  if ("error" in r) {
    warn(`Couldn't find the Hoplens wrap init writes in ${name}. Remove withHoplens by hand.`);
    return null;
  }
  // What is left is the config init created for a greenfield project: delete it so remove leaves no trace.
  if (r.out === null) {
    ok(`Deleted ${name} (was created by init with no custom config)`);
    return [name, null];
  }
  ok(`Unwrapped withHoplens(...) in ${name}`);
  return [name, r.out];
}

function unpatchInstrumentation(ts: any, root: string): Edit | null {
  const existing = INSTRUMENTATION_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!existing) return null;

  const src = fs.readFileSync(path.join(root, existing), "utf8");
  if (!src.includes("hoplens/node") && !src.includes("@hoplens/next/node")) {
    skip(`${existing} doesn't load Hoplens`);
    return null;
  }

  // Literal block removal for each form any init wrote. init inserts it with \n line endings, so a
  // CRLF file holds it that way; one converted to CRLF afterwards holds it with \r\n.
  let out: string | null = null;
  const eols = src.includes("\r\n") ? ["\n", "\r\n"] : ["\n"];
  search: for (const known of KNOWN_BLOCKS) {
    for (const eol of eols) {
      const block = known.split("\n").join(eol);
      const marker = `${eol}${block}${eol}`;
      const idx = src.indexOf(marker);
      if (idx >= 0) {
        out = src.slice(0, idx) + src.slice(idx + marker.length);
        break search;
      }
      if (src.includes(block)) {
        out = src.replace(block, "").replace(new RegExp(`(?:${eol}){3,}`, "g"), `${eol}${eol}`);
        break search;
      }
    }
  }

  if (!out) {
    warn(
      `Couldn't find the Hoplens block in ${existing} (it was reformatted?). Remove the ${c.bold(
        '`await import("hoplens/node")`',
      )} line by hand.`,
    );
    return null;
  }

  // If what's left is an empty register() (and nothing else that matters), delete the file
  // because init created it from scratch — the user has no custom logic to preserve.
  if (isEmptyRegisterOnly(out, ts, existing)) {
    ok(`Deleted ${existing} (was created by init with no custom register logic)`);
    return [existing, null];
  }

  ok(`Removed Hoplens block from register() in ${existing}`);
  return [existing, out];
}

function isEmptyRegisterOnly(src: string, ts: any, name: string): boolean {
  // Quick string check: everything outside of the register() wrapper must be whitespace.
  const match = src.match(/^(\s*)export\s+(async\s+)?function\s+register\s*\(\s*\)\s*\{([\s\S]*?)\}\s*$/);
  if (match && match[3]!.trim() === "") return true;

  if (!ts) return false;
  const sf = ts.createSourceFile(
    name,
    src,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  if (sf.statements.length !== 1) return false;
  const st = sf.statements[0];
  if (!ts.isFunctionDeclaration(st)) return false;
  if (st.name?.text !== "register") return false;
  if (!st.body || !ts.isBlock(st.body)) return false;
  return st.body.statements.length === 0;
}
