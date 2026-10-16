import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import { c, fail, ok, skip, warn } from "../style";

/**
 * The exact snippet that `init` inserts into `register()`. We match it verbatim on
 * removal — if the user reformatted it we fall back to a warning instead of guessing.
 */
/**
 * Both forms of the block init may have written. 0.1.2+ uses the hoplens/node
 * subpath; 0.1.0 / 0.1.1 used @hoplens/next/node directly. remove must undo
 * either, so we try each in order.
 */
const BLOCK_CURRENT = [
  "  // Hoplens: request journey visualizer at /__hoplens (dev only)",
  '  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {',
  '    await import("hoplens/node");',
  "  }",
].join("\n");
const BLOCK_LEGACY = [
  "  // Hoplens: request journey visualizer at /__hoplens (dev only)",
  '  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {',
  '    await import("@hoplens/next/node");',
  "  }",
].join("\n");
const KNOWN_BLOCKS = [BLOCK_CURRENT, BLOCK_LEGACY];

const CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"];
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
  if (!src.includes("withHoplens")) {
    skip(`${name} has no withHoplens wrap`);
    return null;
  }

  const isCjs =
    name.endsWith(".cjs") || (name.endsWith(".js") && /module\.exports\s*=/.test(src) && !/export\s+default/.test(src));

  let out: string | null = null;
  if (ts) {
    const sf = ts.createSourceFile(
      name,
      src,
      ts.ScriptTarget.Latest,
      true,
      name.endsWith("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    for (const st of sf.statements) {
      if (!isCjs && ts.isExportAssignment(st) && !st.isExportEquals) {
        const unwrapped = unwrapCall(ts, sf, src, st.expression);
        if (unwrapped) out = unwrapped;
      }
      if (
        isCjs &&
        ts.isExpressionStatement(st) &&
        ts.isBinaryExpression(st.expression) &&
        st.expression.left.getText(sf) === "module.exports"
      ) {
        const unwrapped = unwrapCall(ts, sf, src, st.expression.right);
        if (unwrapped) out = unwrapped;
      }
    }
  } else {
    const re = isCjs
      ? /module\.exports\s*=\s*withHoplens\(([^)]*)\)\s*;?/
      : /export\s+default\s+withHoplens\(([^)]*)\)\s*;?/;
    const m = src.match(re);
    if (m) out = src.replace(re, isCjs ? `module.exports = ${m[1]!.trim()};` : `export default ${m[1]!.trim()};`);
  }

  if (!out) {
    warn(`Couldn't find the withHoplens(...) call in ${name}. Remove it by hand.`);
    return null;
  }

  out = stripHoplensImport(out, isCjs);

  // If the stripped file is effectively empty (what init creates for a greenfield project),
  // delete it so `remove` leaves no trace.
  if (isGreenfieldLeftover(out, isCjs)) {
    ok(`Deleted ${name} (was created by init with no custom config)`);
    return [name, null];
  }

  ok(`Unwrapped withHoplens(...) in ${name}`);
  return [name, out];
}

function unwrapCall(ts: any, sf: any, src: string, expr: any): string | null {
  if (!ts.isCallExpression(expr)) return null;
  if (expr.expression.getText(sf) !== "withHoplens") return null;
  const inner = expr.arguments[0];
  const innerText = inner ? inner.getText(sf) : "{}";
  return `${src.slice(0, expr.getStart(sf))}${innerText}${src.slice(expr.getEnd())}`;
}

/**
 * Matches both the modern `hoplens/next` subpath (0.1.2+) and the legacy
 * `@hoplens/next` scope (0.1.0 / 0.1.1), so remove undoes an install done
 * with any version of init.
 */
const HOPLENS_IMPORT_SOURCE = /["'](?:hoplens\/next|@hoplens\/next)["']/;

function stripHoplensImport(src: string, isCjs: boolean): string {
  if (isCjs) {
    return src.replace(
      new RegExp(
        `^[ \\t]*const\\s*\\{\\s*withHoplens\\s*\\}\\s*=\\s*require\\(\\s*${HOPLENS_IMPORT_SOURCE.source}\\s*\\)\\s*;?[ \\t]*\\r?\\n?`,
        "m",
      ),
      "",
    );
  }
  // Try `import { withHoplens }` first (sole import), then an aliased form inside a named-import list.
  const soleImport = new RegExp(
    `^[ \\t]*import\\s*\\{\\s*withHoplens\\s*\\}\\s*from\\s*${HOPLENS_IMPORT_SOURCE.source}\\s*;?[ \\t]*\\r?\\n?`,
    "m",
  );
  let out = src.replace(soleImport, "");
  if (out === src) {
    out = src.replace(/\{\s*withHoplens\s*,\s*/g, "{ ").replace(/,\s*withHoplens\s*(?=[},])/g, "");
  }
  return out;
}

function isGreenfieldLeftover(src: string, isCjs: boolean): boolean {
  const stripped = src.replace(/\s+/g, "");
  return isCjs ? stripped === "module.exports={};" : stripped === "exportdefault{};";
}

function unpatchInstrumentation(ts: any, root: string): Edit | null {
  const existing = INSTRUMENTATION_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!existing) return null;

  const src = fs.readFileSync(path.join(root, existing), "utf8");
  if (!src.includes("hoplens/node") && !src.includes("@hoplens/next/node")) {
    skip(`${existing} doesn't load Hoplens`);
    return null;
  }

  // Try literal block removal for each known form. init writes the block
  // verbatim with surrounding newlines; later versions changed the import
  // path but kept the surrounding comment + if-gate.
  const normalized = src.replace(/\r\n/g, "\n");
  let out: string | null = null;
  for (const block of KNOWN_BLOCKS) {
    const marker = `\n${block}\n`;
    const idx = normalized.indexOf(marker);
    if (idx >= 0) {
      out = normalized.slice(0, idx) + normalized.slice(idx + marker.length);
      break;
    }
    if (normalized.includes(block)) {
      out = normalized.replace(block, "").replace(/\n{3,}/g, "\n\n");
      break;
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
