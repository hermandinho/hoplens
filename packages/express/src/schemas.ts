// Zod schemas for the route list: the request builder prefills a route's body (and query) from them.
// Static only: the registration file a route's call site points at (file:line from routes.ts) is
// parsed with TypeScript, never run. From the app.METHOD / router.METHOD / route().METHOD call on that
// line, two sources, in this order:
//
//  1. handlers: `<schema>.parse(req.body)` (safeParse, parseAsync, …; also req.query, req.params) in
//     an inline handler, or in one referenced by name: same file, imported (ESM or CommonJS), a
//     namespace or object member (`ctrl.create`), a class method (`new Ctrl()`'s `ctrl.create`, a
//     static `Ctrl.make`, `ctrl.create.bind(ctrl)`), or wrapped (`asyncHandler(create)`).
//  2. validation middleware in the argument list: a call whose single argument is a Zod object
//     schema (`validate(Schema)`, `validateBody(Schema)`; a callee name with the word "query" /
//     "param(s)" / "form" targets that part, else the body; an enum or a string is no request part), a call with a part name and a schema (`zValidator("json",
//     Schema)`, `validate(Schema, "query")`), or a call with `{ body, query, params }` schemas (`validate({ body: Schema })`). Also
//     through a name (`const check = validate(Schema)`). Validators of other libraries (celebrate/Joi)
//     are not Zod, so they are not read.
//
// At most one schema per target, handlers first. Results are cached per registration and kept while
// the file and every file the lookup read keep their mtime. Nothing here throws.

import fs from "node:fs";
import path from "node:path";
import type { SchemaInfo } from "@hoplens/core";
import type { ProjectResolver, SchemaProject } from "@hoplens/schema";

/** Router methods a registration call can use (Node's list is longer; these are the ones apps write). */
const ROUTE_CALLS = new Set(["get", "post", "put", "patch", "delete", "del", "head", "options", "all"]);
/** Reference hops followed from a registration argument to a handler. */
const MAX_HOPS = 4;
/** Registrations remembered. */
const MAX_CACHE = 4096;

type Target = SchemaInfo["target"];

interface Entry {
  sig: string;
  schemas: SchemaInfo[];
  /** Files other than the registration file the lookup read. */
  deps: string[];
}

export class SchemaLinker {
  private ts: any | null | undefined;
  private schema: typeof import("@hoplens/schema") | undefined;
  private project: SchemaProject | undefined;
  private cache = new Map<string, Entry>();

  constructor(private readonly root: string) {}

  /**
   * The schemas of the `method` registration at `file:line` (project-relative). Empty when the file
   * can't be read or parsed, TypeScript can't be loaded, or nothing matches.
   */
  link(file: string, line: number, method: string): SchemaInfo[] {
    try {
      if (!file || !line) return [];
      const abs = path.resolve(this.root, file);
      const key = `${abs}\n${line}\n${method}`;
      const hit = this.cache.get(key);
      if (hit && hit.sig === signature(abs, hit.deps)) return hit.schemas;
      if (!this.load()) return [];
      const deps = new Set<string>();
      let schemas: SchemaInfo[] = [];
      try {
        schemas = this.find(abs, line, method, deps);
      } catch {
        schemas = [];
      }
      const others = [...deps].filter((d) => d !== abs);
      const entry: Entry = { sig: signature(abs, others), schemas, deps: others };
      if (this.cache.size >= MAX_CACHE) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, entry);
      return schemas;
    } catch {
      return [];
    }
  }

  private load(): boolean {
    if (this.ts === undefined) {
      try {
        const { loadTypeScript } = require("@hoplens/transform/ts") as typeof import("@hoplens/transform/ts");
        this.schema = require("@hoplens/schema") as typeof import("@hoplens/schema");
        this.ts = loadTypeScript(this.root);
        if (this.ts) {
          this.project = new this.schema.SchemaProject(this.root, {
            commonjs: true,
            defaultDeclarations: true,
            bodyPattern: /\.body\b/,
          });
        }
      } catch {
        this.ts = null;
      }
    }
    return !!(this.ts && this.project && this.schema);
  }

  private find(abs: string, line: number, method: string, deps: Set<string>): SchemaInfo[] {
    const ts = this.ts;
    const project = this.project!;
    const sf = project.sourceFile(ts, abs);
    if (!sf) return [];
    const call = registrationCall(ts, sf, line, method);
    if (!call) return [];
    const resolver = project.resolver(ts, deps);
    const args = flatArgs(ts, call.arguments);
    const out: SchemaInfo[] = [];
    const add = (list: SchemaInfo[]) => {
      for (const s of list) if (!out.some((o) => o.target === s.target)) out.push(s);
    };
    const seen = new Set<any>();
    for (const arg of args) add(this.handlerSchemas(arg, sf, resolver, deps, seen, 0));
    for (const arg of args) add(this.middlewareSchemas(arg, sf, resolver, 0));
    return out;
  }

  /** Parse calls in `node` (inline), then in the handlers its names point at. */
  private handlerSchemas(
    node: any,
    sf: any,
    r: ProjectResolver,
    deps: Set<string>,
    seen: Set<any>,
    hops: number,
  ): SchemaInfo[] {
    const ts = this.ts;
    node = unwrap(ts, node);
    if (!node || hops > MAX_HOPS || seen.has(node)) return [];
    seen.add(node);
    if (isLiteralPath(ts, node)) return [];
    // ctrl.create.bind(ctrl): the bound function is the handler.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "bind"
    )
      return this.handlerSchemas(node.expression.expression, sf, r, deps, seen, hops + 1);
    const out: SchemaInfo[] = [];
    const add = (list: SchemaInfo[]) => {
      for (const s of list) if (!out.some((o) => o.target === s.target)) out.push(s);
    };
    if (isFunctionLike(ts, node) || ts.isCallExpression(node)) add(this.project!.findSchemas(ts, node, sf, deps));
    if (ts.isCallExpression(node)) {
      // A wrapper: asyncHandler(create), wrap(ctrl.create).
      for (const a of node.arguments) {
        const u = unwrap(ts, a);
        if (ts.isIdentifier(u) || ts.isPropertyAccessExpression(u) || ts.isCallExpression(u))
          add(this.handlerSchemas(u, sf, r, deps, seen, hops + 1));
      }
    } else if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const hit = resolveRef(ts, node, sf, r, this.schema!.objectMember);
      if (hit) add(this.handlerSchemas(hit.node, hit.sf, r, deps, seen, hops + 1));
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const e of node.elements) add(this.handlerSchemas(e, sf, r, deps, seen, hops + 1));
    }
    return out;
  }

  /** Schemas a validation middleware call (or a name bound to one) in the argument list gets. */
  private middlewareSchemas(node: any, sf: any, r: ProjectResolver, hops: number): SchemaInfo[] {
    const ts = this.ts;
    const project = this.project!;
    node = unwrap(ts, node);
    if (!node || hops > 2) return [];
    if (ts.isIdentifier(node)) {
      const hit = r.resolve(node.text, sf);
      return hit && ts.isCallExpression(unwrap(ts, hit.node))
        ? this.middlewareSchemas(hit.node, hit.sf, r, hops + 1)
        : [];
    }
    if (!ts.isCallExpression(node)) return [];
    const args = node.arguments;
    const callee = calleeName(ts, node.expression);
    const info = (expr: any, target: Target) => project.schemaInfo(expr, sf, target, r, false);
    const out: SchemaInfo[] = [];
    const push = (s: SchemaInfo | null) => {
      if (s && !out.some((o) => o.target === s.target)) out.push(s);
    };
    if (args.length === 1) {
      const a = unwrap(ts, args[0]);
      if (ts.isObjectLiteralExpression(a)) {
        // validate({ body: Schema, query: Q, params: P })
        for (const [key, target] of PART_KEYS) {
          const v = this.schema!.objectMember(ts, a, key);
          if (v && !ts.isMethodDeclaration(v)) push(info(v, target));
        }
      } else if (!isFunctionLike(ts, a)) {
        // Only an object-like schema is a request part: `requireRole(Role)` with a z.enum is not.
        const s = info(a, targetOfName(callee));
        if (s && isObjectLike(s.shape)) push(s);
      }
    } else if (args.length === 2) {
      // zValidator("json", Schema) or validate(Schema, "query")
      const [a, b] = [unwrap(ts, args[0]), unwrap(ts, args[1])];
      const [part, schema] = ts.isStringLiteralLike(a) ? [a, b] : ts.isStringLiteralLike(b) ? [b, a] : [null, null];
      const target = part && PART_NAMES.get(part.text.toLowerCase());
      if (target) push(info(schema, target));
    }
    return out;
  }
}

const PART_KEYS: Array<[string, Target]> = [
  ["body", "body"],
  ["query", "query"],
  ["params", "params"],
];

const PART_NAMES = new Map<string, Target>([
  ["json", "body"],
  ["body", "body"],
  ["form", "form"],
  ["query", "query"],
  ["param", "params"],
  ["params", "params"],
]);

/**
 * A validator's target from the words of its name (camelCase, snake_case): validateQuery → query,
 * validateParams → params, parseForm → form, else body. Whole words, so `transformBody` and
 * `formatOutput` are not "form".
 */
export function targetOfName(name: string): Target {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (words.some((w) => w === "query" || w === "queries")) return "query";
  if (words.some((w) => w === "param" || w === "params")) return "params";
  if (words.includes("form")) return "form";
  return "body";
}

/** An object schema, or a record / union of them: what a body, query or params can be. */
function isObjectLike(shape: SchemaInfo["shape"]): boolean {
  const s = shape as any;
  if (s.t === "object" || s.t === "record") return true;
  if (s.t === "union") return s.options.length > 0 && s.options.every(isObjectLike);
  return false;
}

function calleeName(ts: any, e: any): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

/**
 * The router call that registered `method` on `line`: a `.get(` / `.post(` / … whose method name is
 * on that line (where V8 puts the call site), preferring the method itself; else one that starts there.
 */
export function registrationCall(ts: any, sf: any, line: number, method: string): any | null {
  const want = method.toLowerCase();
  const names = want === "any" ? ["all"] : want === "head" ? ["head", "get", "all"] : [want, "all"];
  let best: any = null;
  let bestRank = 0;
  for (const c of routeCalls(ts, sf).get(line) ?? []) {
    const idx = names.indexOf(c.name);
    let rank = 0;
    if (c.nameLine === line) rank = idx >= 0 ? 4 - idx / 10 : 2;
    else if (c.startLine === line) rank = idx >= 0 ? 1.5 : 1;
    if (rank > bestRank) {
      best = c.node;
      bestRank = rank;
    }
  }
  return best;
}

interface RouteCall {
  node: any;
  name: string;
  /** Line of the method name (`.post`), where V8 puts the call site. */
  nameLine: number;
  startLine: number;
}

/**
 * Every `.get(` / `.post(` / ... call of a parsed file, by the lines it can be found from (its
 * method name's and its start's), in source order. Built once per SourceFile (a new mtime is a new
 * SourceFile), so a file with N registrations is walked once, not N times.
 */
const callIndex = new WeakMap<object, Map<number, RouteCall[]>>();

function routeCalls(ts: any, sf: any): Map<number, RouteCall[]> {
  const cached = callIndex.get(sf);
  if (cached) return cached;
  const index = new Map<number, RouteCall[]>();
  const lineOf = (n: any) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (l: number, c: RouteCall) => {
    const list = index.get(l);
    if (list) list.push(c);
    else index.set(l, [c]);
  };
  const visit = (n: any) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text;
      if (ROUTE_CALLS.has(name)) {
        const c: RouteCall = { node: n, name, nameLine: lineOf(n.expression.name), startLine: lineOf(n) };
        add(c.nameLine, c);
        if (c.startLine !== c.nameLine) add(c.startLine, c);
      }
    }
    ts.forEachChild(n, visit);
  };
  try {
    visit(sf);
  } catch {
    // A pathological AST overflowed the visitor: keep what was indexed.
  }
  callIndex.set(sf, index);
  return index;
}

/** The registration arguments, array literals flattened (Express accepts nested handler arrays). */
function flatArgs(ts: any, args: readonly any[], depth = 0): any[] {
  const out: any[] = [];
  for (const a of args) {
    let u = unwrap(ts, a);
    // app.post("/x", ...[validate(S), h])
    if (u && ts.isSpreadElement(u)) {
      const inner = unwrap(ts, u.expression);
      if (!inner || !ts.isArrayLiteralExpression(inner)) continue;
      u = inner;
    }
    if (u && ts.isArrayLiteralExpression(u) && depth < 4) out.push(...flatArgs(ts, u.elements, depth + 1));
    else out.push(a);
  }
  return out;
}

/**
 * What a handler name points at: a local, an import, `ns.member` of a namespace import or require,
 * `obj.member` / `a.b.member` of object literals, a method of a class instance (`ctrl.create` with
 * `const ctrl = new Ctrl()`) or a static method (`Ctrl.make`).
 */
function resolveRef(
  ts: any,
  node: any,
  sf: any,
  r: ProjectResolver,
  objectMember: (ts: any, obj: any, key: string) => any,
  depth = 0,
): { node: any; sf: any } | null {
  node = unwrap(ts, node);
  if (depth > 4) return null;
  if (ts.isIdentifier(node)) return r.resolve(node.text, sf);
  if (!ts.isPropertyAccessExpression(node)) return null;
  const member = node.name.text;
  if (ts.isIdentifier(node.expression)) {
    const viaNs = r.resolveMember(node.expression.text, member, sf);
    if (viaNs) return viaNs;
  }
  const obj = resolveRef(ts, node.expression, sf, r, objectMember, depth + 1);
  const lit = obj && unwrap(ts, obj.node);
  if (!obj || !lit) return null;
  if (ts.isClassDeclaration(lit) || ts.isClassExpression(lit)) return classMember(ts, lit, member, true, obj.sf);
  if (ts.isNewExpression(lit)) {
    const cls = resolveRef(ts, lit.expression, obj.sf, r, objectMember, depth + 1);
    const c = cls && unwrap(ts, cls.node);
    return cls && c && (ts.isClassDeclaration(c) || ts.isClassExpression(c))
      ? classMember(ts, c, member, false, cls.sf)
      : null;
  }
  if (!ts.isObjectLiteralExpression(lit)) return null;
  const v = objectMember(ts, lit, member);
  if (!v) return null;
  if (ts.isIdentifier(v)) return r.resolve(v.text, obj.sf) ?? null;
  return { node: v, sf: obj.sf };
}

/** A class's method or function-valued field named `name` (static or instance; base classes are not followed). */
function classMember(ts: any, cls: any, name: string, isStatic: boolean, sf: any): { node: any; sf: any } | null {
  for (const m of cls.members) {
    if (m.name?.text !== name) continue;
    const st = !!m.modifiers?.some((x: any) => x.kind === ts.SyntaxKind.StaticKeyword);
    if (st !== isStatic) continue;
    if (ts.isMethodDeclaration(m)) return { node: m, sf };
    if (ts.isPropertyDeclaration(m) && m.initializer) return { node: m.initializer, sf };
  }
  return null;
}

function isFunctionLike(ts: any, n: any): boolean {
  return (
    !!n &&
    (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))
  );
}

function isLiteralPath(ts: any, n: any): boolean {
  return ts.isStringLiteralLike(n) || ts.isRegularExpressionLiteral(n) || ts.isTemplateExpression(n);
}

function unwrap(ts: any, n: any): any {
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isSatisfiesExpression?.(n) ||
      ts.isTypeAssertionExpression?.(n))
  )
    n = n.expression;
  return n;
}

function signature(abs: string, deps: string[]): string {
  return [mtime(abs), ...deps.map(mtime)].join("|");
}

function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
