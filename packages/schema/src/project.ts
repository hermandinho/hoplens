// Schema finding across a project's source files: the module resolver (imports, re-exports, barrels,
// aliases, namespace imports), a per-mtime source-file cache and the `<schema>.parse(<request part>)`
// finder. Framework-neutral: adapters (Next, Express) hand it a function node and get SchemaInfo back.
// Never executes user code; TypeScript is passed in by the caller (see @hoplens/transform/ts).

import fs from "node:fs";
import path from "node:path";
import { type Resolver, type Shape, describeShape, exampleOf, interpretSchema } from "./index";

/** One schema an adapter links to a route method. Structurally the same as @hoplens/core's SchemaInfo. */
export interface SchemaInfo {
  target: "body" | "query" | "form" | "params";
  name?: string;
  /** Project-relative, `/`-separated. */
  file?: string;
  line?: number;
  shape: Shape;
  example: unknown;
  fields: { path: string; type: string; optional: boolean }[];
}

export interface SchemaProjectOptions {
  /**
   * Also follow CommonJS: `const X = require("./m")`, `const { A, B: C } = require("./m")`, and
   * `module.exports = …` / `exports.A = …` / `module.exports.A = …` in the target. Off for Next.
   */
  commonjs?: boolean;
  /** Resolve a default import to an `export default function f() {}` / `export default class`. Off for Next. */
  defaultDeclarations?: boolean;
  /**
   * Extra pattern for a parse input that is the request body, tested before the built-in ones
   * (Express passes `/\.body\b/` so `r.body` counts whatever the request is named). Off for Next.
   */
  bodyPattern?: RegExp;
}

/** A resolved declaration: the initializer (or declaration) node, its source file and the name. */
export interface Hit {
  node: any;
  sf: any;
  name: string;
}

export interface ProjectResolver extends Resolver {
  /** Find an export of `sf` (named, `default`, through re-exports and barrels). */
  resolveExport(name: string, sf: any): Hit | null;
}

/** Methods whose first argument is the input a schema validates. */
export const PARSE_METHODS = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "spa",
  "decode",
  "safeDecode",
]);

/**
 * The per-project half of schema finding: compiler options read once from tsconfig/jsconfig, and
 * parsed source files cached by mtime. One instance per adapter discovery source.
 *
 * ```ts
 * const project = new SchemaProject(root);
 * const sf = project.sourceFile(ts, file);
 * const schemas = project.findSchemas(ts, handlerNode, sf, deps);
 * ```
 */
export class SchemaProject {
  private compiler: { options: any; host: any } | null = null;
  private sfCache = new Map<string, { mtimeMs: number; sf: any }>();

  constructor(
    readonly root: string,
    private readonly options: SchemaProjectOptions = {},
  ) {}

  /**
   * Every `<schema>.parse(<input>)` (and safeParse, parseAsync, …) under `fn`, at most one per target:
   * the input's text says which (`.json()` / `req.body` → body, `.formData()` → form, `searchParams` /
   * `query` → query, `params` → params), following local variables up to three hops.
   */
  findSchemas(ts: any, fn: any, sf: any, deps: Set<string>): SchemaInfo[] {
    const found: SchemaInfo[] = [];
    const varInit = new Map<string, string>();
    const visitVars = (n: any) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const text = n.initializer.getText(sf);
        if (ts.isIdentifier(n.name)) varInit.set(n.name.text, text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isIdentifier(el.name)) varInit.set(el.name.text, text);
        }
      }
      ts.forEachChild(n, visitVars);
    };
    try {
      visitVars(fn);
    } catch {
      // Pathological ASTs can overflow the recursive visitor; local var tracking just degrades.
    }
    const bodyPattern = this.options.bodyPattern;
    const classify = (text: string, hops = 0): SchemaInfo["target"] | null => {
      if (bodyPattern?.test(text)) return "body";
      if (/\.json\s*\(|\breq\.body\b|\brequest\.body\b/.test(text)) return "body";
      if (/\.formData\s*\(/.test(text)) return "form";
      if (/searchParams|\bquery\b/.test(text)) return "query";
      if (/\bparams\b/.test(text)) return "params";
      if (hops < 3) {
        for (const id of text.match(/[A-Za-z_$][\w$]*/g) ?? []) {
          const init = varInit.get(id);
          if (init) {
            const c = classify(init, hops + 1);
            if (c) return c;
          }
        }
      }
      return null;
    };
    const resolver = this.resolver(ts, deps);
    const visit = (n: any) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        PARSE_METHODS.has(n.expression.name.text) &&
        n.arguments.length
      ) {
        const target = classify(n.arguments[0].getText(sf));
        if (target && !found.some((f) => f.target === target)) {
          const info = this.schemaInfo(n.expression.expression, sf, target, resolver, true);
          if (info) found.push(info);
        }
      }
      ts.forEachChild(n, visit);
    };
    try {
      visit(fn);
    } catch {
      // Pathological ASTs (e.g. extreme assignment chains) can overflow the recursive visitor.
      // Scanner must still succeed; the route just gets no detected schemas.
    }
    return found;
  }

  /**
   * The SchemaInfo for a schema expression (`OrderBody`, `schemas.Order`, `z.object({…})`). `lenient`
   * accepts an expression that resolves to nothing known (it is a schema because `.parse` was called
   * on it; the shape is then an empty object); otherwise only a recognised Zod shape counts.
   */
  schemaInfo(
    schemaExpr: any,
    sf: any,
    target: SchemaInfo["target"],
    resolver: ProjectResolver,
    lenient = false,
  ): SchemaInfo | null {
    const ts = resolver.ts;
    // A name bound inside the enclosing functions shadows the file's top level: a parameter
    // (`function crud(r, p, schema)`) can't be read statically, a local const is read from its
    // initializer, never from a same-named import.
    const head = leftmostIdentifier(ts, schemaExpr);
    const local = head ? localBinding(ts, head) : null;
    if (local === "opaque") return null;
    if (local && head !== schemaExpr) return null;
    const scoped = local ? scopedResolver(ts, resolver, schemaExpr, sf) : resolver;
    let shape = local ? interpretSchema(local, sf, scoped) : interpretSchema(schemaExpr, sf, scoped);
    if (local) shape = { ...shape, ref: schemaExpr.text };
    if (lenient ? shape.t === "any" && !shape.ref : shape.t === "any") return null;
    const hit = local
      ? { node: local, sf }
      : ts.isIdentifier(schemaExpr)
        ? resolver.resolve(schemaExpr.text, sf)
        : null;
    const name = ts.isIdentifier(schemaExpr)
      ? schemaExpr.text
      : ts.isPropertyAccessExpression(schemaExpr)
        ? schemaExpr.getText(sf)
        : undefined;
    const where = hit ?? { sf, node: schemaExpr };
    if (shape.t === "any") shape = { t: "object", props: {} };
    return {
      target,
      name,
      file: rel(this.root, where.sf.fileName),
      line: where.sf.getLineAndCharacterOfPosition(where.node.getStart(where.sf)).line + 1,
      shape,
      example: exampleOf(shape),
      fields: fieldsOf(shape),
    };
  }

  /** A resolver over this project's files; every file it reads is added to `deps`. */
  resolver(ts: any, deps: Set<string>): ProjectResolver {
    const cjs = !!this.options.commonjs;
    const findInFile = (name: string, sf: any, depth: number): Hit | null => {
      if (depth > 6) return null;
      for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
              if (cjs) {
                const req = requireOf(d.initializer);
                if (req !== null) {
                  const target = this.loadModule(ts, req, sf.fileName, deps);
                  const hit = target && findExport("default", target, depth + 1);
                  if (hit) return hit;
                }
              }
              return { node: d.initializer, sf, name };
            }
            if (cjs && ts.isObjectBindingPattern(d.name) && d.initializer) {
              const req = requireOf(d.initializer);
              if (req === null) continue;
              for (const el of d.name.elements) {
                if (!ts.isIdentifier(el.name) || el.name.text !== name || el.dotDotDotToken) continue;
                const key = el.propertyName ? propText(el.propertyName) : name;
                const target = key !== undefined ? this.loadModule(ts, req, sf.fileName, deps) : null;
                if (target && key !== undefined) return findExport(key, target, depth + 1);
              }
            }
          }
        } else if (
          (ts.isEnumDeclaration(st) || ts.isFunctionDeclaration(st) || (cjs && ts.isClassDeclaration(st))) &&
          st.name?.text === name
        ) {
          return { node: st, sf, name };
        }
      }
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause) continue;
        const spec = st.moduleSpecifier.text;
        const nb = st.importClause.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.name.text !== name) continue;
            const target = this.loadModule(ts, spec, sf.fileName, deps);
            if (target) return findExport((el.propertyName ?? el.name).text, target, depth + 1);
          }
        }
        if (st.importClause.name?.text === name) {
          const target = this.loadModule(ts, spec, sf.fileName, deps);
          if (target) return findExport("default", target, depth + 1);
        }
      }
      return null;
    };
    const requireOf = (n: any): string | null => {
      if (
        n &&
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "require" &&
        n.arguments.length === 1 &&
        ts.isStringLiteralLike(n.arguments[0])
      )
        return n.arguments[0].text;
      return null;
    };
    const findExport = (name: string, sf: any, depth: number): Hit | null => {
      if (depth > 6) return null;
      for (const st of sf.statements) {
        if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            if (el.name.text !== name) continue;
            const local = (el.propertyName ?? el.name).text;
            if (st.moduleSpecifier) {
              const target = this.loadModule(ts, st.moduleSpecifier.text, sf.fileName, deps);
              if (target) return findExport(local, target, depth + 1);
            } else return findInFile(local, sf, depth + 1);
          }
        }
        if (ts.isExportAssignment(st) && name === "default") {
          return ts.isIdentifier(st.expression)
            ? findInFile(st.expression.text, sf, depth + 1)
            : { node: st.expression, sf, name };
        }
        if (
          this.options.defaultDeclarations &&
          name === "default" &&
          (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
          st.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword)
        ) {
          return { node: st, sf, name };
        }
      }
      if (cjs) {
        const hit = findCommonJsExport(name, sf, depth);
        if (hit) return hit;
      }
      const local = findInFile(name, sf, depth);
      if (local) return local;
      for (const st of sf.statements) {
        if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier) {
          const target = this.loadModule(ts, st.moduleSpecifier.text, sf.fileName, deps);
          const hit = target && findExport(name, target, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    /** `module.exports = X` ("default"), `module.exports = { A, B: x }`, `exports.A = x`, `module.exports.A = x`. */
    const findCommonJsExport = (name: string, sf: any, depth: number): Hit | null => {
      for (const st of sf.statements) {
        if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) continue;
        const { left, right, operatorToken } = st.expression;
        if (operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left)) continue;
        const lhs = left.getText(sf);
        if (lhs === "module.exports") {
          // module.exports = require("./schemas"): a re-export barrel.
          const req = requireOf(right);
          if (req !== null) {
            const target = this.loadModule(ts, req, sf.fileName, deps);
            return target ? findExport(name, target, depth + 1) : null;
          }
          if (name === "default") {
            return ts.isIdentifier(right) ? (findInFile(right.text, sf, depth + 1) ?? null) : { node: right, sf, name };
          }
          const obj = ts.isIdentifier(right) ? findInFile(right.text, sf, depth + 1) : { node: right, sf, name };
          if (obj && ts.isObjectLiteralExpression(obj.node)) {
            const p = objectMember(ts, obj.node, name);
            if (p) return ts.isIdentifier(p) ? findInFile(p.text, obj.sf, depth + 1) : { node: p, sf: obj.sf, name };
            // module.exports = { ...require("./schemas") }
            for (const el of obj.node.properties) {
              if (!ts.isSpreadAssignment(el)) continue;
              const spec = requireOf(el.expression);
              const target = spec !== null ? this.loadModule(ts, spec, obj.sf.fileName, deps) : null;
              const hit = target && findExport(name, target, depth + 1);
              if (hit) return hit;
            }
          }
        } else if (lhs === `exports.${name}` || lhs === `module.exports.${name}`) {
          return ts.isIdentifier(right) ? findInFile(right.text, sf, depth + 1) : { node: right, sf, name };
        }
      }
      return null;
    };
    return {
      ts,
      resolve: (name, sf) => findInFile(name, sf, 0),
      resolveExport: (name, sf) => findExport(name, sf, 0),
      resolveMember: (ns, member, sf) => {
        for (const st of sf.statements) {
          if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
          const nb = st.importClause.namedBindings;
          if (ts.isNamespaceImport(nb) && nb.name.text === ns) {
            const target = this.loadModule(ts, st.moduleSpecifier.text, sf.fileName, deps);
            if (target) return findExport(member, target, 0);
          }
        }
        if (cjs) {
          // const ns = require("./m"); ns.member
          for (const st of sf.statements) {
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) {
              if (!ts.isIdentifier(d.name) || d.name.text !== ns) continue;
              const req = requireOf(d.initializer);
              const target = req !== null ? this.loadModule(ts, req, sf.fileName, deps) : null;
              if (target) return findExport(member, target, 0);
            }
          }
        }
        return null;
      },
    };
  }

  /** The project source file `spec` resolves to from `fromFile`; null for zod, node_modules, .d.ts. */
  loadModule(ts: any, spec: string, fromFile: string, deps: Set<string>): any | null {
    if (spec === "zod" || spec.startsWith("zod/")) return null;
    const resolved = this.resolveModule(ts, spec, fromFile);
    if (!resolved || resolved.includes(`${path.sep}node_modules${path.sep}`)) return null;
    deps.add(resolved);
    return this.sourceFile(ts, resolved);
  }

  resolveModule(ts: any, spec: string, fromFile: string): string | null {
    if (!this.compiler) {
      let options: any = {
        moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeNext,
        allowJs: true,
      };
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const p = path.join(this.root, name);
        if (!fs.existsSync(p)) continue;
        const cfg = ts.readConfigFile(p, ts.sys.readFile);
        if (cfg.config) {
          const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, this.root);
          options = { ...parsed.options, allowJs: true };
        }
        break;
      }
      this.compiler = { options, host: ts.sys };
    }
    const r = ts.resolveModuleName(spec, fromFile, this.compiler.options, this.compiler.host);
    const file = r.resolvedModule?.resolvedFileName;
    if (!file || file.endsWith(".d.ts")) return null;
    return file;
  }

  /** The parsed source file, re-parsed only when its mtime moves. Null when it is gone; a read error throws. */
  sourceFile(ts: any, file: string): any | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const hit = this.sfCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.sf;
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(ts, file),
    );
    this.sfCache.set(file, { mtimeMs: stat.mtimeMs, sf });
    return sf;
  }
}

/** `a` of `a`, `a.b.c`; null for anything else (`z.object(...)`, `this.x`). */
function leftmostIdentifier(ts: any, n: any): any | null {
  while (n && ts.isPropertyAccessExpression(n)) n = n.expression;
  return n && ts.isIdentifier(n) ? n : null;
}

/**
 * What `id` is bound to inside its enclosing functions and blocks (the file's top level is the
 * resolver's job): a local `const X = init` gives `init`; a parameter, a destructured or
 * initializer-less local, a catch or loop variable, or a local function or class gives "opaque";
 * not bound below the top level gives null.
 */
export function localBinding(ts: any, id: any): any | "opaque" | null {
  const name = id.text;
  const binds = (b: any): boolean => {
    if (!b) return false;
    if (ts.isIdentifier(b)) return b.text === name;
    if (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b))
      return b.elements.some((e: any) => !ts.isOmittedExpression(e) && binds(e.name));
    return false;
  };
  const inList = (list: any): any | "opaque" | null => {
    for (const d of list?.declarations ?? []) {
      if (!binds(d.name)) continue;
      return ts.isIdentifier(d.name) && d.initializer ? d.initializer : "opaque";
    }
    return null;
  };
  for (let n = id.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (
      ts.isFunctionLike(n) &&
      (n.parameters?.some((p: any) => binds(p.name)) || (ts.isFunctionExpression(n) && n.name?.text === name))
    )
      return "opaque";
    if (ts.isCatchClause(n) && binds(n.variableDeclaration?.name)) return "opaque";
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer) {
      if (ts.isVariableDeclarationList(n.initializer) && inList(n.initializer) !== null) return "opaque";
    }
    if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) || ts.isModuleBlock(n)) {
      for (const st of n.statements) {
        if (ts.isVariableStatement(st)) {
          const hit = inList(st.declarationList);
          if (hit !== null) return hit;
        } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) {
          return "opaque";
        }
      }
    }
  }
  return null;
}

/**
 * A resolver that sees the locals in scope at `at` (in `sf`) before the file's top level, for the
 * names inside a local schema's initializer (`const Body = Base.extend(...)` with a local `Base`).
 */
function scopedResolver(ts: any, base: ProjectResolver, at: any, sf: any): ProjectResolver {
  return {
    ...base,
    resolve: (name, file) => {
      if (file === sf) {
        const local = localBinding(ts, { text: name, parent: at.parent });
        if (local && local !== "opaque") return { node: local, sf, name };
      }
      return base.resolve(name, file);
    },
  };
}

/** The value node of `key` in an object literal: a property, a shorthand (its identifier) or a method. */
export function objectMember(ts: any, obj: any, key: string): any | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propText(p.name) === key) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
    if (ts.isMethodDeclaration(p) && propText(p.name) === key) return p;
  }
  return null;
}

function propText(n: any): string | undefined {
  return n && typeof n.text === "string" ? n.text : undefined;
}

/** Flattened field list of an object shape (nested objects as `a.b`, array items as `a[].b`). */
export function fieldsOf(shape: Shape, prefix = "", out: SchemaInfo["fields"] = [], depth = 0): SchemaInfo["fields"] {
  if (depth > 6) return out;
  if (shape.t === "object") {
    for (const [k, v] of Object.entries(shape.props)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push({ path: p, type: describeShape(v), optional: !!v.optional || !!v.hasDefault });
      if (v.t === "object") fieldsOf(v, p, out, depth + 1);
      if (v.t === "array" && v.item.t === "object") fieldsOf(v.item, `${p}[]`, out, depth + 1);
    }
  }
  return out;
}

export function scriptKind(ts: any, file: string) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(c|m)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function rel(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/");
}
