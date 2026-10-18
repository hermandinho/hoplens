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

/** Unbundled Node servers: build output at the root, config files at any depth. */
const NODE_EXCLUDE = ["dist/**", "build/**", "out/**", "**/*.config.*"];

const PRESET_EXCLUDE: Record<TransformPreset, readonly string[]> = {
  next: [...COMMON_EXCLUDE, ...NEXT_EXCLUDE],
  node: [...COMMON_EXCLUDE, ...NODE_EXCLUDE],
};

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
  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  if (rel.startsWith("..")) return false;
  if (!/\.(c|m)?(t|j)s$/.test(rel)) return false;
  if ([...presetExcludes(opts.preset), ...(opts.exclude ?? [])].some((g) => globToRegExp(g).test(rel))) return false;
  if (opts.include?.length && !opts.include.some((g) => globToRegExp(g).test(rel))) return false;
  // Directives must stay first and server actions / client modules have their own rules.
  const head = source.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  if (/^["']use (client|server)["']/.test(head)) return false;
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
  const ts = loadTypeScript(opts.root);
  if (!ts) return null;
  const kind = /\.(c|m)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  // Unbundled code runs as it is: a file that does not parse must fail exactly as without Hoplens,
  // and a trailer appended after an unclosed block would change (or even hide) its error.
  if (opts.preset === "node" && (sf as any).parseDiagnostics?.length) return { targets: [], constStarts: [] };
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
  if (opts.preset !== "node") return { targets, constStarts };
  addExportClauses(ts, sf, source, targets, constStarts, constOf, { isDefault, lineOf, isFnDecl });
  // The trailer rebinds each target after the module body ran: anything that took the function as a
  // value (bus.on(x, f), a handler map, `export default f`, `new f()`) would keep the original while
  // importers get the wrapper, and identity checks between the two would fail. Skip those.
  const handedOut = valueUses(ts, sf, new Set(targets.map((t) => t.name)));
  const kept = targets.filter((t) => !handedOut.has(t.name));
  if (kept.length === targets.length) return { targets, constStarts };
  const starts = new Set(kept.map((t) => constOf.get(t.name)).filter((n): n is number => n !== undefined));
  return { targets: kept, constStarts: constStarts.filter((s) => starts.has(s)) };
}

/**
 * Names in `names` the module uses as a value (anything but the callee of a call) outside their own
 * declaration and export clauses, plus constructor-style functions (`this` in a non-arrow body) and
 * functions that call themselves: the recursive call goes through the module binding, so every level
 * would go through the wrapper and recursion would run out of stack far sooner than without Hoplens.
 * Conservative: a shadowing local of the same name counts too.
 */
function valueUses(ts: any, sf: any, names: Set<string>): Set<string> {
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
    if (n.kind === K.Identifier && names.has(n.text) && n.parent && !notAUse(n, n.parent)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // `this` in the function's own body (arrows share it; nested functions and classes do not).
  const usesThis = (body: any): boolean => {
    let found = false;
    const walk = (n: any): void => {
      if (found) return;
      if (n.kind === K.ThisKeyword) {
        found = true;
        return;
      }
      if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
      if (ts.isClassLike(n)) return;
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(body, walk);
    return found;
  };
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
      if (usesThis(st.body) || callsSelf(st.body, st.name.text)) out.add(st.name.text);
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
        else if (callsSelf(init.body, d.name.text)) out.add(d.name.text);
      }
    }
  }
  return out;
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
  if (!mayHaveTargets(source)) return null;
  const found = collectTargets(source, file, opts);
  if (!found?.targets.length) return null;
  const { targets, constStarts } = found;

  let out = source;
  for (const start of [...constStarts].sort((a, b) => b - a)) {
    out = `${out.slice(0, start)}let  ${out.slice(start + 5)}`;
  }

  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  const calls = targets
    .map((t) => `${t.name} = __tpw(${t.name}, ${JSON.stringify({ name: t.name, file: rel, line: t.line })});`)
    .join(" ");
  out += `\n;(function () { var __tpw = globalThis["__hoplens"] && globalThis["__hoplens"].wrap; if (typeof __tpw !== "function") return; ${calls} })();\n`;
  return out;
}

export { loadTypeScript } from "./ts";
