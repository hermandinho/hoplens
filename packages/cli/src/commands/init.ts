import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import { initExpress, initPath } from "../express/commands";
import { detectFramework, frameworkFlag } from "../framework";
import { nextFlagPath } from "../next/pathflag";
import {
  CONFIG_FILES,
  INSTRUMENTATION_SPECS,
  configState,
  greenfieldConfig,
  guardConfig,
  instrumentationBlock,
} from "../next/wiring";
import { type PromptIO, terminalIO } from "../prompt";
import { c, fail, ok, skip, warn } from "../style";
import { readJson, safeResolve } from "../util";

/**
 * Wire Hoplens into the current project. Next.js: makes `next.config.*` load `withHoplens()` in
 * `next dev` only (upgrading the pre-0.3 top-level import) and adds the dynamic import to
 * `instrumentation.*`. Express: adds the register hook to the dev script.
 * Idempotent and safe to re-run.
 */
export async function init(args: string[], io: PromptIO = terminalIO()) {
  const dryRun = args.includes("--dry-run");
  if (args.includes("--path") && args.includes("--no-path")) return fail("Pass --path or --no-path, not both.");
  const pathFlag = args.includes("--path") ? true : args.includes("--no-path") ? false : undefined;
  const root = process.cwd();

  console.log(`\n${c.magenta("◆ Hoplens")} init\n`);

  const flag = frameworkFlag(args);
  if (typeof flag === "object") return fail(flag.error);
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) return fail("No package.json here. Run this from your Next.js or Express project root.");
  const fw = detectFramework(pkg, flag);
  if ("error" in fw)
    return fail(fw.neither ? `${fw.error} Hoplens supports Next.js (next) and Express (express).` : fw.error);
  if (fw.framework === "express") return initExpress(root, pkg, dryRun, { flag: pathFlag, io });
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
  // The request path's sticky flag, where @hoplens/next reads it at the first request. The dev
  // script's own HOPLENS_PATH (and the environment's) wins over it, as for Express.
  const devCmd = typeof pkg.scripts?.dev === "string" ? pkg.scripts.dev : null;
  await initPath(root, devCmd ? { key: "dev", cmd: devCmd } : null, dryRun, { flag: pathFlag, io }, nextFlagPath(root));
  console.log(
    `\n${c.green("Done.")} Start ${c.bold("next dev")} and open ${c.bold("http://localhost:3000/__hoplens")}\n`,
  );
}

function patchConfig(ts: any, root: string): [string, string] | null {
  const name = CONFIG_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!ts) {
    warn(`TypeScript couldn't be loaded, so next.config wasn't changed. Wrap it yourself:\n${GUARD_EXAMPLE}`);
    return null;
  }
  if (!name) {
    const file = fs.existsSync(path.join(root, "tsconfig.json")) ? "next.config.ts" : "next.config.mjs";
    ok(`Created ${file}`);
    return [file, greenfieldConfig(ts, file)];
  }
  const src = fs.readFileSync(path.join(root, name), "utf8");
  const state = configState(src);
  if (state === "guarded") {
    skip(`${name} already loads hoplens/next in next dev only`);
    return null;
  }
  if (state === "wrapped") {
    skip(`${name} already uses withHoplens`);
    return null;
  }
  const r = guardConfig(ts, name, src);
  if ("error" in r) {
    warn(
      r.error === "import"
        ? `${name} imports hoplens/next at the top, so next build / next start fail without dev dependencies, ` +
            `and init can't rewrite that import. Load it only in next dev:\n${GUARD_EXAMPLE}`
        : `Couldn't find the default export in ${name}. Wrap it yourself:\n${GUARD_EXAMPLE}`,
    );
    return null;
  }
  ok(
    r.upgraded
      ? `Upgraded ${name}: hoplens/next now loads in next dev only, so next build / next start work without dev dependencies`
      : `Wrapped the config in ${name} (hoplens/next loads in next dev only)`,
  );
  return [name, r.out];
}

/** What init writes, for the cases it can't write itself. */
const GUARD_EXAMPLE = c.bold(
  [
    'import { PHASE_DEVELOPMENT_SERVER } from "next/constants";',
    "",
    "export default async (phase, ctx) => {",
    "  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;",
    '  const { withHoplens } = await import("hoplens/next");',
    "  return withHoplens(nextConfig)(phase, ctx);",
    "};",
  ].join("\n"),
);

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
    return [file, `export async function register() {\n${instrumentationBlock("hoplens/node", isTs)}\n}\n`];
  }
  const src = fs.readFileSync(path.join(root, existing), "utf8");
  // Match the new hoplens/node form plus the legacy @hoplens/next/node form
  // written by 0.1.0 / 0.1.1 so re-running init on an older install is still idempotent.
  if (src.includes("hoplens/node") || src.includes("@hoplens/next/node")) {
    // Before 0.3 a .ts file got the plain literal, which fails next build's type check once dev
    // dependencies are pruned: swap init's own block for the `as string` one, same specifier.
    if (existing.endsWith(".ts")) {
      for (const spec of INSTRUMENTATION_SPECS) {
        for (const eol of ["\n", "\r\n"]) {
          const old = instrumentationBlock(spec, false).split("\n").join(eol);
          if (src.includes(old)) {
            ok(`Upgraded ${existing}: the hoplens/node import type-checks without dev dependencies`);
            return [existing, src.replace(old, instrumentationBlock(spec, true).split("\n").join(eol))];
          }
        }
      }
    }
    skip(`${existing} already loads Hoplens`);
    return null;
  }
  const BLOCK = instrumentationBlock("hoplens/node", existing.endsWith(".ts"));
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
