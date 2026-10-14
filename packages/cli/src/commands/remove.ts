import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import { c, fail, ok, skip, warn } from "../style";

/**
 * The exact snippet that `init` inserts into `register()`. We match it verbatim on
 * removal — if the user reformatted it we fall back to a warning instead of guessing.
 */
const BLOCK = [
  "  // Hoplens: request journey visualizer at /__hoplens (dev only)",
  '  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {',
  '    await import("@hoplens/next/node");',
  "  }",
].join("\n");

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

  if (edits.length === 0) {
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

  console.log(
    `\n${c.green("Done.")} If you no longer need Hoplens, uninstall it: ${c.bold("npm rm hoplens @hoplens/next")}\n`,
  );
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

function stripHoplensImport(src: string, isCjs: boolean): string {
  if (isCjs) {
    return src.replace(
      /^[ \t]*const\s*\{\s*withHoplens\s*\}\s*=\s*require\(\s*["']@hoplens\/next["']\s*\)\s*;?[ \t]*\r?\n?/m,
      "",
    );
  }
  // Try `import { withHoplens }` first (sole import), then an aliased form inside a named-import list.
  let out = src.replace(/^[ \t]*import\s*\{\s*withHoplens\s*\}\s*from\s*["']@hoplens\/next["']\s*;?[ \t]*\r?\n?/m, "");
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
  if (!src.includes("@hoplens/next/node")) {
    skip(`${existing} doesn't load Hoplens`);
    return null;
  }

  // Try literal block removal first — init writes BLOCK verbatim with surrounding newlines.
  const normalized = src.replace(/\r\n/g, "\n");
  const marker = `\n${BLOCK}\n`;
  const idx = normalized.indexOf(marker);
  let out: string | null = null;
  if (idx >= 0) {
    out = normalized.slice(0, idx) + normalized.slice(idx + marker.length);
  } else if (normalized.includes(BLOCK)) {
    out = normalized.replace(BLOCK, "").replace(/\n{3,}/g, "\n\n");
  }

  if (!out) {
    warn(
      `Couldn't find the Hoplens block in ${existing} (it was reformatted?). Remove the ${c.bold(
        '`await import("@hoplens/next/node")`',
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
