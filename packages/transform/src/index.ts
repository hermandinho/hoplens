// Rewrites each exported function so it runs through the Hoplens wrapper, without ever moving
// a byte of original source — `const` → `let  ` (same length) + wrapper code appended at EOF.
// Source maps stay valid, so stack traces still land on the user's lines.

import path from "node:path";
import { loadTypeScript } from "./ts";

/**
 * `next` (the default) is the bundler path used by `@hoplens/next`. `node` is for unbundled
 * servers (Express, …): none of the Next entry-file excludes, config files and build output
 * excluded at any depth, and `export { f }` clauses wrapped as well.
 */
export type TransformPreset = "next" | "node";

export interface TransformOptions {
  root: string;
  include?: string[];
  exclude?: string[];
  preset?: TransformPreset;
}

/** Paths never auto-traced under any preset: dependencies, declarations and tests. */
const COMMON_EXCLUDE = ["**/node_modules/**", "**/*.d.ts", "**/*.test.*", "**/*.spec.*", "**/__tests__/**"];

/** Next.js: framework entry files, routes, pages and root config files. */
const NEXT_EXCLUDE = [
  "**/.next/**",
  "app/**",
  "src/app/**",
  "pages/**",
  "src/pages/**",
  "instrumentation*",
  "src/instrumentation*",
  "middleware*",
  "src/middleware*",
  "proxy*",
  "src/proxy*",
  "next.config.*",
  "*.config.*",
];

/** Build output at the root of an unbundled Node server. An `include` glob naming the dir opts back in. */
const NODE_OUTPUT_DIRS = ["dist", "build", "out"];

/** Unbundled Node servers: build output at the root, config files at any depth. */
const NODE_EXCLUDE = [...NODE_OUTPUT_DIRS.map((d) => `${d}/**`), "**/*.config.*"];

const PRESET_EXCLUDE: Record<TransformPreset, readonly string[]> = {
  next: [...COMMON_EXCLUDE, ...NEXT_EXCLUDE],
  node: [...COMMON_EXCLUDE, ...NODE_EXCLUDE],
};

/**
 * Under `node`, a build-output dir (`dist/`, `build/`, `out/`) is in scope only through an `include`
 * glob that starts with that dir (`dist/**`): a broad include like `**` never pulls compiled output in.
 */
function outputDirIncluded(rel: string, opts: TransformOptions): boolean {
  if (opts.preset !== "node" || !opts.include?.length) return false;
  const dir = NODE_OUTPUT_DIRS.find((d) => rel.startsWith(`${d}/`));
  return Boolean(dir && opts.include.some((g) => g.startsWith(`${dir}/`) && globToRegExp(g).test(rel)));
}

/** Built-in excludes of a preset; anything but `"node"` means `"next"`. */
export function presetExcludes(preset: TransformPreset | undefined): readonly string[] {
  return preset === "node" ? PRESET_EXCLUDE.node : PRESET_EXCLUDE.next;
}

/**
 * Cheap prescan, meant to run before TypeScript is loaded. False means the source certainly has
 * nothing to wrap (no `export` / `exports` token anywhere); true only means "worth parsing".
 */
export function mayHaveTargets(source: string): boolean {
  return /\bexports?\b/.test(source);
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBody(glob)}$`);
}

function globBody(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) {
        re += escapeRe(c);
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map(globBody)
        .join("|")})`;
      i = end;
    } else re += escapeRe(c as string);
  }
  return re;
}
const escapeRe = (s: string) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

export function shouldTrace(file: string, source: string, opts: TransformOptions): boolean {
  if (!/\.(c|m)?(t|j)s$/.test(file)) return false;
  if (!inScope(file, opts)) return false;
  // Directives must stay first and server actions / client modules have their own rules.
  const head = source.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  if (/^["']use (client|server)["']/.test(head)) return false;
  return true;
}

/**
 * Inside the root and the include / exclude / preset scope, by path alone and for any extension
 * (the request path keeps a loader's .tsx / .jsx output too; only hop targets need shouldTrace's).
 */
export function inScope(file: string, opts: TransformOptions): boolean {
  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  if (rel.startsWith("..")) return false;
  const outputOk = outputDirIncluded(rel, opts);
  const builtIn = presetExcludes(opts.preset).filter(
    (g) => !(outputOk && NODE_OUTPUT_DIRS.some((d) => g === `${d}/**`)),
  );
  if ([...builtIn, ...(opts.exclude ?? [])].some((g) => globToRegExp(g).test(rel))) return false;
  if (opts.include?.length && !opts.include.some((g) => globToRegExp(g).test(rel))) return false;
  return true;
}

export interface Target {
  /** Local binding the trailer re-assigns (and the name shown on the hop). */
  name: string;
  /** Name the module exports it under; differs from `name` only for `export { f as g }`. */
  exported: string;
  /** 1-based line of the declaration in the parsed source. */
  line: number;
}

export interface CollectedTargets {
  targets: Target[];
  /** Offsets of the `const` keywords to overwrite with `let  ` (same length). */
  constStarts: number[];
}

/**
 * Finds the functions a module exports, without changing anything. Null when TypeScript could
 * not be loaded. `export { f }` / `export { f as g }` clauses are only resolved under the `node`
 * preset, so the Next path keeps its exact output.
 */
export function collectTargets(source: string, file: string, opts: TransformOptions): CollectedTargets | null {
  const found = collect(source, file, opts);
  return found && { targets: found.targets, constStarts: found.constStarts };
}

/** collectTargets, plus the parse (COMPILED mode reads the raw declarations' shapes from it). */
function collect(
  source: string,
  file: string,
  opts: TransformOptions,
): (CollectedTargets & { ts: any; sf: any }) | null {
  const ts = loadTypeScript(opts.root);
  if (!ts) return null;
  const kind = /\.(c|m)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const done = (targets: Target[], constStarts: number[]) => ({ targets, constStarts, ts, sf });
  // Unbundled code runs as it is: a file that does not parse must fail exactly as without Hoplens,
  // and a trailer appended after an unclosed block would change (or even hide) its error.
  if (opts.preset === "node" && (sf as any).parseDiagnostics?.length) return done([], []);
  const targets: Target[] = [];
  const constStarts: number[] = [];
  /** Local name -> the offset of its `const` keyword, for targets declared with const. */
  const constOf = new Map<string, number>();
  const isExported = (n: any) => n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n: any) => n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword);
  const lineOf = (n: any) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const unwrap = (e: any): any => {
    while (
      e &&
      (ts.isParenthesizedExpression(e) ||
        ts.isAsExpression(e) ||
        ts.isSatisfiesExpression?.(e) ||
        ts.isTypeAssertionExpression?.(e))
    ) {
      e = e.expression;
    }
    return e;
  };
  const isFnDecl = (d: any): boolean => {
    const init = unwrap(d.initializer);
    return Boolean(
      ts.isIdentifier(d.name) &&
        init &&
        (ts.isArrowFunction(init) || (ts.isFunctionExpression(init) && !init.asteriskToken)),
    );
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && isExported(st) && !isDefault(st) && st.name && st.body && !st.asteriskToken) {
      targets.push({ name: st.name.text, exported: st.name.text, line: lineOf(st) });
    } else if (ts.isVariableStatement(st) && isExported(st)) {
      const list = st.declarationList;
      const fnDecls = list.declarations.filter(isFnDecl);
      if (!fnDecls.length) continue;
      if (list.flags & ts.NodeFlags.Const) {
        const start = list.getStart(sf);
        if (source.slice(start, start + 5) !== "const") continue;
        constStarts.push(start);
        for (const d of fnDecls) constOf.set((d.name as any).text, start);
      } else if (list.flags & (ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) continue;
      for (const d of fnDecls) {
        const name = (d.name as any).text;
        targets.push({ name, exported: name, line: lineOf(d) });
      }
    }
  }
  if (opts.preset !== "node") return done(targets, constStarts);
  addExportClauses(ts, sf, source, targets, constStarts, constOf, { isDefault, lineOf, isFnDecl });
  // The trailer rebinds each target after the module body ran: anything that took the function as a
  // value (bus.on(x, f), a handler map, `export default f`, `new f()`) would keep the original while
  // importers get the wrapper, and identity checks between the two would fail. Skip those.
  const handedOut = valueUses(ts, sf, new Set(targets.map((t) => t.name)));
  const kept = targets.filter((t) => !handedOut.has(t.name));
  if (kept.length === targets.length) return done(targets, constStarts);
  const starts = new Set(kept.map((t) => constOf.get(t.name)).filter((n): n is number => n !== undefined));
  return done(
    kept,
    constStarts.filter((s) => starts.has(s)),
  );
}

/**
 * Names in `names` the module uses as a value (anything but the callee of a call) outside their own
 * declaration and export clauses, plus constructor-style functions (`this` in a non-arrow body) and
 * functions that call themselves: the recursive call goes through the module binding, so every level
 * would go through the wrapper and recursion would run out of stack far sooner than without Hoplens.
 * Conservative: a shadowing local of the same name counts too.
 */
function valueUses(
  ts: any,
  sf: any,
  names: Set<string>,
  { ignore, selfCalls = true }: { ignore?: Set<any>; selfCalls?: boolean } = {},
): Set<string> {
  const out = new Set<string>();
  if (!names.size) return out;
  const K = ts.SyntaxKind;
  const nameOf = (p: any, n: any): boolean => p.name === n;
  const notAUse = (n: any, p: any): boolean => {
    switch (p.kind) {
      case K.CallExpression:
        return p.expression === n;
      case K.TaggedTemplateExpression:
        return p.tag === n;
      case K.PropertyAccessExpression:
        return p.name === n;
      case K.QualifiedName:
        return p.right === n;
      case K.FunctionDeclaration:
      case K.FunctionExpression:
      case K.VariableDeclaration:
      case K.Parameter:
      case K.ClassDeclaration:
      case K.ClassExpression:
      case K.PropertyAssignment:
      case K.MethodDeclaration:
      case K.PropertyDeclaration:
      case K.GetAccessor:
      case K.SetAccessor:
      case K.PropertySignature:
      case K.MethodSignature:
      case K.EnumMember:
      case K.JsxAttribute:
        return nameOf(p, n);
      case K.BindingElement:
        return p.propertyName === n || p.name === n;
      case K.ExportSpecifier:
      case K.ImportSpecifier:
      case K.ImportClause:
      case K.NamespaceImport:
      case K.LabeledStatement:
      case K.BreakStatement:
      case K.ContinueStatement:
        return true;
      default:
        return false;
    }
  };
  const isTypeOnly = (n: any): boolean =>
    n.kind === K.InterfaceDeclaration ||
    n.kind === K.TypeAliasDeclaration ||
    (ts.isTypeNode(n) && n.kind !== K.ExpressionWithTypeArguments);
  const visit = (n: any): void => {
    if (isTypeOnly(n)) return;
    if (n.kind === K.Identifier && names.has(n.text) && n.parent && !ignore?.has(n) && !notAUse(n, n.parent))
      out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const usesThis = (body: any) => usesOwnThis(ts, body);
  const callsSelf = (body: any, name: string): boolean => {
    let found = false;
    const walk = (n: any): void => {
      if (found) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
        found = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    return found;
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body && names.has(st.name.text)) {
      if (usesThis(st.body) || (selfCalls && callsSelf(st.body, st.name.text))) out.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !names.has(d.name.text)) continue;
        let init = d.initializer;
        while (
          init &&
          (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init))
        )
          init = init.expression;
        if (!init?.body) continue;
        if (ts.isFunctionExpression(init) && usesThis(init.body)) out.add(d.name.text);
        else if (selfCalls && callsSelf(init.body, d.name.text)) out.add(d.name.text);
      }
    }
  }
  return out;
}

/** `this` in a function's own body (arrows share it; nested functions and classes do not). */
function usesOwnThis(ts: any, body: any): boolean {
  let found = false;
  const walk = (n: any): void => {
    if (found) return;
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
    if (ts.isClassLike(n)) return;
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}

/**
 * `export { f }` / `export { f as g }` (no `from`): adds `f` once when its only top-level
 * declaration is a `function f` with a body or a `const|let|var f = <function>` binding. Any other
 * declaration of the name (class, enum, namespace, import, destructuring, a second binding), a
 * generator, or an alias to `default` leaves it alone.
 */
function addExportClauses(
  ts: any,
  sf: any,
  source: string,
  targets: Target[],
  constStarts: number[],
  constOf: Map<string, number>,
  h: { isDefault: (n: any) => boolean; lineOf: (n: any) => number; isFnDecl: (d: any) => boolean },
): void {
  const clauses: { local: string; exported: string }[] = [];
  const asDefault = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier || st.isTypeOnly) continue;
    if (!st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const el of st.exportClause.elements) {
      const local = el.propertyName ?? el.name;
      if (el.isTypeOnly || !ts.isIdentifier(local)) continue;
      if (el.name.text === "default") asDefault.add(local.text);
      else clauses.push({ local: local.text, exported: el.name.text });
    }
  }
  if (!clauses.length) return;

  interface Decl {
    line: number;
    ok: boolean;
    constStart?: number;
  }
  const decls = new Map<string, Decl[]>();
  const add = (name: string, d: Decl) => {
    const list = decls.get(name);
    if (list) list.push(d);
    else decls.set(name, [d]);
  };
  const blocked = { line: 0, ok: false };
  const bindingNames = (n: any, out: string[]): string[] => {
    if (ts.isIdentifier(n)) out.push(n.text);
    else if (n?.elements) for (const e of n.elements) if (!ts.isOmittedExpression(e)) bindingNames(e.name, out);
    return out;
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      // Overload signatures and `declare function` have no body and add no binding.
      if (st.name && st.body) add(st.name.text, { line: h.lineOf(st), ok: !st.asteriskToken && !h.isDefault(st) });
    } else if (ts.isVariableStatement(st)) {
      const list = st.declarationList;
      // AwaitUsing is Const | Using, so test the Using bit, and Const only without it.
      const using = (list.flags & ts.NodeFlags.Using) !== 0;
      const isConst = !using && (list.flags & ts.NodeFlags.Const) !== 0;
      const start = list.getStart(sf);
      const constOk = !isConst || source.slice(start, start + 5) === "const";
      for (const d of list.declarations) {
        if (!ts.isIdentifier(d.name)) {
          for (const n of bindingNames(d.name, [])) add(n, blocked);
          continue;
        }
        add(d.name.text, {
          line: h.lineOf(d),
          ok: !using && constOk && h.isFnDecl(d),
          constStart: isConst ? start : undefined,
        });
      }
    } else if (ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
      if (st.name && ts.isIdentifier(st.name)) add(st.name.text, blocked);
    } else if (ts.isImportEqualsDeclaration(st)) {
      add(st.name.text, blocked);
    } else if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      if (c?.name) add(c.name.text, blocked);
      const nb = c?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) add(nb.name.text, blocked);
      else if (nb) for (const e of nb.elements) add(e.name.text, blocked);
    }
  }

  const done = new Set(targets.map((t) => t.name));
  const consts = new Set(constStarts);
  for (const { local, exported } of clauses) {
    if (done.has(local) || asDefault.has(local)) continue;
    const list = decls.get(local);
    const d = list?.length === 1 ? list[0]! : undefined;
    if (!d?.ok) continue;
    done.add(local);
    if (d.constStart !== undefined) constOf.set(local, d.constStart);
    if (d.constStart !== undefined && !consts.has(d.constStart)) {
      consts.add(d.constStart);
      constStarts.push(d.constStart);
    }
    targets.push({ name: local, exported, line: d.line });
  }
}

export function transformSource(source: string, file: string, opts: TransformOptions): string | null {
  return rewriteModule(source, file, opts)?.code ?? null;
}

/** transformSource, plus how many functions the trailer rebinds. `before` goes between the source and the trailer. */
function rewriteModule(
  source: string,
  file: string,
  opts: TransformOptions,
  before = "",
): { code: string; fns: number } | null {
  if (!mayHaveTargets(source)) return null;
  const found = collectTargets(source, file, opts);
  if (!found?.targets.length) return null;
  const { targets, constStarts } = found;

  let out = source;
  for (const start of [...constStarts].sort((a, b) => b - a)) {
    out = `${out.slice(0, start)}let  ${out.slice(start + 5)}`;
  }

  const code =
    out +
    before +
    trailer(
      targets.map((t) => ({ ...t, binding: t.name })),
      file,
      opts,
    );
  return { code, fns: targets.length };
}

/** What transformCommonJS made of a module: the source with a trailer appended, and its function count. */
export interface CommonJSResult {
  code: string;
  fns: number;
}

/**
 * Cheap prescan for the CommonJS export shapes transformCommonJS wraps (`exports.X =`,
 * `module.exports = {`, `Object.defineProperty(exports, ...)`); false means nothing to wrap.
 */
export function mayHaveCommonJSTargets(source: string): boolean {
  return /\bexports\s*(?:\.\s*[\w$]+|\[\s*["'][^"']*["']\s*\])\s*=(?!=)|\bmodule\.exports\s*=\s*\{|\bdefineProperty\(\s*(?:module\.)?exports\b|^\s*export\s/m.test(
    source,
  );
}

/** .ts / .cts / .mts: a loader (tsx, ts-node) or Node's type stripping compiles it after Hoplens. */
const TS_FILE = /\.(c|m)?ts$/;

/** Its own line before the (one-line) trailer, so a type-checking loader (ts-node) accepts it. */
const TS_IGNORE = "\n// @ts-ignore";

/**
 * For the CommonJS loader (`require`), always the `node` preset. The source is the file on disk,
 * rewritten before the next loader (Node itself, tsx, ts-node) compiles it:
 * - TypeScript written with `export` syntax gets transformSource's trailer (the loader compiles the
 *   rebinding with the rest; its CommonJS output reads the local binding, so importers see the wrap);
 * - JavaScript with `import` / `export` syntax is left alone (Node loads it as an ES module, where the
 *   ESM hook handles it);
 * - CommonJS export shapes (`exports.X = f`, `module.exports.X = f`, `module.exports = { a, b: f, c() {} }`,
 *   `Object.defineProperty(exports, "X", { value: f })`, tsc's `exports.X = void 0; ... exports.X = X`)
 *   get a trailer that rebinds the *exports property*, and only when, after the module ran, it is still
 *   an own writable data property holding a function. Getter exports (tsc re-exports, esbuild's
 *   `__export`), frozen and non-writable exports are skipped without throwing, and
 *   `module.exports = f` is never wrapped. Calls through the module's own local binding stay unwrapped,
 *   and so does a value read from a cycle partner that is still loading (`require` cycles hand out the
 *   exports object before its trailer ran: that module keeps the original function, every later
 *   `require` sees the wrapper). One function under several keys gets one wrapper; a function that
 *   calls itself through its own export (`exports.f(n - 1)`, `this.f()` in a method) is skipped;
 * - in a .ts / .cts file the trailer line is preceded by `// @ts-ignore` (appended at EOF too, so no
 *   line moves): ts-node type-checks what it is handed, and the trailer indexes globalThis and assigns
 *   to function declarations.
 * Null when there is nothing to wrap, the source does not parse, or TypeScript could not be loaded.
 */
export function transformCommonJS(source: string, file: string, opts: TransformOptions): CommonJSResult | null {
  if (!mayHaveCommonJSTargets(source)) return null;
  const o: TransformOptions = { ...opts, preset: "node" };
  const ts = loadTypeScript(o.root);
  if (!ts) return null;
  const kind = /\.(c|m)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  if ((sf as any).parseDiagnostics?.length) return null;
  const ignore = TS_FILE.test(file) ? TS_IGNORE : "";
  if (hasModuleSyntax(ts, sf)) return ignore ? rewriteModule(source, file, o, ignore) : null;
  const targets = commonJSTargets(ts, sf);
  if (!targets.length) return null;
  return { code: source + ignore + commonJSTrailer(targets, file, o), fns: targets.length };
}

/** `import` / `export` statements (TypeScript's `import x = require()` without `export` is CommonJS). */
function hasModuleSyntax(ts: any, sf: any): boolean {
  return sf.statements.some(
    (st: any) =>
      ts.isImportDeclaration(st) ||
      ts.isExportDeclaration(st) ||
      ts.isExportAssignment(st) ||
      hasModifier(st, ts.SyntaxKind.ExportKeyword),
  );
}

interface CjsTarget {
  /** The exports property the trailer rebinds. */
  key: string;
  /** Name shown on the hop: the function's local name, else the key. */
  name: string;
  line: number;
}

/** Keys never wrapped: ES-module interop markers and default exports. */
const CJS_SKIP_KEYS = new Set(["__esModule", "default"]);

/**
 * The exports properties a CommonJS module assigns a function to, at its top level. A key assigned more
 * than once (other than tsc's `exports.X = void 0` header), assigned anything but a function, or handed
 * out as a value inside the module (`bus.on(e, exports.X)`) is skipped, and so is a local function the
 * module uses as a value, a constructor-like function (`this` in its body) and a generator.
 */
function commonJSTargets(ts: any, sf: any): CjsTarget[] {
  const K = ts.SyntaxKind;
  const lineOf = (n: any) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /** Top-level function bindings by name; null when the name is bound more than once or not to a function. */
  const fns = new Map<string, { line: number; ctor: boolean; fn: any } | null>();
  const bind = (name: string, v: { line: number; ctor: boolean; fn: any } | null) =>
    fns.set(name, fns.has(name) ? null : v);
  const bindingNames = (n: any, out: string[]): string[] => {
    if (ts.isIdentifier(n)) out.push(n.text);
    else if (n?.elements) for (const e of n.elements) if (!ts.isOmittedExpression(e)) bindingNames(e.name, out);
    return out;
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      if (!st.name || !st.body) continue;
      bind(st.name.text, st.asteriskToken ? null : { line: lineOf(st), ctor: usesOwnThis(ts, st.body), fn: st });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          for (const n of bindingNames(d.name, [])) bind(n, null);
          continue;
        }
        const f = unwrapExpr(ts, d.initializer);
        const ok = f && (ts.isArrowFunction(f) || (ts.isFunctionExpression(f) && !f.asteriskToken));
        bind(
          d.name.text,
          ok ? { line: lineOf(d), ctor: ts.isFunctionExpression(f) && usesOwnThis(ts, f.body), fn: f } : null,
        );
      }
    } else if (ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
      if (st.name && ts.isIdentifier(st.name)) bind(st.name.text, null);
    } else if (ts.isImportEqualsDeclaration(st)) {
      bind(st.name.text, null);
    }
  }

  const isExportsObj = (e: any): boolean =>
    (ts.isIdentifier(e) && e.text === "exports") ||
    (ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "module" &&
      e.name.text === "exports");
  /** `exports.X` / `module.exports.X` / `exports["X"]`: the key, else undefined. */
  const exportKey = (e: any): string | undefined => {
    if (ts.isPropertyAccessExpression(e) && isExportsObj(e.expression) && ts.isIdentifier(e.name)) return e.name.text;
    if (ts.isElementAccessExpression(e) && isExportsObj(e.expression) && ts.isStringLiteral(e.argumentExpression))
      return e.argumentExpression.text;
    return undefined;
  };
  const isVoid0 = (e: any) => ts.isVoidExpression(e) && ts.isNumericLiteral(e.expression);
  const keyName = (n: any): string | undefined => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : undefined);

  /**
   * The callee of a call, with tsc's `(0, exports.X)(...)` form (a comma expression whose left side is a
   * number) seen through to `exports.X`.
   */
  const calleeOf = (call: any): any => {
    let c = unwrapExpr(ts, call.expression);
    if (
      ts.isBinaryExpression(c) &&
      c.operatorToken.kind === K.CommaToken &&
      ts.isNumericLiteral(unwrapExpr(ts, c.left))
    )
      c = unwrapExpr(ts, c.right);
    return c;
  };
  /**
   * The function calls itself through its own export (`exports.X(...)`, `module.exports.X(...)`,
   * `(0, exports.X)(...)`, or `this.X(...)` in a method): every level of that recursion would go through
   * the wrapper, so the app's maximum recursion depth would drop. Nested functions count too.
   */
  const callsOwnExport = (fn: any, key: string): boolean => {
    let found = false;
    const method = ts.isMethodDeclaration(fn);
    const walk = (n: any): void => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const c = calleeOf(n);
        if (exportKey(c) === key) found = true;
        else if (
          method &&
          ts.isPropertyAccessExpression(c) &&
          c.expression.kind === K.ThisKeyword &&
          ts.isIdentifier(c.name) &&
          c.name.text === key
        )
          found = true;
        if (found) return;
      }
      ts.forEachChild(n, walk);
    };
    if (fn.body) walk(fn.body);
    return found;
  };

  interface Found {
    name?: string;
    line: number;
    /** The local binding it refers to. */
    local?: string;
    /** The function node (declaration, expression, arrow or method). */
    fn: any;
  }
  /** Per key: the function it is assigned, or null when that is ambiguous or not a function. */
  const keys = new Map<string, Found | null>();
  /** Identifiers that are the value of a recognized export (not a "use" of the local). */
  const refs = new Set<any>();
  /** Export-property accesses that are assignment targets of recognized shapes. */
  const targetsOf = new Set<any>();
  const assign = (key: string | undefined, value: any, ref?: any) => {
    if (key === undefined) return;
    const f = fnRef(value, key, ref);
    if (f === undefined && value && isVoid0(value)) return;
    keys.set(key, keys.has(key) || !f ? null : f);
  };
  const fnRef = (value: any, key: string, ref?: any): Found | undefined => {
    if (!value) return undefined;
    if (ts.isMethodDeclaration(value)) {
      return value.asteriskToken || !value.body ? undefined : { name: key, line: lineOf(value), fn: value };
    }
    const e = unwrapExpr(ts, value);
    if (!e) return undefined;
    if (ts.isArrowFunction(e) || (ts.isFunctionExpression(e) && !e.asteriskToken)) {
      if (ts.isFunctionExpression(e) && usesOwnThis(ts, e.body)) return undefined;
      return { name: e.name?.text ?? key, line: lineOf(e), fn: e };
    }
    if (ts.isIdentifier(e)) {
      const b = fns.get(e.text);
      if (!b || b.ctor) return undefined;
      refs.add(ref ?? e);
      return { name: e.text, line: b.line, local: e.text, fn: b.fn };
    }
    return undefined;
  };

  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st)) continue;
    const ex = unwrapExpr(ts, st.expression);
    if (ts.isBinaryExpression(ex) && ex.operatorToken.kind === K.EqualsToken) {
      // `a = b = value`: every target in the chain gets the final value.
      const lefts: any[] = [];
      let value: any = ex;
      while (ts.isBinaryExpression(value) && value.operatorToken.kind === K.EqualsToken) {
        lefts.push(value.left);
        value = unwrapExpr(ts, value.right);
      }
      for (const left of lefts) {
        const key = exportKey(left);
        if (key !== undefined) {
          targetsOf.add(left);
          assign(key, value);
        } else if (isExportsObj(left) && ts.isObjectLiteralExpression(value)) {
          for (const p of value.properties) {
            if (ts.isShorthandPropertyAssignment(p)) assign(p.name.text, p.name, p.name);
            else if (ts.isPropertyAssignment(p)) assign(keyName(p.name), p.initializer);
            else if (ts.isMethodDeclaration(p)) assign(keyName(p.name), p);
          }
        }
      }
    } else if (
      ts.isCallExpression(ex) &&
      ts.isPropertyAccessExpression(ex.expression) &&
      ts.isIdentifier(ex.expression.expression) &&
      ex.expression.expression.text === "Object" &&
      ex.expression.name.text === "defineProperty" &&
      ex.arguments.length === 3 &&
      isExportsObj(ex.arguments[0]) &&
      ts.isStringLiteral(ex.arguments[1]) &&
      ts.isObjectLiteralExpression(ex.arguments[2])
    ) {
      // A value descriptor may be wrapped (if writable at runtime); a getter (tsc re-exports,
      // esbuild's `__export`) never is.
      const key = ex.arguments[1].text;
      const props = ex.arguments[2].properties;
      const accessor = props.some(
        (p: any) =>
          ts.isGetAccessorDeclaration(p) ||
          ts.isSetAccessorDeclaration(p) ||
          ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && ["get", "set"].includes(keyName(p.name) ?? "")),
      );
      const value = props.find((p: any) => ts.isPropertyAssignment(p) && keyName(p.name) === "value");
      if (accessor || !value) keys.set(key, null);
      else assign(key, value.initializer);
    }
  }

  // Export properties the module reads as values (not calls, not the assignments above): skip them.
  const handedOut = new Set<string>();
  const visit = (n: any): void => {
    const key = exportKey(n);
    if (key !== undefined && !targetsOf.has(n)) {
      // A call (tsc's `(0, exports.X)(...)` included) is not a value use.
      const up = (x: any) => {
        while (x && ts.isParenthesizedExpression(x)) x = x.parent;
        return x;
      };
      const p = up(n.parent);
      const comma =
        p &&
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === K.CommaToken &&
        unwrapExpr(ts, p.right) === n &&
        ts.isNumericLiteral(unwrapExpr(ts, p.left));
      const call = comma ? up(p.parent) : p;
      const callee = call && ts.isCallExpression(call) && calleeOf(call) === n;
      if (!callee) handedOut.add(key);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const locals = new Set<string>();
  for (const f of keys.values()) if (f?.local) locals.add(f.local);
  const usedLocals = valueUses(ts, sf, locals, { ignore: refs, selfCalls: false });

  const out: CjsTarget[] = [];
  for (const [key, f] of keys) {
    if (!f || CJS_SKIP_KEYS.has(key) || handedOut.has(key)) continue;
    if (f.local && usedLocals.has(f.local)) continue;
    if (callsOwnExport(f.fn, key)) continue;
    out.push({ key, name: f.name ?? key, line: f.line });
  }
  return out;
}

/**
 * The CommonJS trailer: after the module ran, each key that is still an own, writable data property of
 * `module.exports` holding a function is replaced by its wrapper. Anything else (a getter, a frozen or
 * non-writable property, a key the module dropped) stays as it is; nothing in it can throw.
 */
function commonJSTrailer(targets: CjsTarget[], file: string, opts: TransformOptions): string {
  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  const list = JSON.stringify(targets.map((t) => [t.key, { name: t.name, file: rel, line: t.line }]));
  return `\n;(function () { var __tpw = globalThis["__hoplens"] && globalThis["__hoplens"].wrap; if (typeof __tpw !== "function" || typeof module !== "object" || module === null) return; var __tpx = module.exports; if (__tpx === null || (typeof __tpx !== "object" && typeof __tpx !== "function")) return; var __tpl = ${list}; var __tpm = typeof Map === "function" ? new Map() : null; for (var __tpi = 0; __tpi < __tpl.length; __tpi++) { try { var __tpd = Object.getOwnPropertyDescriptor(__tpx, __tpl[__tpi][0]); if (__tpd && __tpd.writable === true && typeof __tpd.value === "function") { var __tpf = __tpm && __tpm.get(__tpd.value); if (!__tpf) { __tpf = __tpw(__tpd.value, __tpl[__tpi][1]); if (__tpm) __tpm.set(__tpd.value, __tpf); } __tpx[__tpl[__tpi][0]] = __tpf; } } catch (__tpe) {} } })();\n`;
}

/**
 * The code appended at EOF: rebinds each `binding` to its wrapper, once, when the module evaluates.
 * The metadata (name, file, line) is the user's source, whatever the binding is called in the code.
 */
function trailer(targets: (Target & { binding: string })[], file: string, opts: TransformOptions): string {
  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  const calls = targets
    .map((t) => `${t.binding} = __tpw(${t.binding}, ${JSON.stringify({ name: t.name, file: rel, line: t.line })});`)
    .join(" ");
  return `\n;(function () { var __tpw = globalThis["__hoplens"] && globalThis["__hoplens"].wrap; if (typeof __tpw !== "function") return; ${calls} })();\n`;
}

/**
 * What transformCompiled made of a module another loader compiled before Hoplens saw it.
 * - `wrapped`: `code` is the compiled source with the trailer appended; before EOF only `const` ->
 *   `let  ` swaps (same length) changed. `fns` functions are rebound;
 * - `none`: the raw source has nothing to wrap (or TypeScript is missing): load the compiled source;
 * - `refused`: the compiled output does not map back to the raw source with certainty: load the
 *   compiled source untouched. `reason` says what did not match.
 */
export type CompiledResult =
  | { kind: "wrapped"; code: string; fns: number }
  | { kind: "none" }
  | { kind: "refused"; reason: string };

interface Shape {
  /** `function f` (true) or a `const|let|var f = <function>` binding (false). */
  decl: boolean;
  async: boolean;
}

const hasModifier = (n: any, kind: number): boolean => Boolean(n?.modifiers?.some((m: any) => m.kind === kind));

function unwrapExpr(ts: any, e: any): any {
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression?.(e) ||
      ts.isTypeAssertionExpression?.(e) ||
      ts.isNonNullExpression(e))
  ) {
    e = e.expression;
  }
  return e;
}

/** The shape of `name`'s top-level function binding in the raw parse. */
function rawShape(ts: any, sf: any, name: string): Shape | undefined {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body && st.name?.text === name) {
      return { decl: true, async: hasModifier(st, ts.SyntaxKind.AsyncKeyword) };
    }
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
      const fn = unwrapExpr(ts, d.initializer);
      return fn ? { decl: false, async: hasModifier(fn, ts.SyntaxKind.AsyncKeyword) } : undefined;
    }
  }
  return undefined;
}

/**
 * COMPILED mode: rewrites the output of a loader that ran before Hoplens (tsx's esbuild, under
 * `tsx --import hoplens/express/register` or `node --import tsx --import ...`), with the raw source
 * from disk deciding what to wrap and where it is.
 *
 * The raw parse (collectTargets with the `node` rules, value uses, `this` and recursion included) picks
 * the functions and their lines. Each one is then found in the compiled source by its exported name,
 * through an `export { local as name }` clause or an exported declaration, as exactly one top-level
 * `function local` or `const|let|var local = <function>` binding (esbuild's `__name(<function>, "…")`
 * keep-names call allowed) of the same kind and async-ness as in the raw source. Only those bindings
 * are rebound; any other shape refuses the whole file.
 *
 * Nothing before EOF moves (`const` -> `let  ` keeps every offset), so the loader's inline source map
 * and every stack line:col stay what they were.
 */
export function transformCompiled(compiled: string, raw: string, file: string, opts: TransformOptions): CompiledResult {
  const none: CompiledResult = { kind: "none" };
  const refuse = (reason: string): CompiledResult => ({ kind: "refused", reason });
  if (!mayHaveTargets(raw)) return none;
  const o: TransformOptions = { ...opts, preset: "node" };
  const found = collect(raw, file, o);
  if (!found?.targets.length) return none;
  const { ts, sf: rawSf } = found;
  const K = ts.SyntaxKind;

  const sf = ts.createSourceFile(`${file}.mjs`, compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((sf as any).parseDiagnostics?.length) return refuse("the compiled source does not parse");

  /** Exported name -> its compiled local binding; null for a re-export or two different locals. */
  const exportsOf = new Map<string, string | null>();
  const exportAs = (exported: string, local: string | null) => {
    const had = exportsOf.get(exported);
    exportsOf.set(exported, had === undefined || had === local ? local : null);
  };
  interface Decl {
    shape?: Shape;
    constStart?: number;
  }
  const decls = new Map<string, Decl[]>();
  const add = (name: string, d: Decl) => {
    const list = decls.get(name);
    if (list) list.push(d);
    else decls.set(name, [d]);
  };
  const blocked: Decl = {};
  const bindingNames = (n: any, out: string[]): string[] => {
    if (ts.isIdentifier(n)) out.push(n.text);
    else if (n?.elements) for (const e of n.elements) if (!ts.isOmittedExpression(e)) bindingNames(e.name, out);
    return out;
  };
  /** An arrow or a non-generator function expression, bare or inside esbuild's `__name(fn, "name")`. */
  const fnInit = (init: any): any => {
    let e = unwrapExpr(ts, init);
    if (
      e &&
      ts.isCallExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "__name" &&
      e.arguments.length === 2 &&
      ts.isStringLiteral(e.arguments[1])
    ) {
      e = unwrapExpr(ts, e.arguments[0]);
    }
    return e && (ts.isArrowFunction(e) || (ts.isFunctionExpression(e) && !e.asteriskToken)) ? e : undefined;
  };

  for (const st of sf.statements) {
    const exported = hasModifier(st, K.ExportKeyword);
    const isDefault = hasModifier(st, K.DefaultKeyword);
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) {
        // `export { s as "str-name" }`: a string-literal export name counts, as on the raw side.
        if (!ts.isIdentifier(el.name) && !ts.isStringLiteral(el.name)) continue;
        const local = el.propertyName ?? el.name;
        if (st.moduleSpecifier) exportAs(el.name.text, null);
        else if (ts.isIdentifier(local)) exportAs(el.name.text, local.text);
      }
    } else if (ts.isFunctionDeclaration(st)) {
      if (!st.name || !st.body) continue;
      const ok = !st.asteriskToken && !isDefault;
      add(st.name.text, ok ? { shape: { decl: true, async: hasModifier(st, K.AsyncKeyword) } } : blocked);
      if (exported && !isDefault) exportAs(st.name.text, st.name.text);
    } else if (ts.isVariableStatement(st)) {
      const list = st.declarationList;
      const using = (list.flags & ts.NodeFlags.Using) !== 0;
      const isConst = !using && (list.flags & ts.NodeFlags.Const) !== 0;
      const start = list.getStart(sf);
      const constOk = !isConst || compiled.slice(start, start + 5) === "const";
      for (const d of list.declarations) {
        if (!ts.isIdentifier(d.name)) {
          for (const n of bindingNames(d.name, [])) add(n, blocked);
          continue;
        }
        const fn = !using && constOk ? fnInit(d.initializer) : undefined;
        const shape = fn && { decl: false, async: hasModifier(fn, K.AsyncKeyword) };
        add(d.name.text, shape ? { shape, constStart: isConst ? start : undefined } : blocked);
        if (exported) exportAs(d.name.text, d.name.text);
      }
    } else if (ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
      if (st.name && ts.isIdentifier(st.name)) add(st.name.text, blocked);
    } else if (ts.isImportEqualsDeclaration(st)) {
      add(st.name.text, blocked);
    } else if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      if (c?.name) add(c.name.text, blocked);
      const nb = c?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) add(nb.name.text, blocked);
      else if (nb) for (const e of nb.elements) add(e.name.text, blocked);
    }
  }
  // A `var` inside a top-level block is a module binding as well, assigned wherever that code runs
  // (esbuild's lowering of a top-level `using` moves the module's declarations into a try block).
  const nestedVars = (n: any): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    const topLevel = ts.isVariableStatement(n.parent) && n.parent.parent === sf;
    if (ts.isVariableDeclarationList(n) && !topLevel && !(n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
      for (const d of n.declarations) for (const name of bindingNames(d.name, [])) add(name, blocked);
    }
    ts.forEachChild(n, nestedVars);
  };
  ts.forEachChild(sf, nestedVars);

  const rebinds: (Target & { binding: string })[] = [];
  const constStarts = new Set<number>();
  for (const t of found.targets) {
    const local = exportsOf.get(t.exported);
    if (local == null) return refuse(`${t.exported}: not a local export of the compiled source`);
    const list = decls.get(local);
    const d = list?.length === 1 ? list[0] : undefined;
    if (!d?.shape) return refuse(`${t.exported}: not one top-level function binding in the compiled source`);
    const want = rawShape(ts, rawSf, t.name);
    if (!want || want.decl !== d.shape.decl || want.async !== d.shape.async) {
      return refuse(`${t.exported}: a different kind of function in the compiled source`);
    }
    if (d.constStart !== undefined) constStarts.add(d.constStart);
    rebinds.push({ ...t, binding: local });
  }

  let out = compiled;
  for (const start of [...constStarts].sort((a, b) => b - a)) {
    out = `${out.slice(0, start)}let  ${out.slice(start + 5)}`;
  }
  return { kind: "wrapped", code: out + trailer(rebinds, file, o), fns: rebinds.length };
}

export { loadTypeScript, typescriptLoaded } from "./ts";
