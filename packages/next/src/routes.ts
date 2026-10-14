import fs from "node:fs";
import path from "node:path";
import { loadTypeScript } from "@hoplens/transform/ts";
import {
  describeShape,
  exampleOf,
  interpretSchema,
  type Resolver,
  type Shape,
} from "@hoplens/schema";
import type { Discovery, DiscoverySource, MethodInfo, ProxyInfo, RouteInfo, SchemaInfo } from "@hoplens/core";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const ROUTE_FILE = /^route\.(ts|js|mjs|tsx|jsx)$/;
const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cts", ".cjs"];

/**
 * Walks the Next.js project for App Router + Pages Router API routes and the proxy file, and
 * reads Zod schemas with the TypeScript compiler API. Framework code is never executed.
 *
 * ```ts
 * const src = new NextDiscoverySource(process.cwd(), "");
 * for (const r of src.scan().routes) console.log(r.path, r.methods.map((m) => m.method));
 * ```
 */
export class NextDiscoverySource implements DiscoverySource {
  private cache = new Map<string, { sig: string; route: RouteInfo & { __deps?: string[] } }>();
  private compiler: { options: any; host: any } | null = null;
  private sfCache = new Map<string, { mtimeMs: number; sf: any }>();

  constructor(
    private readonly root: string,
    private readonly basePath: string,
  ) {}

  scan(): Discovery {
    const ts = loadTypeScript(this.root);
    const routes: RouteInfo[] = [];
    const appDir = ["app", "src/app"].map((d) => path.join(this.root, d)).find(isDir);
    const pagesDir = ["pages", "src/pages"].map((d) => path.join(this.root, d)).find(isDir);
    if (appDir) {
      for (const file of walk(appDir)) {
        if (!ROUTE_FILE.test(path.basename(file))) continue;
        const r = this.analyze(file, "app", appDir, ts);
        if (r) routes.push(r);
      }
    }
    if (pagesDir && isDir(path.join(pagesDir, "api"))) {
      for (const file of walk(path.join(pagesDir, "api"))) {
        if (!SOURCE_EXT.includes(path.extname(file)) || file.endsWith(".d.ts")) continue;
        const r = this.analyze(file, "pages", pagesDir, ts);
        if (r) routes.push(r);
      }
    }
    routes.sort((a, b) => a.path.localeCompare(b.path));
    return {
      routes,
      proxy: this.findProxy(ts),
      appDir: appDir ? rel(this.root, appDir) : undefined,
      typescript: !!ts,
      scannedAt: Date.now(),
    };
  }

  private analyze(file: string, router: "app" | "pages", baseDir: string, ts: any): RouteInfo | null {
    let src: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      src = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const cached = this.cache.get(file);
    if (cached && cached.sig === this.signature(file, stat, cached.route)) return cached.route;

    const segments = path
      .relative(baseDir, path.dirname(router === "app" ? file : file.replace(/\.[^.]+$/, "")))
      .split(path.sep)
      .filter(Boolean);
    if (router === "pages" && path.basename(file).replace(/\.[^.]+$/, "") !== "index") {
      segments.push(path.basename(file).replace(/\.[^.]+$/, ""));
    }
    if (router === "pages" && segments[segments.length - 1] === "index") segments.pop();
    if (segments.some((s) => s.startsWith("_") && !s.startsWith("__"))) return null;
    const params: RouteInfo["params"] = [];
    const visible: string[] = [];
    const pattern: string[] = [];
    for (const seg of segments) {
      if (/^\(.*\)$/.test(seg) || seg.startsWith("@")) continue;
      visible.push(seg);
      const opt = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
      const all = seg.match(/^\[\.\.\.(.+)\]$/);
      const one = seg.match(/^\[(.+)\]$/);
      if (opt) {
        params.push({ name: opt[1]!, catchAll: true, optional: true });
        pattern.push(`:${opt[1]}*`);
      } else if (all) {
        params.push({ name: all[1]!, catchAll: true, optional: false });
        pattern.push(`:${all[1]}+`);
      } else if (one) {
        params.push({ name: one[1]!, catchAll: false, optional: false });
        pattern.push(`:${one[1]}`);
      } else {
        pattern.push(seg);
      }
    }
    const routePath = this.basePath + "/" + pattern.join("/");
    const nextRoute = "/" + visible.join("/");
    const deps = new Set<string>();
    let methods: MethodInfo[];
    try {
      methods = ts ? this.methodsWithTs(ts, file, src, router, deps) : this.methodsWithRegex(src, router);
    } catch {
      // Pathological sources can overflow TypeScript's parser; the regex fallback is bounded.
      methods = this.methodsWithRegex(src, router);
    }
    const route: RouteInfo & { __deps?: string[] } = {
      id: rel(this.root, file),
      router,
      path: routePath === this.basePath + "/" ? this.basePath || "/" : routePath,
      nextRoute: nextRoute === "/" ? "/" : nextRoute,
      file: rel(this.root, file),
      params,
      methods,
    };
    route.__deps = Array.from(deps);
    this.cache.set(file, { sig: this.signature(file, stat, route), route });
    return route;
  }

  private signature(file: string, stat: fs.Stats, route: RouteInfo & { __deps?: string[] }): string {
    const deps = route.__deps ?? [];
    return [stat.mtimeMs, ...deps.map((d) => mtime(d))].join("|") + file;
  }

  private methodsWithRegex(src: string, router: "app" | "pages"): MethodInfo[] {
    if (router === "pages") {
      return [{ method: "ANY", line: lineOfIndex(src, src.search(/export\s+default/)), schemas: [], readsBody: true }];
    }
    const out: MethodInfo[] = [];
    for (const m of HTTP_METHODS) {
      const re = new RegExp(
        `export\\s+(?:async\\s+)?(?:function\\s+${m}\\b|const\\s+${m}\\b)|export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`,
      );
      const idx = src.search(re);
      if (idx >= 0) out.push({ method: m, line: lineOfIndex(src, idx), schemas: [], readsBody: m !== "GET" && m !== "HEAD" });
    }
    return out;
  }

  private methodsWithTs(ts: any, file: string, src: string, router: "app" | "pages", deps: Set<string>): MethodInfo[] {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
    const lineOf = (n: any) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const exported = new Map<string, any>();
    const locals = new Map<string, any>();
    const isExported = (n: any) => n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);

    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) {
        locals.set(st.name.text, st);
        if (isExported(st)) exported.set(st.name.text, st);
        if (isExported(st) && st.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword)) exported.set("default", st);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          locals.set(d.name.text, d.initializer ?? d);
          if (isExported(st)) exported.set(d.name.text, d.initializer ?? d);
        }
      } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
            exported.set(el.name.text, { __reexport: local, spec: st.moduleSpecifier.text, node: el });
          } else {
            exported.set(el.name.text, { __alias: local, node: el });
          }
        }
      } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
        exported.set("default", st.expression);
      }
    }
    const fnOf = (n: any): any => {
      if (!n) return null;
      if (n.__alias) return fnOf(locals.get(n.__alias)) ?? n.node;
      if (n.__reexport) {
        const target = this.loadModule(ts, n.spec, sf.fileName, deps);
        if (!target) return n.node;
        for (const st of target.statements) {
          if (ts.isFunctionDeclaration(st) && st.name?.text === n.__reexport) return st;
          if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
              if (ts.isIdentifier(d.name) && d.name.text === n.__reexport) return d.initializer ?? d;
            }
          }
        }
        return n.node;
      }
      return n;
    };

    const names = router === "pages" ? ["default"] : [...HTTP_METHODS];
    const out: MethodInfo[] = [];
    for (const name of names) {
      const raw = exported.get(name);
      if (!raw) continue;
      const fn = fnOf(raw);
      const line = lineOf(fn ?? raw.node ?? raw);
      const schemas = fn ? this.findSchemas(ts, fn, sf, deps) : [];
      const readsBody = fn ? readsRequestBody(ts, fn, sf, router) : false;
      out.push({ method: router === "pages" ? "ANY" : name, line, schemas, readsBody });
    }
    return out;
  }

  private findSchemas(ts: any, fn: any, sf: any, deps: Set<string>): SchemaInfo[] {
    const found: SchemaInfo[] = [];
    const parseMethods = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync", "spa", "decode", "safeDecode"]);
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
    const classify = (text: string, hops = 0): SchemaInfo["target"] | null => {
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
        parseMethods.has(n.expression.name.text) &&
        n.arguments.length
      ) {
        const target = classify(n.arguments[0].getText(sf));
        if (target && !found.some((f) => f.target === target)) {
          const schemaExpr = n.expression.expression;
          let shape = interpretSchema(schemaExpr, sf, resolver);
          if (shape.t !== "any" || shape.ref) {
            const hit = ts.isIdentifier(schemaExpr) ? resolver.resolve(schemaExpr.text, sf) : null;
            const name = ts.isIdentifier(schemaExpr)
              ? schemaExpr.text
              : ts.isPropertyAccessExpression(schemaExpr)
                ? schemaExpr.getText(sf)
                : undefined;
            const where = hit ?? { sf, node: schemaExpr };
            if (shape.t === "any") shape = { t: "object", props: {} };
            found.push({
              target,
              name,
              file: rel(this.root, where.sf.fileName),
              line: where.sf.getLineAndCharacterOfPosition(where.node.getStart(where.sf)).line + 1,
              shape,
              example: exampleOf(shape),
              fields: fieldsOf(shape),
            });
          }
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

  private resolver(ts: any, deps: Set<string>): Resolver {
    const self = this;
    const findInFile = (name: string, sf: any, depth: number): { node: any; sf: any; name: string } | null => {
      if (depth > 6) return null;
      for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return { node: d.initializer, sf, name };
          }
        } else if ((ts.isEnumDeclaration(st) || ts.isFunctionDeclaration(st)) && st.name?.text === name) {
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
            const target = self.loadModule(ts, spec, sf.fileName, deps);
            if (target) return findExport((el.propertyName ?? el.name).text, target, depth + 1);
          }
        }
        if (st.importClause.name?.text === name) {
          const target = self.loadModule(ts, spec, sf.fileName, deps);
          if (target) return findExport("default", target, depth + 1);
        }
      }
      return null;
    };
    const findExport = (name: string, sf: any, depth: number): { node: any; sf: any; name: string } | null => {
      if (depth > 6) return null;
      for (const st of sf.statements) {
        if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            if (el.name.text !== name) continue;
            const local = (el.propertyName ?? el.name).text;
            if (st.moduleSpecifier) {
              const target = self.loadModule(ts, st.moduleSpecifier.text, sf.fileName, deps);
              if (target) return findExport(local, target, depth + 1);
            } else return findInFile(local, sf, depth + 1);
          }
        }
        if (ts.isExportAssignment(st) && name === "default") {
          return ts.isIdentifier(st.expression) ? findInFile(st.expression.text, sf, depth + 1) : { node: st.expression, sf, name };
        }
      }
      const local = findInFile(name, sf, depth);
      if (local) return local;
      for (const st of sf.statements) {
        if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier) {
          const target = self.loadModule(ts, st.moduleSpecifier.text, sf.fileName, deps);
          const hit = target && findExport(name, target, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    return {
      ts,
      resolve: (name, sf) => findInFile(name, sf, 0),
      resolveMember: (ns, member, sf) => {
        for (const st of sf.statements) {
          if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
          const nb = st.importClause.namedBindings;
          if (ts.isNamespaceImport(nb) && nb.name.text === ns) {
            const target = self.loadModule(ts, st.moduleSpecifier.text, sf.fileName, deps);
            if (target) return findExport(member, target, 0);
          }
        }
        return null;
      },
    };
  }

  private loadModule(ts: any, spec: string, fromFile: string, deps: Set<string>): any | null {
    if (spec === "zod" || spec.startsWith("zod/")) return null;
    const resolved = this.resolveModule(ts, spec, fromFile);
    if (!resolved || resolved.includes(`${path.sep}node_modules${path.sep}`)) return null;
    deps.add(resolved);
    return this.sourceFile(ts, resolved);
  }

  private resolveModule(ts: any, spec: string, fromFile: string): string | null {
    if (!this.compiler) {
      let options: any = { moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeNext, allowJs: true };
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

  private sourceFile(ts: any, file: string): any | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    const hit = this.sfCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.sf;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, scriptKind(ts, file));
    this.sfCache.set(file, { mtimeMs: stat.mtimeMs, sf });
    return sf;
  }

  private findProxy(ts: any): ProxyInfo | undefined {
    const candidates = ["src/proxy", "proxy", "src/middleware", "middleware"].flatMap((b) =>
      [".ts", ".js", ".mjs"].map((e) => b + e),
    );
    for (const c of candidates) {
      const file = path.join(this.root, c);
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, "utf8");
      let line = lineOfIndex(
        src,
        src.search(/export\s+(default\s+)?(async\s+)?function|export\s+(const|let)\s+(proxy|middleware)\b|export\s+default/),
      );
      const matcher: string[] = [];
      if (ts) {
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
        for (const st of sf.statements) {
          if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
              if (ts.isIdentifier(d.name) && d.name.text === "config" && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
                for (const p of d.initializer.properties) {
                  if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "matcher") {
                    const init = p.initializer;
                    if (ts.isStringLiteral(init)) matcher.push(init.text);
                    else if (ts.isArrayLiteralExpression(init)) {
                      for (const e of init.elements) {
                        if (ts.isStringLiteral(e)) matcher.push(e.text);
                        else if (ts.isObjectLiteralExpression(e)) {
                          const srcProp = e.properties.find((q: any) => q.name?.getText(sf) === "source");
                          if (srcProp && ts.isStringLiteral((srcProp as any).initializer)) matcher.push((srcProp as any).initializer.text);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      if (line < 1) line = 1;
      return { file: c, line, matcher };
    }
    return undefined;
  }
}

/* ------------------------------------------------------------------ helpers */

function readsRequestBody(ts: any, fn: any, sf: any, router: "app" | "pages"): boolean {
  const first = fn.parameters?.[0];
  const text = fn.getText(sf);
  if (!first) return false;
  if (!ts.isIdentifier(first.name)) return /\b(json|formData|text|body)\b/.test(first.name.getText(sf));
  const name = first.name.text.replace(/[$]/g, "\\$");
  if (router === "pages") return new RegExp(`\\b${name}\\.body\\b`).test(text);
  return new RegExp(`\\b${name}\\s*\\.\\s*(json|formData|text|arrayBuffer|blob|body)\\b`).test(text);
}

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

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mtime(p: string) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function rel(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/");
}

function lineOfIndex(src: string, idx: number) {
  if (idx < 0) return 0;
  return src.slice(0, idx).split("\n").length;
}

function scriptKind(ts: any, file: string) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(c|m)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
