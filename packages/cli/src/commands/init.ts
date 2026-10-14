import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import { c, fail, ok, skip, warn } from "../style";
import { readJson, safeResolve } from "../util";

const BLOCK = [
  "  // Hoplens: request journey visualizer at /__hoplens (dev only)",
  '  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {',
  '    await import("@hoplens/next/node");',
  "  }",
].join("\n");

/**
 * Wire Hoplens into the current project. Patches `next.config.*` with `withHoplens()` and adds
 * the dynamic import to `instrumentation.*`. Idempotent and safe to re-run.
 */
export async function init(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const root = process.cwd();

  console.log(`\n${c.magenta("◆ Hoplens")} init\n`);

  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) return fail("No package.json here. Run this from your Next.js project root.");
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) return fail("This project doesn't depend on next.");
  const major = Number(
    String(readJson(safeResolve("next/package.json", root))?.version ?? deps.next)
      .replace(/^[^\d]*/, "")
      .split(".")[0],
  );
  if (major && major < 15) warn(`Next.js ${major} detected. Hoplens is built for Next.js 15.3 and later.`);

  const ts = loadTypeScript(root);
  const changes: [string, string][] = [];
  const cfg = patchConfig(ts, root);
  if (cfg) changes.push(cfg);
  const ins = patchInstrumentation(ts, root);
  if (ins) changes.push(ins);

  for (const [file, content] of changes) {
    if (dryRun) console.log(`${c.dim(`--- ${file}\n`) + content}\n`);
    else fs.writeFileSync(path.join(root, file), content);
  }
  if (!deps.hoplens && !deps["@hoplens/next"]) warn(`Install the runtime: ${c.bold("npm i -D hoplens")}`);
  console.log(
    `\n${c.green("Done.")} Start ${c.bold("next dev")} and open ${c.bold("http://localhost:3000/__hoplens")}\n`,
  );
}

function patchConfig(ts: any, root: string): [string, string] | null {
  const name = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"].find((f) =>
    fs.existsSync(path.join(root, f)),
  );
  if (!name) {
    const file = fs.existsSync(path.join(root, "tsconfig.json")) ? "next.config.ts" : "next.config.mjs";
    ok(`Created ${file}`);
    return [file, `import { withHoplens } from "@hoplens/next";\n\nexport default withHoplens({});\n`];
  }
  const src = fs.readFileSync(path.join(root, name), "utf8");
  if (src.includes("withHoplens")) {
    skip(`${name} already uses withHoplens`);
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
        const e = st.expression;
        out = `${src.slice(0, e.getStart(sf))}withHoplens(${e.getText(sf)})${src.slice(e.getEnd())}`;
      }
      if (
        isCjs &&
        ts.isExpressionStatement(st) &&
        ts.isBinaryExpression(st.expression) &&
        st.expression.left.getText(sf) === "module.exports"
      ) {
        const e = st.expression.right;
        out = `${src.slice(0, e.getStart(sf))}withHoplens(${e.getText(sf)})${src.slice(e.getEnd())}`;
      }
    }
  } else {
    const re = isCjs ? /module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/ : /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/;
    const m = src.match(re);
    if (m)
      out = src.replace(re, isCjs ? `module.exports = withHoplens(${m[1]});` : `export default withHoplens(${m[1]});`);
  }
  if (!out) {
    warn(
      `Couldn't find the default export in ${name}. Wrap it yourself: ${c.bold("export default withHoplens(nextConfig)")}`,
    );
    return null;
  }
  out = isCjs
    ? `const { withHoplens } = require("@hoplens/next");\n${out}`
    : addImport(out, `import { withHoplens } from "@hoplens/next";`);
  ok(`Wrapped the config in ${name}`);
  return [name, out];
}

function addImport(src: string, line: string): string {
  const lines = src.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*import\s/.test(lines[i]!)) last = i;
  if (last >= 0) {
    while (
      last < lines.length - 1 &&
      !/from\s+["'][^"']+["'];?\s*$|^\s*import\s+["'][^"']+["'];?\s*$/.test(lines[last]!)
    )
      last++;
    lines.splice(last + 1, 0, line);
    return lines.join("\n");
  }
  return `${line}\n\n${src}`;
}

function patchInstrumentation(ts: any, root: string): [string, string] | null {
  const useSrc = fs.existsSync(path.join(root, "src", "app")) || fs.existsSync(path.join(root, "src", "pages"));
  const dir = useSrc ? "src/" : "";
  const existing = ["ts", "js", "mjs"]
    .map((e) => `${dir}instrumentation.${e}`)
    .find((f) => fs.existsSync(path.join(root, f)));
  const isTs = fs.existsSync(path.join(root, "tsconfig.json"));
  if (!existing) {
    const file = `${dir}instrumentation.${isTs ? "ts" : "js"}`;
    ok(`Created ${file}`);
    return [file, `export async function register() {\n${BLOCK}\n}\n`];
  }
  const src = fs.readFileSync(path.join(root, existing), "utf8");
  if (src.includes("@hoplens/next/node")) {
    skip(`${existing} already loads Hoplens`);
    return null;
  }
  if (!ts) {
    const m = src.match(/export\s+(async\s+)?function\s+register\s*\([^)]*\)\s*\{/);
    if (!m) {
      ok(`Added register() to ${existing}`);
      return [existing, `${src.trimEnd()}\n\nexport async function register() {\n${BLOCK}\n}\n`];
    }
    warn(`Add this to register() in ${existing}:\n${BLOCK}`);
    return null;
  }
  const sf = ts.createSourceFile(
    existing,
    src,
    ts.ScriptTarget.Latest,
    true,
    existing.endsWith("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  let fn: any = null;
  for (const st of sf.statements) {
    const exported = st.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(st) && st.name?.text === "register") fn = st;
    if (exported && ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          d.name.getText(sf) === "register" &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          fn = d.initializer;
        }
      }
    }
  }
  if (!fn) {
    ok(`Added register() to ${existing}`);
    return [existing, `${src.trimEnd()}\n\nexport async function register() {\n${BLOCK}\n}\n`];
  }
  if (!fn.body || !ts.isBlock(fn.body)) {
    warn(`register() in ${existing} has no block body. Add this inside it:\n${BLOCK}`);
    return null;
  }
  const stmts = fn.body.statements;
  const lastSt = stmts[stmts.length - 1];
  // Add after the user's own setup (so their OpenTelemetry provider registers first), before a trailing return.
  const at = lastSt && ts.isReturnStatement(lastSt) ? lastSt.getFullStart() : fn.body.getEnd() - 1;
  let out = `${src.slice(0, at)}\n${BLOCK}\n${src.slice(at)}`;
  const isAsync = fn.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (!isAsync) {
    const kw = ts.isFunctionDeclaration(fn)
      ? fn.getChildren(sf).find((cc: any) => cc.kind === ts.SyntaxKind.FunctionKeyword)
      : null;
    const start = kw ? kw.getStart(sf) : fn.getStart(sf);
    if (start < at) out = `${out.slice(0, start)}async ${out.slice(start)}`;
  }
  ok(`Added Hoplens to register() in ${existing}`);
  return [existing, out];
}
