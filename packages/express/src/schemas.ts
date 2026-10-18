// Zod schemas for the route list: the request builder prefills a route's body (and query) from them.
// Static only: the registration file a route's call site points at (file:line from routes.ts) is
// parsed with TypeScript, never run. From the app.METHOD / router.METHOD / route().METHOD call on that
// line, two sources, in this order:
//
//  1. handlers: `<schema>.parse(req.body)` (safeParse, parseAsync, …; also req.query, req.params) in
//     an inline handler, or in one referenced by name: same file, imported (ESM or CommonJS), a
//     namespace or object member (`ctrl.create`), a class method (`new Ctrl()`'s `ctrl.create`, a
//     static `Ctrl.make`, `ctrl.create.bind(ctrl)`), or wrapped (`asyncHandler(create)`). A handler
//     whose body is one call forwarding `req` (`(req, res) => ctrl.create(req, res)`, `await`ed or
//     returned) is followed into the callee, two levels at most.
//  2. validation middleware in the argument list: a call whose single argument is a Zod object
//     schema (`validate(Schema)`, `validateBody(Schema)`; a callee name with the word "query" /
//     "param(s)" / "form" targets that part, else the body; an enum or a string is no request
//     part), a call with a part name and a schema (`zValidator("json", Schema)`,
//     `validate(Schema, "query")`), or a call with `{ body, query, params }` schemas
//     (`validate({ body: Schema })`). Also through a name (`const check = validate(Schema)`).
//     Validators of other libraries (celebrate/Joi) are not Zod, so they are not read.
//
// A registration inside a loop over a literal route table (`for (const r of routes)
// router[r.method](r.path, ...r.middleware, r.handler)`, `routes.forEach(...)`, `Object.entries(map)`)
// is one call site for every route: the table's element is picked by matching the route's own path
// (and method, for `router[r.method]`) against each element's, and the arguments are read from it.
// No unique match, no schema. Nor when the table may differ from its literal at runtime: a `let`
// loop variable, a reassigned callback parameter, a table or element the file changes (`push`,
// `routes[0].handler = x`), or an element key a later spread may set.
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
const MAX_HOPS = 6;
/** Delegating handlers (`(req, res) => h(req, res)`) followed in a row. */
const MAX_DELEGATIONS = 2;
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
   * The schemas of the `method` registration at `file:line` (project-relative). `routePath` is the
   * route's own path as registered (`route.path`), which picks the element of a route table a loop
   * registered. Empty when the file can't be read or parsed, TypeScript can't be loaded, or nothing
   * matches.
   */
  link(file: string, line: number, method: string, routePath?: unknown): SchemaInfo[] {
    try {
      if (!file || !line) return [];
      const abs = path.resolve(this.root, file);
      const key = `${abs}\n${line}\n${method}\n${pathKey(routePath)}`;
      const hit = this.cache.get(key);
      if (hit && hit.sig === signature(abs, hit.deps)) return hit.schemas;
      if (!this.load()) return [];
      const deps = new Set<string>();
      let schemas: SchemaInfo[] = [];
      try {
        schemas = this.find(abs, line, method, routePath, deps);
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
            memberDeclarations: true,
          });
        }
      } catch {
        this.ts = null;
      }
    }
    return !!(this.ts && this.project && this.schema);
  }

  private find(abs: string, line: number, method: string, routePath: unknown, deps: Set<string>): SchemaInfo[] {
    const ts = this.ts;
    const project = this.project!;
    const sf = project.sourceFile(ts, abs);
    if (!sf) return [];
    const call = registrationCall(ts, sf, line, method);
    if (!call) return [];
    const resolver = project.resolver(ts, deps);
    const args = new RouteTable(ts, this.schema!, resolver).args(call, sf, method, routePath);
    if (!args) return [];
    const out: SchemaInfo[] = [];
    const add = (list: SchemaInfo[]) => {
      for (const s of list) if (!out.some((o) => o.target === s.target)) out.push(s);
    };
    const seen = new Set<any>();
    for (const arg of args) add(this.handlerSchemas(arg.node, arg.sf, resolver, deps, seen, 0, 0));
    for (const arg of args) add(this.middlewareSchemas(arg.node, arg.sf, resolver, 0));
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
    delegations: number,
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
      return this.handlerSchemas(node.expression.expression, sf, r, deps, seen, hops + 1, delegations);
    const out: SchemaInfo[] = [];
    const add = (list: SchemaInfo[]) => {
      for (const s of list) if (!out.some((o) => o.target === s.target)) out.push(s);
    };
    if (isFunctionLike(ts, node) || ts.isCallExpression(node)) add(this.project!.findSchemas(ts, node, sf, deps));
    if (isFunctionLike(ts, node)) {
      // (req, res) => ctrl.create(req, res): the callee is the handler.
      const callee = delegateCallee(ts, node, this.schema!.localBinding);
      if (callee && delegations < MAX_DELEGATIONS)
        add(this.handlerSchemas(callee, sf, r, deps, seen, hops + 1, delegations + 1));
    } else if (ts.isCallExpression(node)) {
      // A wrapper: asyncHandler(create), wrap(ctrl.create).
      for (const a of node.arguments) {
        const u = unwrap(ts, a);
        if (ts.isIdentifier(u) || ts.isPropertyAccessExpression(u) || ts.isCallExpression(u))
          add(this.handlerSchemas(u, sf, r, deps, seen, hops + 1, delegations));
      }
    } else if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const hit = resolveRef(ts, node, sf, r, this.schema!);
      if (hit) add(this.handlerSchemas(hit.node, hit.sf, r, deps, seen, hops + 1, delegations));
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const e of node.elements) add(this.handlerSchemas(e, sf, r, deps, seen, hops + 1, delegations));
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
      const hit = resolveName(ts, node, sf, r, this.schema!.localBinding);
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
    // app.del is Express's alias of app.delete.
    const idx = names.indexOf(c.name === "del" ? "delete" : c.name);
    let rank = 0;
    // A computed method (`router[r.method](...)`, DYNAMIC) may be any of them: the route table says.
    if (c.nameLine === line) rank = idx >= 0 ? 4 - idx / 10 : c.name === DYNAMIC ? 3 : 2;
    else if (c.startLine === line) rank = idx >= 0 ? 1.5 : c.name === DYNAMIC ? 1.2 : 1;
    if (rank > bestRank) {
      best = c.node;
      bestRank = rank;
    }
  }
  return best;
}

/** The name of a registration call whose method is computed (`router[r.method](...)`). */
const DYNAMIC = "*";

interface RouteCall {
  node: any;
  /** The method name, or DYNAMIC. */
  name: string;
  /** Line of the method name (`.post`; the `(` after `[...]`), where V8 puts the call site. */
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
    } else if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression) && n.arguments.length) {
      // app["post"](...) or router[r.method](...): V8 reports the `(` after the brackets.
      const key = unwrap(ts, n.expression.argumentExpression);
      const name = key && ts.isStringLiteralLike(key) ? key.text.toLowerCase() : DYNAMIC;
      if (name === DYNAMIC || ROUTE_CALLS.has(name)) {
        const paren = sf.getLineAndCharacterOfPosition(n.arguments.pos - 1).line + 1;
        const c: RouteCall = { node: n, name, nameLine: paren, startLine: lineOf(n) };
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

type SchemaLib = Pick<typeof import("@hoplens/schema"), "objectMember" | "localBinding">;

/**
 * What a name written in `sf` stands for: a function-local const's initializer, else the module's
 * binding (a local, an import). A local whose value is not known (a parameter, a destructuring, a
 * catch variable) is nothing: never a same-named module binding.
 */
function resolveName(
  ts: any,
  id: any,
  sf: any,
  r: ProjectResolver,
  localBinding: SchemaLib["localBinding"],
): { node: any; sf: any } | null {
  const local = id.parent ? localBinding(ts, id) : null;
  if (local === "opaque") return null;
  return local ? { node: local, sf } : r.resolve(id.text, sf);
}

/**
 * What a handler name points at: a local, an import, `ns.member` of a namespace import or require,
 * `obj.member` / `a.b.member` of object literals, a method of a class instance (`ctrl.create` with
 * `const ctrl = new Ctrl()`) or a static method (`Ctrl.make`). Names are read in their scope
 * (resolveName).
 */
function resolveRef(
  ts: any,
  node: any,
  sf: any,
  r: ProjectResolver,
  lib: SchemaLib,
  depth = 0,
): { node: any; sf: any } | null {
  node = unwrap(ts, node);
  if (depth > 4) return null;
  if (ts.isIdentifier(node)) return resolveName(ts, node, sf, r, lib.localBinding);
  if (!ts.isPropertyAccessExpression(node)) return null;
  const member = node.name.text;
  const head = unwrap(ts, node.expression);
  // A namespace import or require, unless a local of the same name shadows it.
  if (ts.isIdentifier(head) && !(head.parent && lib.localBinding(ts, head))) {
    const viaNs = r.resolveMember(head.text, member, sf);
    if (viaNs) return viaNs;
  }
  const obj = resolveRef(ts, node.expression, sf, r, lib, depth + 1);
  const lit = obj && unwrap(ts, obj.node);
  if (!obj || !lit) return null;
  if (ts.isClassDeclaration(lit) || ts.isClassExpression(lit)) return classMember(ts, lit, member, true, obj.sf);
  if (ts.isNewExpression(lit)) {
    const cls = resolveRef(ts, lit.expression, obj.sf, r, lib, depth + 1);
    const c = cls && unwrap(ts, cls.node);
    return cls && c && (ts.isClassDeclaration(c) || ts.isClassExpression(c))
      ? classMember(ts, c, member, false, cls.sf)
      : null;
  }
  if (!ts.isObjectLiteralExpression(lit)) return null;
  const v = lib.objectMember(ts, lit, member);
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

/** The cache-key form of a route's own path. */
function pathKey(p: unknown): string {
  if (typeof p === "string") return p;
  if (p instanceof RegExp) return String(p);
  return "";
}

/**
 * The callee a delegating handler forwards to: a body that is one call (`(req, res) => h(req, res)`,
 * `{ await svc.create(req, res); }`, `{ return h(req, res); }`, also `h(req, res).catch(next)`)
 * passing the handler's first parameter as its first argument. Only a name or member of the module scope: a callee bound
 * in the function (a parameter, a local) or on `this` is not followed.
 */
export function delegateCallee(ts: any, fn: any, localBinding: (ts: any, id: any) => unknown): any | null {
  const first = fn.parameters?.[0];
  if (!first || !ts.isIdentifier(first.name) || !fn.body) return null;
  const req = first.name.text;
  let expr: any = fn.body;
  if (ts.isBlock(expr)) {
    if (expr.statements.length !== 1) return null;
    const st = expr.statements[0];
    expr = ts.isExpressionStatement(st) || ts.isReturnStatement(st) ? st.expression : null;
  }
  for (let i = 0; expr && i < 8; i++) {
    expr = unwrap(ts, expr);
    if (ts.isAwaitExpression(expr) || ts.isVoidExpression(expr)) expr = expr.expression;
    else if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ["then", "catch", "finally"].includes(expr.expression.name.text) &&
      ts.isCallExpression(unwrap(ts, expr.expression.expression))
    )
      expr = expr.expression.expression;
    else break;
  }
  if (!expr || !ts.isCallExpression(expr)) return null;
  // The handler's own request, as the callee's request (its first argument): `h(res, req)` or
  // `h({ ...req, body: x }, res, req)` hands the callee something else to parse.
  const arg0 = unwrap(ts, expr.arguments[0]);
  if (!arg0 || !ts.isIdentifier(arg0) || arg0.text !== req) return null;
  const callee = unwrap(ts, expr.expression);
  if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return null;
  let head = callee;
  while (ts.isPropertyAccessExpression(head)) head = unwrap(ts, head.expression);
  if (!ts.isIdentifier(head) || localBinding(ts, head) !== null) return null;
  return callee;
}

/* ------------------------------------------------------------ route tables */

/** A value read from a route table: a node (in its file), a key of `Object.entries`, or an entry pair. */
type Val = { node: any; sf: any } | { str: string } | { tuple: Array<Val | null> };
/** The loop's bound names and what each is for one element; null: there, but unreadable. */
type Env = Map<string, Val | null>;
/** A registration argument to read, in the file it is written in. */
interface Arg {
  node: any;
  sf: any;
}

interface Loop {
  /** The loop variable's binding (`r`, `{ path, handler }`, `[path, h]`). */
  binding: any;
  /** What is iterated (`routes`, `Object.entries(map)`). */
  collection: any;
}

/** Elements a route table may have. */
const MAX_ELEMENTS = 500;

/**
 * Registration arguments, with a loop over a route table resolved for one route. Static: the table
 * must be an array or object literal (in the file, or a const imported through the resolver).
 */
class RouteTable {
  private names = new Set<string>();

  constructor(
    private readonly ts: any,
    private readonly schema: typeof import("@hoplens/schema"),
    private readonly r: ProjectResolver,
  ) {}

  /**
   * The arguments to read schemas from: the call's own when it does not depend on an enclosing
   * loop's variable; else the ones of the table element whose path (and method) is the route's.
   * Null when the element can't be told apart (no schema rather than another route's).
   */
  args(call: any, sf: any, method: string, routePath: unknown): Arg[] | null {
    const ts = this.ts;
    const key = ts.isElementAccessExpression(call.expression) ? unwrap(ts, call.expression.argumentExpression) : null;
    const dynamic = key && !ts.isStringLiteralLike(key) ? key : null;
    const loop = loopOf(ts, call);
    if (loop) this.names = bindingNames(ts, loop.binding);
    const { pathExpr, handlers } = registrationParts(ts, call);
    const uses = (n: any) => this.names.size > 0 && !!n && references(ts, n, this.names);
    if (!dynamic && !handlers.some(uses)) return flatArgs(ts, call.arguments).map((node) => ({ node, sf }));
    if (!loop || (dynamic && !uses(dynamic))) return null;
    const env = this.pick(loop, sf, uses(pathExpr) ? pathExpr : null, dynamic, method, routePath);
    if (!env) return null;
    const out: Arg[] = [];
    for (const h of handlers) this.push(h, sf, env, out, 0);
    return out;
  }

  /** The bindings of the one element matching the route, else null. */
  private pick(loop: Loop, sf: any, pathExpr: any, methodExpr: any, method: string, routePath: unknown): Env | null {
    const elements = this.elements(loop.collection, sf, 0);
    if (!elements || elements.length > MAX_ELEMENTS) return null;
    let match: Env | null = null;
    let matches = 0;
    let unsure = 0;
    for (const el of elements) {
      const env: Env = new Map();
      this.bind(loop.binding, el, sf, env, 0);
      const checks = [
        pathExpr ? samePath(this.text(this.evaluate(pathExpr, sf, env)), routePath) : true,
        methodExpr ? sameMethod(this.text(this.evaluate(methodExpr, sf, env)), method) : true,
      ];
      if (checks.includes(false)) continue;
      if (checks.includes(null)) unsure++;
      else {
        matches++;
        match = env;
      }
    }
    return matches === 1 && unsure === 0 ? match : null;
  }

  /** Push a registration argument (or the table values it reads) as arguments to read. */
  private push(node: any, sf: any, env: Env | null, out: Arg[], depth: number): void {
    const ts = this.ts;
    const u = unwrap(ts, node);
    if (!u || depth > 4) return;
    if (ts.isSpreadElement(u)) {
      // ...[auth, r.handler]: each element, with the loop variable bound.
      const inner = unwrap(ts, u.expression);
      if (inner && ts.isArrayLiteralExpression(inner)) {
        for (const e of inner.elements) this.push(e, sf, env, out, depth + 1);
        return;
      }
      // ...r.middleware: the element's array.
      const v = env ? this.evaluate(u.expression, sf, env) : "free";
      if (v === null) return;
      const src = v === "free" ? { node: u.expression, sf } : "node" in v ? v : null;
      const arr = src && this.array(src.node, src.sf);
      if (arr) for (const e of arr.node.elements) this.push(e, arr.sf, v === "free" ? env : null, out, depth + 1);
      return;
    }
    if (ts.isArrayLiteralExpression(u)) {
      for (const e of u.elements) this.push(e, sf, env, out, depth + 1);
      return;
    }
    if (env && !isFunctionLike(ts, u)) {
      // r.handler is the element's value; an argument using the loop variable otherwise is unread.
      // (An inline handler is kept: a name it binds locally is never resolved to the module's.)
      const v = this.evaluate(u, sf, env);
      if (v === null) return;
      if (v !== "free") {
        if ("node" in v) this.push(v.node, v.sf, null, out, depth + 1);
        return;
      }
    }
    out.push({ node: u, sf });
  }

  /** An array literal `node` is or names (a const, an import). */
  private array(node: any, sf: any): Arg | null {
    const v = this.declared(node, sf, 0);
    return v && this.ts.isArrayLiteralExpression(v.node) ? v : null;
  }

  /** The elements of a table: an array literal (spreads followed) or `Object.entries/keys/values(obj)`. */
  private elements(expr: any, sf: any, depth: number): Array<Val | null> | null {
    const ts = this.ts;
    if (depth > 4) return null;
    const lit = this.declared(expr, sf, 0);
    if (lit && ts.isArrayLiteralExpression(lit.node)) {
      const out: Array<Val | null> = [];
      for (const e of lit.node.elements) {
        if (ts.isSpreadElement(e)) {
          const more = this.elements(e.expression, lit.sf, depth + 1);
          if (!more) return null;
          out.push(...more);
        } else if (ts.isOmittedExpression(e)) out.push(null);
        else out.push({ node: e, sf: lit.sf });
      }
      return out;
    }
    const u = unwrap(ts, expr);
    if (
      u &&
      ts.isCallExpression(u) &&
      u.arguments.length === 1 &&
      ts.isPropertyAccessExpression(u.expression) &&
      ts.isIdentifier(u.expression.expression) &&
      u.expression.expression.text === "Object"
    ) {
      const kind = u.expression.name.text;
      if (kind !== "entries" && kind !== "keys" && kind !== "values") return null;
      const pairs = this.entries(u.arguments[0], sf, depth + 1);
      if (!pairs) return null;
      return pairs.map(([k, v]) => (kind === "keys" ? k : kind === "values" ? v : { tuple: [k, v] }));
    }
    return null;
  }

  /** The [key, value] pairs of an object literal `expr` is or names, spreads followed. */
  private entries(expr: any, sf: any, depth: number): Array<[Val | null, Val | null]> | null {
    const ts = this.ts;
    if (depth > 4) return null;
    const lit = this.declared(expr, sf, 0);
    if (!lit || !ts.isObjectLiteralExpression(lit.node)) return null;
    const out: Array<[Val | null, Val | null]> = [];
    for (const p of lit.node.properties) {
      if (ts.isSpreadAssignment(p)) {
        const more = this.entries(p.expression, lit.sf, depth + 1);
        if (!more) return null;
        out.push(...more);
        continue;
      }
      const name = p.name && !ts.isComputedPropertyName(p.name) ? p.name.text : undefined;
      const key = typeof name === "string" ? { str: name } : null;
      if (ts.isPropertyAssignment(p)) out.push([key, { node: p.initializer, sf: lit.sf }]);
      else if (ts.isShorthandPropertyAssignment(p)) out.push([key, { node: p.name, sf: lit.sf }]);
      else if (ts.isMethodDeclaration(p)) out.push([key, { node: p, sf: lit.sf }]);
      else out.push([key, null]);
    }
    return out;
  }

  /** Bind a loop variable pattern to one element. */
  private bind(name: any, val: Val | null, sf: any, env: Env, depth: number): void {
    const ts = this.ts;
    if (depth > 4) return;
    if (ts.isIdentifier(name)) {
      env.set(name.text, val);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const key = el.dotDotDotToken
          ? undefined
          : el.propertyName
            ? el.propertyName.text
            : ts.isIdentifier(el.name)
              ? el.name.text
              : undefined;
        let sub = typeof key === "string" ? this.member(val, key) : null;
        // The default only stands in for a key the element does not have; an element that can't be
        // read (a spread, not a literal) may have it.
        if (!sub && el.initializer && !el.dotDotDotToken && typeof key === "string" && this.lacks(val, key))
          sub = { node: el.initializer, sf };
        this.bind(el.name, sub, sf, env, depth + 1);
      }
    } else if (ts.isArrayBindingPattern(name)) {
      name.elements.forEach((el: any, i: number) => {
        if (ts.isOmittedExpression(el)) return;
        let sub = el.dotDotDotToken ? null : this.item(val, i);
        if (!sub && el.initializer && !el.dotDotDotToken && this.lacksItem(val, i)) sub = { node: el.initializer, sf };
        this.bind(el.name, sub, sf, env, depth + 1);
      });
    }
  }

  /**
   * `expr` read with the loop variable bound: "free" when it does not use it, null when it does but
   * can't be read (a call on it, a computed member).
   */
  private evaluate(expr: any, sf: any, env: Env, depth = 0): Val | null | "free" {
    const ts = this.ts;
    const u = unwrap(ts, expr);
    if (!u || depth > 8) return null;
    if (ts.isIdentifier(u)) return env.has(u.text) ? (env.get(u.text) ?? null) : "free";
    if (ts.isPropertyAccessExpression(u)) {
      const base = this.evaluate(u.expression, sf, env, depth + 1);
      return base === "free" ? "free" : this.member(base, u.name.text);
    }
    if (ts.isElementAccessExpression(u)) {
      const base = this.evaluate(u.expression, sf, env, depth + 1);
      if (base === "free") return references(ts, u.argumentExpression, this.names) ? null : "free";
      const k = unwrap(ts, u.argumentExpression);
      if (k && ts.isStringLiteralLike(k)) return this.member(base, k.text);
      if (k && ts.isNumericLiteral(k)) return this.item(base, Number(k.text));
      return null;
    }
    return references(ts, u, this.names) ? null : "free";
  }

  /**
   * Member `key` of the object literal `val` is (or names): its last property of that name, as at
   * runtime. Null when a spread or a computed key after it (or before none) may set it instead.
   */
  private member(val: Val | null, key: string): Val | null {
    const ts = this.ts;
    if (!val || !("node" in val)) return null;
    const lit = this.declared(val.node, val.sf, 0);
    if (!lit || !ts.isObjectLiteralExpression(lit.node)) return null;
    const props = lit.node.properties;
    for (let i = props.length - 1; i >= 0; i--) {
      const p = props[i];
      if (ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) return null;
      if (p.name?.text !== key) continue;
      const v = this.schema.objectMember(ts, { properties: [p] }, key);
      return v ? { node: v, sf: lit.sf } : null;
    }
    return null;
  }

  /** Whether `val` is an object literal (no spreads) without key `key`: a destructuring default applies. */
  private lacks(val: Val | null, key: string): boolean {
    const ts = this.ts;
    if (!val || !("node" in val)) return false;
    const lit = this.declared(val.node, val.sf, 0);
    if (!lit || !ts.isObjectLiteralExpression(lit.node)) return false;
    return lit.node.properties.every(
      (p: any) => !ts.isSpreadAssignment(p) && !(p.name && (ts.isComputedPropertyName(p.name) || p.name.text === key)),
    );
  }

  /** Whether `val` is an array literal (no spreads) shorter than `i + 1`: a destructuring default applies. */
  private lacksItem(val: Val | null, i: number): boolean {
    const ts = this.ts;
    if (!val || !("node" in val)) return false;
    const lit = this.declared(val.node, val.sf, 0);
    if (!lit || !ts.isArrayLiteralExpression(lit.node)) return false;
    return lit.node.elements.length <= i && !lit.node.elements.some((e: any) => ts.isSpreadElement(e));
  }

  /** Item `i` of an entry pair, or of the array literal `val` is (or names) before any spread. */
  private item(val: Val | null, i: number): Val | null {
    const ts = this.ts;
    if (!val) return null;
    if ("tuple" in val) return val.tuple[i] ?? null;
    if (!("node" in val)) return null;
    const lit = this.declared(val.node, val.sf, 0);
    if (!lit || !ts.isArrayLiteralExpression(lit.node)) return null;
    for (let j = 0; j <= i && j < lit.node.elements.length; j++) {
      const e = lit.node.elements[j];
      if (ts.isSpreadElement(e)) return null;
      if (j === i) return ts.isOmittedExpression(e) ? null : { node: e, sf: lit.sf };
    }
    return null;
  }

  /** The literal a name or member stands for (a local const, a module-level const, an import); else the node. */
  private declared(node: any, sf: any, depth: number): Arg | null {
    const ts = this.ts;
    const u = unwrap(ts, node);
    if (!u || depth > 4) return null;
    if (ts.isIdentifier(u)) {
      // A table (or an element, or a part of one) changed after it is declared is not its literal.
      if (mutatedNames(ts, sf).has(u.text)) return null;
      const hit = resolveName(ts, u, sf, this.r, this.schema.localBinding);
      if (!hit) return null;
      const decl = hit.node.parent;
      if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
        if (mutatedNames(ts, hit.sf).has(decl.name.text)) return null;
      }
      return this.declared(hit.node, hit.sf, depth + 1);
    }
    if (ts.isPropertyAccessExpression(u)) {
      const head = chainHead(ts, u);
      if (head && mutatedNames(ts, sf).has(head.text)) return null;
      const hit = resolveRef(ts, u, sf, this.r, this.schema);
      return hit ? this.declared(hit.node, hit.sf, depth + 1) : null;
    }
    return { node: u, sf };
  }

  /** The string (or regex literal text) a value is: a literal, or a const naming one. */
  private text(v: Val | null | "free"): { s: string; regex: boolean } | null {
    const ts = this.ts;
    if (!v || v === "free" || "tuple" in v) return null;
    if ("str" in v) return { s: v.str, regex: false };
    const lit = this.declared(v.node, v.sf, 0);
    if (!lit) return null;
    if (ts.isStringLiteralLike(lit.node)) return { s: lit.node.text, regex: false };
    if (ts.isRegularExpressionLiteral(lit.node)) return { s: lit.node.text, regex: true };
    return null;
  }
}

/** Whether a table element's path is the route's: true, false, or null (can't tell). */
function samePath(p: { s: string; regex: boolean } | null, routePath: unknown): boolean | null {
  if (!p) return null;
  if (typeof routePath === "string") return !p.regex && p.s === routePath;
  if (routePath instanceof RegExp) return p.regex && p.s === String(routePath);
  return null;
}

/** Whether a table element's method name is the route's (`ANY` is `all`). */
function sameMethod(m: { s: string; regex: boolean } | null, method: string): boolean | null {
  if (!m || m.regex) return null;
  const s = m.s.toLowerCase() === "del" ? "delete" : m.s.toLowerCase();
  return s === (method === "ANY" ? "all" : method.toLowerCase());
}

/**
 * The innermost loop over a table the registration call is in: `for (const <binding> of <coll>)`,
 * or a callback of `<coll>.forEach(...)` / `.map(...)`. Another function in between ends the search.
 */
function loopOf(ts: any, call: any): Loop | null {
  for (let child = call, n = call.parent; n && !ts.isSourceFile(n); child = n, n = n.parent) {
    if (ts.isForOfStatement(n)) {
      if (child !== n.statement) return null;
      const init = n.initializer;
      // `const` only: a `let` loop variable may be reassigned before the registration reads it.
      if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return null;
      if (!(init.flags & ts.NodeFlags.Const)) return null;
      return { binding: init.declarations[0].name, collection: n.expression };
    }
    if (ts.isFunctionLike(n)) {
      const p = n.parent;
      if (
        p &&
        ts.isCallExpression(p) &&
        p.arguments[0] === n &&
        ts.isPropertyAccessExpression(p.expression) &&
        (p.expression.name.text === "forEach" || p.expression.name.text === "map") &&
        n.parameters?.length &&
        // A callback parameter reassigned in the body is not the element.
        !assigns(ts, n.body, bindingNames(ts, n.parameters[0].name))
      )
        return { binding: n.parameters[0].name, collection: p.expression.expression };
      return null;
    }
  }
  return null;
}

/** Array methods that change their receiver. */
const MUTATORS = new Set(["push", "unshift", "splice", "pop", "shift", "fill", "copyWithin"]);

/** The identifier a member chain (`a.b[0].c`) starts from, else null. */
function chainHead(ts: any, n: any): any | null {
  let u = unwrap(ts, n);
  for (let i = 0; u && i < 32 && (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)); i++)
    u = unwrap(ts, u.expression);
  return u && ts.isIdentifier(u) ? u : null;
}

function isAssignOp(ts: any, kind: number): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isIncDec(ts: any, n: any): boolean {
  return (
    (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

/** Whether `node` assigns (`=`, `+=`, `++`, a destructuring assignment) one of `names` itself. */
function assigns(ts: any, node: any, names: Set<string>): boolean {
  let found = false;
  const target = (t: any): boolean => {
    const u = unwrap(ts, t);
    if (!u) return false;
    if (ts.isIdentifier(u)) return names.has(u.text);
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.EqualsToken) return target(u.left);
    if (ts.isArrayLiteralExpression(u))
      return u.elements.some((e: any) => target(ts.isSpreadElement(e) ? e.expression : e));
    if (ts.isObjectLiteralExpression(u))
      return u.properties.some((p: any) =>
        ts.isShorthandPropertyAssignment(p)
          ? names.has(p.name.text)
          : ts.isPropertyAssignment(p)
            ? target(p.initializer)
            : ts.isSpreadAssignment(p) && target(p.expression),
      );
    return false;
  };
  const visit = (n: any) => {
    if (found || !n) return;
    if (ts.isBinaryExpression(n) && isAssignOp(ts, n.operatorToken.kind) && target(n.left)) found = true;
    else if (isIncDec(ts, n) && target(n.operand)) found = true;
    else ts.forEachChild(n, visit);
  };
  try {
    visit(node);
  } catch {
    return true;
  }
  return found;
}

/**
 * Names a file changes after declaring them: assigned (`routes = x`, `routes[0].handler = x`,
 * `delete routes[0].h`), or changed through a method or `Object.assign` (`routes.push(x)`,
 * `api.routes.splice(...)`, `Object.assign(routes[0], x)`). By the head of the changed chain, in
 * any scope: a table read under such a name is unread (no schema) rather than stale. Built once per
 * SourceFile.
 */
const mutatedIndex = new WeakMap<object, Set<string>>();

function mutatedNames(ts: any, sf: any): Set<string> {
  const cached = mutatedIndex.get(sf);
  if (cached) return cached;
  const out = new Set<string>();
  const mark = (n: any) => {
    const h = chainHead(ts, n);
    if (h) out.add(h.text);
  };
  const visit = (n: any) => {
    if (ts.isBinaryExpression(n) && isAssignOp(ts, n.operatorToken.kind)) mark(n.left);
    else if (isIncDec(ts, n)) mark(n.operand);
    else if (ts.isDeleteExpression(n)) mark(n.expression);
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text;
      const recv = unwrap(ts, n.expression.expression);
      if (MUTATORS.has(name)) mark(recv);
      else if (
        ts.isIdentifier(recv) &&
        recv.text === "Object" &&
        (name === "assign" || name === "defineProperty" || name === "defineProperties") &&
        n.arguments.length
      )
        mark(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  try {
    visit(sf);
  } catch {
    // A pathological AST overflowed the visitor: keep what was found.
  }
  mutatedIndex.set(sf, out);
  return out;
}

/** The names a binding pattern binds. */
function bindingNames(ts: any, b: any, out = new Set<string>()): Set<string> {
  if (!b) return out;
  if (ts.isIdentifier(b)) out.add(b.text);
  else if (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b))
    for (const e of b.elements) if (!ts.isOmittedExpression(e)) bindingNames(ts, e.name, out);
  return out;
}

/** Whether `node` reads one of `names` (not as a property name). */
function references(ts: any, node: any, names: Set<string>): boolean {
  let found = false;
  const visit = (n: any) => {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      const isName =
        p &&
        ((ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n) ||
          (ts.isMethodDeclaration(p) && p.name === n));
      if (!isName) found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  try {
    visit(node);
  } catch {
    return true;
  }
  return found;
}

/**
 * A registration's path expression and its handler arguments: `app.post(path, ...handlers)`, or for
 * `app.route(path).get(...handlers)` (chained) the path of the `route()` call.
 */
function registrationParts(ts: any, call: any): { pathExpr: any; handlers: any[] } {
  let recv = ts.isPropertyAccessExpression(call.expression) ? unwrap(ts, call.expression.expression) : null;
  for (let i = 0; recv && i < 16; i++) {
    if (!ts.isCallExpression(recv) || !ts.isPropertyAccessExpression(recv.expression)) break;
    const name = recv.expression.name.text;
    if (name === "route") return { pathExpr: recv.arguments[0], handlers: [...call.arguments] };
    if (!ROUTE_CALLS.has(name)) break;
    recv = unwrap(ts, recv.expression.expression);
  }
  const [pathExpr, ...handlers] = call.arguments;
  return { pathExpr, handlers };
}
