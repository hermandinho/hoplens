/**
 * The two files `hoplens init` wires on a Next.js project, shared by init, remove and doctor.
 *
 * next.config: `hoplens` is a dev dependency, so the config must not load `hoplens/next` when Next
 * reads it for `next build` / `next start` (a production install has no dev dependencies, and a
 * top-level import fails with "Cannot find module 'hoplens/next'"). init exports a function that
 * returns the user's config unchanged outside the `next dev` phase and loads `hoplens/next` lazily in
 * it. There is no try/catch: production never resolves hoplens, and in dev every failure surfaces.
 *
 * ```ts
 * export default async (phase: string, ctx: { defaultConfig: NextConfig }) => {
 *   if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;
 *   // Hoplens is a dev dependency: only `next dev` loads it
 *   const { withHoplens } = await import("hoplens/next" as string);
 *   return withHoplens(nextConfig)(phase, ctx);
 * };
 * ```
 *
 * The function replaces only the exported expression (`export default <expr>` /
 * `module.exports = <expr>`), so `remove` gives the original back byte for byte. In `.ts` the
 * specifier is `"hoplens/next" as string`: a plain literal fails next build's type check (TS2307)
 * when hoplens has been pruned. `.mjs` / ESM `.js` / `.mts` import `next/constants.js` (Node ESM
 * rejects the bare `next/constants`); Next compiles `next.config.ts` to CommonJS, so it keeps the
 * bare form there, and top-level await is out (ERR_REQUIRE_ASYNC_MODULE).
 *
 * The form init wrote before 0.3 (`import { withHoplens } from "hoplens/next"` at the top,
 * `export default withHoplens(nextConfig)`) is "unguarded": init upgrades it, remove still undoes
 * it, doctor warns about it.
 */

export const CONFIG_FILES = [
  "next.config.ts",
  "next.config.mts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
];

/** The comment init writes inside the guarded function. */
export const GUARD_COMMENT = "// Hoplens is a dev dependency: only `next dev` loads it";

/** The config init creates when there is none, before guarding (remove deletes a file left like this). */
const BASE_TS = `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`;
const BASE_JS = `/** @type {import("next").NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`;

/** A top-level static import / require of hoplens/next (or the 0.1.0 / 0.1.1 `@hoplens/next`). */
const STATIC_LOAD =
  /^[ \t]*import\s[^;'"()]*?\bfrom\s*["']@?hoplens\/next["']|^[ \t]*import\s*["']@?hoplens\/next["']|^(?:const|let|var)\s[^;'"]*?=\s*require\(\s*["']@?hoplens\/next["']\s*\)/m;
const DYNAMIC_LOAD = /\b(?:import|require)\s*\(\s*["']@?hoplens\/next["']/;
const SOLE_IMPORT = /^[ \t]*import\s*\{\s*withHoplens\s*\}\s*from\s*(["'])(@?hoplens\/next)\1\s*;?[ \t]*\r?\n?/m;
const SOLE_REQUIRE =
  /^[ \t]*const\s*\{\s*withHoplens\s*\}\s*=\s*require\(\s*(["'])(@?hoplens\/next)\1\s*\)\s*;?[ \t]*\r?\n?/m;

/**
 * - `guarded`: hoplens/next is loaded only inside a `PHASE_DEVELOPMENT_SERVER` gate (what init writes).
 * - `unguarded`: hoplens/next is imported at the top; next build / start fail without dev dependencies.
 * - `wrapped`: uses withHoplens some other way (a hand-written loader); left alone.
 * - `none`: no withHoplens.
 */
export type ConfigState = "guarded" | "unguarded" | "wrapped" | "none";

export function configState(src: string): ConfigState {
  if (!src.includes("withHoplens")) return "none";
  if (STATIC_LOAD.test(src)) return "unguarded";
  if (DYNAMIC_LOAD.test(src) && /\bPHASE_DEVELOPMENT_SERVER\b/.test(src)) return "guarded";
  return "wrapped";
}

type Kind = { ts: boolean; cjs: boolean; constants: string; eol: string };

function kindOf(name: string, src: string): Kind {
  const cjs =
    name.endsWith(".cjs") || (name.endsWith(".js") && /module\.exports\s*=/.test(src) && !/export\s+default/.test(src));
  const ts = name.endsWith(".ts") || name.endsWith(".mts");
  // Next compiles next.config.ts to CommonJS; .mts / .mjs / ESM .js run as Node ESM, which needs the extension.
  const constants = cjs || name.endsWith(".ts") ? "next/constants" : "next/constants.js";
  return { ts, cjs, constants, eol: src.includes("\r\n") ? "\r\n" : "\n" };
}

function parse(ts: any, name: string, src: string) {
  return ts.createSourceFile(
    name,
    src,
    ts.ScriptTarget.Latest,
    true,
    /\.m?ts$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
}

/** The expression in the `export default <expr>` / `module.exports = <expr>` slot (the last one). */
function exportSlot(ts: any, sf: any, cjs: boolean): any | null {
  let slot: any = null;
  for (const st of sf.statements) {
    if (!cjs && ts.isExportAssignment(st) && !st.isExportEquals) slot = st.expression;
    if (
      cjs &&
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      st.expression.left.getText(sf) === "module.exports"
    )
      slot = st.expression.right;
  }
  return slot;
}

/** The config init creates for a project with no next.config. */
export function greenfieldConfig(ts: any, file: "next.config.ts" | "next.config.mjs"): string {
  const r = guardConfig(ts, file, file.endsWith(".ts") ? BASE_TS : BASE_JS);
  if ("error" in r) throw new Error(r.error);
  return r.out;
}

export type GuardResult = { out: string; upgraded: boolean } | { error: string };

/**
 * Wrap the exported config in the phase-gated function. Upgrades the unguarded form (a sole
 * `import { withHoplens } from "hoplens/next"` plus `withHoplens(config[, options])` in the export
 * slot), keeping its specifier and options. Call only for state `none` or `unguarded`.
 */
export function guardConfig(ts: any, name: string, src: string): GuardResult {
  const k = kindOf(name, src);
  let sf = parse(ts, name, src);
  let slot = exportSlot(ts, sf, k.cjs);
  if (!slot) return { error: "no-export" };

  let base: any = slot;
  let opts = "";
  let spec = "hoplens/next";
  let body = src;
  let upgraded = false;
  if (isWithHoplensCall(ts, sf, slot)) {
    const re = k.cjs ? SOLE_REQUIRE : SOLE_IMPORT;
    const m = re.exec(src);
    body = stripLine(src, re);
    if (!m || STATIC_LOAD.test(body)) return { error: "import" };
    spec = m[2]!;
    // The pre-0.3 greenfield config: start over from today's.
    if (spec === "hoplens/next" && squash(body) === "exportdefaultwithHoplens({});") {
      const r = guardConfig(ts, name, k.ts ? BASE_TS : BASE_JS);
      return "error" in r ? r : { out: r.out, upgraded: true };
    }
    upgraded = true;
    // Re-find the slot in the text without the import.
    sf = parse(ts, name, body);
    slot = exportSlot(ts, sf, k.cjs);
    const args = slot.arguments;
    base = args[0] ?? null;
    if (args.length > 1) opts = body.slice(args[1].getStart(sf), args[args.length - 1].getEnd());
  }

  const baseText = base ? base.getText(sf) : "{}";
  const seen = `${baseText} ${opts}`;
  const P = free(["phase", "nextPhase"], seen);
  const C = free(["ctx", "nextCtx"], seen);
  const direct = !!base && ts.isIdentifier(base) && base.text !== P && base.text !== C;
  const local = direct ? baseText : free(["config", "nextConfig", "baseConfig"], seen);
  const fn = !!base && isFunctionConfig(ts, sf, base);
  const load = k.cjs
    ? `require(${JSON.stringify(spec)})`
    : `await import(${JSON.stringify(spec)}${k.ts ? " as string" : ""})`;
  const guarded = [
    k.ts ? `async (${P}: string, ${C}: { defaultConfig: NextConfig }) => {` : `async (${P}, ${C}) => {`,
    ...(direct ? [] : [`  const ${local} = ${baseText};`]),
    `  if (${P} !== PHASE_DEVELOPMENT_SERVER) return ${fn ? `${local}(${P}, ${C})` : local};`,
    `  ${GUARD_COMMENT}`,
    `  const { withHoplens } = ${load};`,
    `  return withHoplens(${local}${opts ? `, ${opts}` : ""})(${P}, ${C});`,
    "}",
  ].join(k.eol);
  let out = `${body.slice(0, slot.getStart(sf))}${guarded}${body.slice(slot.getEnd())}`;

  if (k.cjs) {
    if (!/\bPHASE_DEVELOPMENT_SERVER\b/.test(body))
      out = `const { PHASE_DEVELOPMENT_SERVER } = require("${k.constants}");${k.eol}${out}`;
  } else {
    if (k.ts && !/\bNextConfig\b/.test(body)) out = addImport(out, `import type { NextConfig } from "next";`, k.eol);
    if (!/\bPHASE_DEVELOPMENT_SERVER\b/.test(body))
      out = addImport(out, `import { PHASE_DEVELOPMENT_SERVER } from "${k.constants}";`, k.eol);
  }
  return { out, upgraded };
}

export type UnguardResult = { out: string | null } | { error: string };

/**
 * Reverse of guardConfig (and of the pre-0.3 wrap): the exported expression back as it was, the
 * imports init added gone when nothing else uses them. `out: null` when what is left is a config
 * init created (the file should be deleted).
 */
export function unguardConfig(ts: any, name: string, src: string): UnguardResult {
  const k = kindOf(name, src);
  const sf = parse(ts, name, src);
  const slot = exportSlot(ts, sf, k.cjs);
  if (!slot) return { error: "no-export" };
  let out: string;
  if (isWithHoplensCall(ts, sf, slot)) {
    const inner = slot.arguments[0];
    out = `${src.slice(0, slot.getStart(sf))}${inner ? inner.getText(sf) : "{}"}${src.slice(slot.getEnd())}`;
    out = stripOldImport(out, k.cjs);
  } else {
    const baseText = guardedBase(ts, sf, slot);
    if (baseText === null) return { error: "shape" };
    out = `${src.slice(0, slot.getStart(sf))}${baseText}${src.slice(slot.getEnd())}`;
    out = stripUnused(
      out,
      k.cjs
        ? /^[ \t]*const\s*\{\s*PHASE_DEVELOPMENT_SERVER\s*\}\s*=\s*require\(\s*["']next\/constants(?:\.js)?["']\s*\)\s*;?[ \t]*\r?\n?/m
        : /^[ \t]*import\s*\{\s*PHASE_DEVELOPMENT_SERVER\s*\}\s*from\s*["']next\/constants(?:\.js)?["']\s*;?[ \t]*\r?\n?/m,
      "PHASE_DEVELOPMENT_SERVER",
    );
    if (!k.cjs)
      out = stripUnused(
        out,
        /^[ \t]*import\s+type\s*\{\s*NextConfig\s*\}\s*from\s*["']next["']\s*;?[ \t]*\r?\n?/m,
        "NextConfig",
      );
  }
  const left = squash(out);
  if (["exportdefault{};", "module.exports={};", squash(BASE_TS), squash(BASE_JS)].includes(left)) return { out: null };
  return { out };
}

/** The config text inside init's guarded function, or null when slot is not that function. */
function guardedBase(ts: any, sf: any, slot: any): string | null {
  if (!ts.isArrowFunction(slot) || !slot.body || !ts.isBlock(slot.body)) return null;
  const text = slot.body.getText(sf);
  if (!/\bPHASE_DEVELOPMENT_SERVER\b/.test(text) || !DYNAMIC_LOAD.test(text) || !text.includes("withHoplens"))
    return null;
  const stmts = slot.body.statements;
  const gate = stmts.find(
    (s: any) => ts.isIfStatement(s) && /\bPHASE_DEVELOPMENT_SERVER\b/.test(s.expression.getText(sf)),
  );
  const ret = gate?.thenStatement;
  if (!ret || !ts.isReturnStatement(ret) || !ret.expression) return null;
  const e = ts.isCallExpression(ret.expression) ? ret.expression.expression : ret.expression;
  if (!ts.isIdentifier(e)) return null;
  const first = stmts[0];
  if (first && ts.isVariableStatement(first)) {
    const d = first.declarationList.declarations;
    if (d.length === 1 && ts.isIdentifier(d[0].name) && d[0].name.text === e.text && d[0].initializer)
      return d[0].initializer.getText(sf);
  }
  return e.text;
}

function isWithHoplensCall(ts: any, sf: any, node: any): boolean {
  return ts.isCallExpression(node) && node.expression.getText(sf) === "withHoplens";
}

/** A config Next calls with (phase, ctx): a function expression, or a top-level function binding. */
function isFunctionConfig(ts: any, sf: any, node: any): boolean {
  const isFn = (n: any): boolean => {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n)))
      n = n.expression;
    return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  };
  if (isFn(node)) return true;
  if (!ts.isIdentifier(node)) return false;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === node.text) return true;
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === node.text) return isFn(d.initializer);
  }
  return false;
}

function free(names: string[], text: string): string {
  for (const n of names) if (!new RegExp(`\\b${n}\\b`).test(text)) return n;
  let i = 2;
  while (new RegExp(`\\b${names[0]}${i}\\b`).test(text)) i++;
  return `${names[0]}${i}`;
}

function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * Remove the first line matching re. At the start of the file it also takes the blank line after it,
 * which is what addImport writes when a file has no imports.
 */
function stripLine(src: string, re: RegExp): string {
  const m = re.exec(src);
  if (!m) return src;
  let end = m.index + m[0].length;
  if (m.index === 0) {
    const blank = /^\r?\n/.exec(src.slice(end));
    if (blank) end += blank[0].length;
  }
  return src.slice(0, m.index) + src.slice(end);
}

/** stripLine, kept only when `id` no longer appears anywhere else. */
function stripUnused(src: string, re: RegExp, id: string): string {
  const out = stripLine(src, re);
  return out !== src && !new RegExp(`\\b${id}\\b`).test(out) ? out : src;
}

/** The pre-0.3 import / require of withHoplens (sole, or one name in a list). */
function stripOldImport(src: string, cjs: boolean): string {
  const out = stripLine(src, cjs ? SOLE_REQUIRE : SOLE_IMPORT);
  if (out !== src || cjs) return out;
  return src.replace(/\{\s*withHoplens\s*,\s*/g, "{ ").replace(/,\s*withHoplens\s*(?=[},])/g, "");
}

/** Insert `line` after the last import, or at the top followed by a blank line. */
export function addImport(src: string, line: string, eol = "\n"): string {
  const cr = eol === "\r\n" ? "\r" : "";
  const lines = src.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*import\s/.test(lines[i]!)) last = i;
  if (last >= 0) {
    while (
      last < lines.length - 1 &&
      !/from\s+["'][^"']+["'];?\s*$|^\s*import\s+["'][^"']+["'];?\s*$/.test(lines[last]!)
    )
      last++;
    lines.splice(last + 1, 0, line + cr);
    return lines.join("\n");
  }
  return `${line}${eol}${eol}${src}`;
}

// ── instrumentation ─────────────────────────────────────────────────────────

/**
 * The block init adds to `register()`. In a .ts file the specifier is `as string`: a plain literal
 * fails next build's type check (TS2307) once dev dependencies are pruned. `@hoplens/next/node` is
 * what 0.1.0 / 0.1.1 wrote.
 */
export function instrumentationBlock(spec: "hoplens/node" | "@hoplens/next/node", ts: boolean): string {
  return [
    "  // Hoplens: request journey visualizer at /__hoplens (dev only)",
    '  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {',
    `    await import("${spec}"${ts ? " as string" : ""});`,
    "  }",
  ].join("\n");
}

export const INSTRUMENTATION_SPECS = ["hoplens/node", "@hoplens/next/node"] as const;

/** Every block any init wrote, newest first. */
export const KNOWN_BLOCKS = INSTRUMENTATION_SPECS.flatMap((s) => [
  instrumentationBlock(s, true),
  instrumentationBlock(s, false),
]);

/** A plain-literal Hoplens import in a .ts instrumentation file (fails a pruned build's type check). */
export const LITERAL_NODE_IMPORT = /\bimport\(\s*["'](?:hoplens\/node|@hoplens\/next\/node)["']\s*\)/;
