// Zod schema linking for the route list (schemas.ts): static reads of a route's registration call site.
// The SchemaLinker suite works on temp files only (nothing is run); the end-to-end suite starts a
// fixture app on Express 4 and 5 and reads the schemas from /__hoplens/api/routes.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SchemaLinker, registrationCall, targetOfName } from "../src/schemas";
import { type Child, type Fixture, PKG, REGISTER, childEnv, freePort, makeFixture, run } from "./helpers";

function lineOf(src: string, marker: string): number {
  const i = src.split("\n").findIndex((l) => l.includes(`// @${marker}`));
  if (i < 0) throw new Error(`no marker ${marker}`);
  return i + 1;
}

const SCHEMAS_MJS = `
import { z } from "zod";
export const OrderBody = z.object({ customer: z.string().min(1), qty: z.number().int().min(1) });
export const ListQuery = z.object({ limit: z.coerce.number().int().max(50).optional(), q: z.string() });
const Item = z.object({ sku: z.string(), price: z.number() });
export { Item as RenamedItem };
`;

const HANDLERS_MJS = `
import { OrderBody, ListQuery } from "./schemas.mjs";
export async function createOrder(req, res) {
  const body = OrderBody.parse(req.body);
  res.status(201).json(body);
}
export const listOrders = (req, res) => {
  const q = ListQuery.safeParse(req.query);
  res.json(q);
};
export default function updateOrder(req, res) {
  res.json(OrderBody.partial().parse(req.body));
}
`;

const CONTROLLER_MJS = `
import { RenamedItem } from "./schemas.mjs";
export const items = {
  create(req, res) {
    res.json(RenamedItem.parse(req.body));
  },
};
`;

const VALIDATE_MJS = `
export function validate(schema) {
  return (req, _res, next) => { req.body = schema.parse(req.body); next(); };
}
export function validateQuery(schema) {
  return (req, _res, next) => { schema.parse(req.query); next(); };
}
export const zValidator = (part, schema) => (req, _res, next) => next();
`;

const CLASSES_MJS = `
import { OrderBody } from "./schemas.mjs";
export class OrderController {
  create(req, res) {
    res.json(OrderBody.parse(req.body));
  }
  static make(req, res) {
    res.json(OrderBody.parse(req.body));
  }
  update = (req, res) => res.json(OrderBody.partial().parse(req.body));
}
export const orders = new OrderController();
`;

const SERVICE_MJS = `
import { OrderBody } from "./schemas.mjs";
import * as S from "./schemas.mjs";
export const service = {
  create(req, res) {
    res.json(OrderBody.parse(req.body));
  },
};
export function viaNs(req, res) {
  res.json(S.ListQuery.parse(req.query));
}
export class Ctl {
  create(req, res) {
    return service.create(req, res);
  }
}
export const ctl = new Ctl();
export function loopA(req, res) {
  return loopB(req, res);
}
export function loopB(req, res) {
  return loopA(req, res);
}
`;

const ROUTES_MJS = `
import { ListQuery, OrderBody } from "./schemas.mjs";
import { validate } from "./validate.mjs";
import { createOrder, listOrders } from "./handlers.mjs";
export const routes = [
  { method: "post", path: "/t/orders", middleware: [validate(OrderBody)], handler: (req, res) => res.json({}) },
  { method: "get", path: "/t/orders", middleware: [], handler: listOrders },
  { method: "put", path: "/t/items", middleware: [], handler: createOrder },
];
export const byPath = {
  "/m/orders": createOrder,
  "/m/list": (req, res) => res.json(ListQuery.parse(req.query)),
};
`;

/** Read by the linker only (never run): more route-table shapes. */
const TABLES_MJS = `
import express from "express";
import { createOrder, listOrders } from "./handlers.mjs";
import { routes } from "./routes.mjs";
const app = express();
const ITEMS = "/items";
const more = [{ path: ITEMS, handler: createOrder }];
const all = [...more, { path: /^\\/re$/, handler: listOrders }];
for (const { path, handler: h } of all) app.post(path, h); // @destructure
function mount(list) { for (const r of list) app.post(r.path, r.handler); } // @param
for (const r of routes.map((x) => x)) app.post(r.path, r.handler); // @mapped
for (const r of routes) app.post(r.path, (req, res) => r.handler(req, res)); // @inlineuse
`;

const APP_MJS = `
import express from "express";
import { z } from "zod";
import * as ctrl from "./controller.mjs";
import updateOrder, { createOrder, listOrders } from "./handlers.mjs";
import { OrderBody, ListQuery, RenamedItem } from "./schemas.mjs";
import { validate, validateQuery, zValidator } from "./validate.mjs";
import { OrderController, orders } from "./classes.mjs";
import { service, viaNs, ctl, loopA } from "./service.mjs";
import { routes, byPath } from "./routes.mjs";
import * as schemasNs from "./schemas.mjs";

const app = express();
const Local = z.object({ title: z.string().max(80), done: z.boolean().default(false) });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function localHandler(req, res) {
  const parsed = Local.parse(req.body);
  res.json(parsed);
}
const checkOrder = validate(OrderBody);
const transformBody = (s) => (req, res, next) => next();
const requireRole = (s) => (req, res, next) => next();
const Role = z.enum(["admin", "user"]);
const mine = new OrderController();

app.post("/inline", express.json(), (req, res) => { // @inline
  const t = Local.parse(req.body);
  res.json(t);
});
app.post("/local", express.json(), localHandler); // @local
app.post("/imported", express.json(), createOrder); // @imported
app.get("/query", listOrders); // @query
app.put("/default", express.json(), updateOrder); // @default
app.post("/validate", express.json(), validate(OrderBody), (req, res) => res.json(req.body)); // @validate
app.get("/vquery", validateQuery(ListQuery), (req, res) => res.json({})); // @vquery
app.post("/zv", zValidator("json", RenamedItem), (req, res) => res.json({})); // @zv
app.post("/named-mw", checkOrder, (req, res) => res.json({})); // @namedmw
app.post("/object-mw", validate({ body: OrderBody, query: ListQuery }), (req, res) => res.json({})); // @objectmw
app.post("/wrapped", wrap(createOrder)); // @wrapped
app.post("/member", ctrl.items.create); // @member
app.get("/none", (req, res) => res.json({ n: Number(req.query.n) })); // @none
app.post("/plain-mw", express.json(), express.urlencoded({ extended: true }), (req, res) => res.json({})); // @plainmw
app
  .route("/chain")
  .get((req, res) => res.json(ListQuery.parse(req.query))) // @chainget
  .post(express.json(), (req, res) => res.json(OrderBody.parse(req.body))); // @chainpost
app.post("/both", express.json(), validateQuery(ListQuery), (req, res) => { // @both
  res.json(OrderBody.parse(req.body));
});
app.post("/class", express.json(), orders.create); // @class
app.post("/bind", express.json(), mine.create.bind(mine)); // @bind
app.post("/static", express.json(), OrderController.make); // @static
app.patch("/field", express.json(), orders.update); // @field
app.post("/spread", ...[express.json(), createOrder]); // @spread
app.post("/transform", express.json(), transformBody(OrderBody), (req, res) => res.json({})); // @transform
app.post("/role", express.json(), requireRole(Role), (req, res) => res.json({})); // @role
app.post("/d-arrow", express.json(), (req, res) => service.create(req, res)); // @darrow
app.post("/d-next", express.json(), (req, res, next) => createOrder(req, res, next)); // @dnext
app.post("/d-await", express.json(), async (req, res) => { await service.create(req, res); }); // @dawait
app.post("/d-fn", express.json(), function (req, res) { return createOrder(req, res); }); // @dfn
app.post("/d-class", express.json(), (req, res) => ctl.create(req, res)); // @dclass
app.post("/d-cycle", express.json(), (req, res) => loopA(req, res)); // @dcycle
app.post("/d-catch", express.json(), (req, res, next) => createOrder(req, res).catch(next)); // @dcatch
app.get("/d-ns", (req, res) => viaNs(req, res)); // @dns
app.post("/d-res", express.json(), (req, res) => res.json(req.body)); // @dres
app.post("/ns-mw", express.json(), validate(schemasNs.OrderBody), (req, res) => res.json({})); // @nsmw
const router = express.Router();
for (const r of routes) {
  router
    [r.method](r.path, express.json(), ...r.middleware, r.handler); // @forof
}
app.use(router);
const table = [
  { path: "/fe/a", handler: createOrder },
  { path: "/fe/b", handler: listOrders },
];
table.forEach((r) => app.post(r.path, express.json(), r.handler)); // @foreach
for (const [path, h] of Object.entries(byPath)) app.post(path, express.json(), h); // @entries
const dup = [
  { path: "/dup", handler: createOrder },
  { path: "/dup", handler: listOrders },
];
for (const { path, handler } of dup) app.post(path, handler); // @dup
routes.forEach((r) => app.patch("/u" + r.path, r.handler)); // @tpl

const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

const CJS_SCHEMAS = `
const { z } = require("zod");
const Signup = z.object({ email: z.email(), age: z.number().int().min(18) });
module.exports = { Signup };
exports.Ping = z.object({ at: z.iso.datetime() });
`;

const CJS_HANDLERS = `
const schemas = require("./schemas.cjs");
const { Signup } = require("./schemas.cjs");
function signup(req, res) {
  res.json(Signup.parse(req.body));
}
exports.signup = signup;
exports.ping = (req, res) => res.json(schemas.Ping.parse(req.body));
`;

const CJS_APP = `
const express = require("express");
const handlers = require("./handlers.cjs");
const { signup } = require("./handlers.cjs");
const S2 = require("./schemas.cjs");
const app = express();
app.post("/signup", express.json(), signup); // @signup
app.post("/ping", express.json(), handlers.ping); // @ping
app.post("/s2", express.json(), (req, res) => res.json(S2.Signup.parse(req.body))); // @s2
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

const FILES = {
  "schemas.mjs": SCHEMAS_MJS,
  "handlers.mjs": HANDLERS_MJS,
  "controller.mjs": CONTROLLER_MJS,
  "validate.mjs": VALIDATE_MJS,
  "classes.mjs": CLASSES_MJS,
  "service.mjs": SERVICE_MJS,
  "routes.mjs": ROUTES_MJS,
  "tables.mjs": TABLES_MJS,
  "app.mjs": APP_MJS,
  "schemas.cjs": CJS_SCHEMAS,
  "handlers.cjs": CJS_HANDLERS,
  "app.cjs": CJS_APP,
};

/**
 * [marker, method, file, expected targets with schema names, route path] for the fixture
 * registrations; the route path picks one of the routes a loop registered from the marker's line.
 */
const CASES: Array<[string, string, string, Array<[string, string | undefined]>, string?]> = [
  ["inline", "POST", "app.mjs", [["body", "Local"]]],
  ["local", "POST", "app.mjs", [["body", "Local"]]],
  ["imported", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["query", "GET", "app.mjs", [["query", "ListQuery"]]],
  ["default", "PUT", "app.mjs", [["body", undefined]]],
  ["validate", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["vquery", "GET", "app.mjs", [["query", "ListQuery"]]],
  ["zv", "POST", "app.mjs", [["body", "RenamedItem"]]],
  ["namedmw", "POST", "app.mjs", [["body", "OrderBody"]]],
  [
    "objectmw",
    "POST",
    "app.mjs",
    [
      ["body", "OrderBody"],
      ["query", "ListQuery"],
    ],
  ],
  ["wrapped", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["member", "POST", "app.mjs", [["body", "RenamedItem"]]],
  ["none", "GET", "app.mjs", []],
  ["plainmw", "POST", "app.mjs", []],
  ["chainget", "GET", "app.mjs", [["query", "ListQuery"]]],
  ["chainpost", "POST", "app.mjs", [["body", "OrderBody"]]],
  [
    "both",
    "POST",
    "app.mjs",
    [
      ["body", "OrderBody"],
      ["query", "ListQuery"],
    ],
  ],
  ["class", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["bind", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["static", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["field", "PATCH", "app.mjs", [["body", undefined]]],
  ["spread", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["transform", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["role", "POST", "app.mjs", []],
  ["darrow", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["dnext", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["dawait", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["dfn", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["dclass", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["dcycle", "POST", "app.mjs", []],
  ["dcatch", "POST", "app.mjs", [["body", "OrderBody"]]],
  ["dns", "GET", "app.mjs", [["query", "S.ListQuery"]]],
  ["dres", "POST", "app.mjs", []],
  ["nsmw", "POST", "app.mjs", [["body", "schemasNs.OrderBody"]]],
  ["forof", "POST", "app.mjs", [["body", "OrderBody"]], "/t/orders"],
  ["forof", "GET", "app.mjs", [["query", "ListQuery"]], "/t/orders"],
  ["forof", "PUT", "app.mjs", [["body", "OrderBody"]], "/t/items"],
  ["foreach", "POST", "app.mjs", [["body", "OrderBody"]], "/fe/a"],
  ["foreach", "POST", "app.mjs", [["query", "ListQuery"]], "/fe/b"],
  ["entries", "POST", "app.mjs", [["body", "OrderBody"]], "/m/orders"],
  ["entries", "POST", "app.mjs", [["query", "ListQuery"]], "/m/list"],
  ["dup", "POST", "app.mjs", [], "/dup"],
  ["tpl", "PATCH", "app.mjs", [], "/u/t/items"],
  ["signup", "POST", "app.cjs", [["body", "Signup"]]],
  ["ping", "POST", "app.cjs", [["body", "schemas.Ping"]]],
  ["s2", "POST", "app.cjs", [["body", "S2.Signup"]]],
];

function summary(list: any[]): Array<[string, string | undefined]> {
  return list.map((s) => [s.target, s.name]);
}

describe("SchemaLinker", () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = makeFixture(undefined, FILES);
  });
  afterAll(() => fx?.cleanup());

  test.each(CASES)("%s (%s in %s, %s)", (marker, method, file, want, routePath) => {
    const linker = new SchemaLinker(fx.root);
    const line = lineOf(FILES[file as keyof typeof FILES], marker);
    expect(summary(linker.link(file, line, method, routePath))).toEqual(want);
  });

  test("a member-access schema is located at its declaration (namespace, require object)", () => {
    const linker = new SchemaLinker(fx.root);
    const at = (file: string, src: string, marker: string, method: string) =>
      linker.link(file, lineOf(src, marker), method).map((s) => [s.name, s.file, s.line]);
    expect(at("app.mjs", APP_MJS, "nsmw", "POST")).toEqual([["schemasNs.OrderBody", "schemas.mjs", 3]]);
    expect(at("app.mjs", APP_MJS, "dns", "GET")).toEqual([["S.ListQuery", "schemas.mjs", 4]]);
    expect(at("app.cjs", CJS_APP, "s2", "POST")).toEqual([["S2.Signup", "schemas.cjs", 3]]);
    expect(at("app.cjs", CJS_APP, "ping", "POST")).toEqual([["schemas.Ping", "schemas.cjs", 5]]);
  });

  test("route tables: destructured elements, a const path, a spread table, a regex path", () => {
    const linker = new SchemaLinker(fx.root);
    const line = lineOf(TABLES_MJS, "destructure");
    expect(summary(linker.link("tables.mjs", line, "POST", "/items"))).toEqual([["body", "OrderBody"]]);
    expect(summary(linker.link("tables.mjs", line, "POST", /^\/re$/))).toEqual([["query", "ListQuery"]]);
    expect(linker.link("tables.mjs", line, "POST", "/re")).toEqual([]);
  });

  test("a table that is a parameter or built at runtime, or a loop variable used in an inline handler, gives none", () => {
    const linker = new SchemaLinker(fx.root);
    for (const marker of ["param", "mapped", "inlineuse"])
      expect(linker.link("tables.mjs", lineOf(TABLES_MJS, marker), "POST", "/t/items"), marker).toEqual([]);
  });

  test("a loop registration without the route's path, or with one no element has, gets no schema", () => {
    const linker = new SchemaLinker(fx.root);
    const line = lineOf(APP_MJS, "forof");
    expect(linker.link("app.mjs", line, "POST")).toEqual([]);
    expect(linker.link("app.mjs", line, "POST", "/nope")).toEqual([]);
    // The method tells the two /t/orders routes apart: DELETE is neither.
    expect(linker.link("app.mjs", line, "DELETE", "/t/orders")).toEqual([]);
  });

  test("a body schema carries the shape, an example the schema accepts, fields and its declaration", () => {
    const linker = new SchemaLinker(fx.root);
    const [s] = linker.link("app.mjs", lineOf(APP_MJS, "imported"), "POST");
    expect(s).toMatchObject({ target: "body", name: "OrderBody", file: "schemas.mjs", line: 3 });
    expect((s!.shape as any).t).toBe("object");
    expect(s!.example).toMatchObject({ customer: expect.any(String), qty: expect.any(Number) });
    expect((s!.example as any).customer.length).toBeGreaterThan(0);
    expect((s!.example as any).qty).toBeGreaterThanOrEqual(1);
    expect(s!.fields.map((f) => f.path)).toEqual(["customer", "qty"]);
    const [cjs] = linker.link("app.cjs", lineOf(CJS_APP, "signup"), "POST");
    expect(cjs).toMatchObject({ file: "schemas.cjs", line: 3 });
  });

  test("the default-exported handler's inline schema is found; `.partial()` keeps the props optional", () => {
    const linker = new SchemaLinker(fx.root);
    const [s] = linker.link("app.mjs", lineOf(APP_MJS, "default"), "PUT");
    expect(s!.file).toBe("handlers.mjs");
    expect(s!.fields.every((f) => f.optional)).toBe(true);
  });

  test("a wrong line, an unknown file or no location gives no schemas and never throws", () => {
    const linker = new SchemaLinker(fx.root);
    expect(linker.link("app.mjs", 1, "POST")).toEqual([]);
    expect(linker.link("missing.js", 3, "POST")).toEqual([]);
    expect(linker.link("", 0, "GET")).toEqual([]);
    fs.writeFileSync(path.join(fx.root, "garbage.js"), "app.post('/x', (req, res) => { ((((( ".repeat(500));
    expect(() => linker.link("garbage.js", 1, "POST")).not.toThrow();
  });

  test("results are cached until the registration file or a file it read changes", () => {
    const linker = new SchemaLinker(fx.root);
    const line = lineOf(APP_MJS, "imported");
    const first = linker.link("app.mjs", line, "POST");
    expect(linker.link("app.mjs", line, "POST")).toBe(first);
    // Edit the imported schema file: its mtime moves, so the lookup runs again.
    const file = path.join(fx.root, "schemas.mjs");
    fs.writeFileSync(file, SCHEMAS_MJS.replace("qty: z.number().int().min(1)", "qty: z.number(), note: z.string()"));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
    const next = linker.link("app.mjs", line, "POST");
    expect(next).not.toBe(first);
    expect(next[0]!.fields.map((f) => f.path)).toEqual(["customer", "qty", "note"]);
    fs.writeFileSync(file, SCHEMAS_MJS);
  });
});

/* Registrations whose static read could name the wrong schema: each gets the runtime's, or none. */
const PIT_S = `import { z } from "zod";
export const A = z.object({ a: z.string() });
export const B = z.object({ b: z.string() });
`;
const PIT_H = `import { A, B } from "./s.mjs";
export function createA(req, res) { A.parse(req.body); }
export function createB(req, res) { B.parse(req.body); }
export function validateQuery(schema) { return (req, _res, next) => { schema.parse(req.query); next(); }; }
`;
const PIT_IMPORT = `import { createA, createB, validateQuery } from "./h.mjs";\nimport { A } from "./s.mjs";\n`;

/** [case, source (after the imports; the `// @X` line registers), method, route path, expected]. */
const PITFALLS: Array<[string, string, string, string, Array<[string, string | undefined]>]> = [
  // A delegating handler forwards something other than its own request as the callee's request.
  [
    "deleg-other-req",
    `app.post("/x", (req, res) => createA({ ...req, body: req.query.payload }, res, req)); // @X`,
    "POST",
    "/x",
    [],
  ],
  ["deleg-req-second", `app.post("/x", (req, res) => createA(res, req)); // @X`, "POST", "/x", []],
  // A later spread or a duplicate key overrides an element's handler at runtime.
  [
    "spread-override",
    `const extra = { handler: createB };\nconst routes = [{ path: "/x", handler: createA, ...extra }];\nfor (const r of routes) app.post(r.path, r.handler); // @X`,
    "POST",
    "/x",
    [],
  ],
  [
    "dup-key",
    `const routes = [{ path: "/x", handler: createA, handler: createB }];\nfor (const r of routes) app.post(r.path, r.handler); // @X`,
    "POST",
    "/x",
    [["body", "B"]],
  ],
  // A parameter shadows the module const the loop's collection is a member of.
  [
    "shadow-member",
    `const api = { routes: [{ path: "/x", handler: createA }] };\nexport function mount(app, api) {\n  for (const r of api.routes) app.post(r.path, r.handler); // @X\n}`,
    "POST",
    "/x",
    [],
  ],
  // A destructuring default applies only when the key is truly absent.
  [
    "default-unreadable",
    `const base = { handler: createB };\nconst routes = [{ path: "/x", ...base }];\nfor (const { path, handler = createA } of routes) app.post(path, handler); // @X`,
    "POST",
    "/x",
    [],
  ],
  [
    "default-absent",
    `const routes = [{ path: "/x" }];\nfor (const { path, handler = createA } of routes) app.post(path, handler); // @X`,
    "POST",
    "/x",
    [["body", "A"]],
  ],
  // The loop variable or the table is changed before the registration reads it.
  [
    "let-reassign",
    `const routes = [{ path: "/x", handler: createA }];\nfor (let r of routes) { r = { ...r, handler: createB }; app.post(r.path, r.handler); } // @X`,
    "POST",
    "/x",
    [],
  ],
  [
    "mutated-table",
    `const routes = [{ path: "/x", handler: createA }];\nroutes[0].handler = createB;\nfor (const r of routes) app.post(r.path, r.handler); // @X`,
    "POST",
    "/x",
    [],
  ],
  [
    "pushed",
    `const routes = [{ path: "/x", handler: createA }];\nroutes.push({ path: "/x", handler: createB });\nfor (const r of routes) app.post(r.path, r.handler); // @X`,
    "POST",
    "/x",
    [],
  ],
  // app.del is DELETE: it is the registration even with a dynamic call on its line.
  [
    "del-dynamic",
    `const fns = { a: createA };\napp.del("/x", validate(A), (req, res) => fns[req.params.k](req, res)); // @X`,
    "DELETE",
    "/x",
    [["body", "A"]],
  ],
  // A spread array literal that uses the loop variable is read element by element.
  [
    "spread-array",
    `const routes = [{ path: "/x", handler: createB }];\nfor (const r of routes) app.post(r.path, ...[validateQuery(A), r.handler]); // @X`,
    "POST",
    "/x",
    [
      ["body", "B"],
      ["query", "A"],
    ],
  ],
  // A function-local name is never resolved to a same-named module binding.
  [
    "local-alias-loop",
    `const handler = createA;\nconst routes = [{ path: "/x", handler: createB }, { path: "/y", handler: createB }];\nfor (const r of routes) { const { handler } = r; app.post(r.path, handler); } // @X`,
    "POST",
    "/x",
    [],
  ],
  [
    "local-const",
    `const handler = createA;\nexport function mount(app) {\n  const handler = createB;\n  app.post("/x", handler); // @X\n}`,
    "POST",
    "/x",
    [["body", "B"]],
  ],
];

describe("SchemaLinker: the runtime's schema or none", () => {
  let fx: Fixture;
  const files: Record<string, string> = { "s.mjs": PIT_S, "h.mjs": PIT_H };
  for (const [name, src] of PITFALLS) files[`${name}.mjs`] = `${PIT_IMPORT}${src}\n`;
  beforeAll(() => {
    fx = makeFixture(undefined, files);
  });
  afterAll(() => fx?.cleanup());

  test.each(PITFALLS)("%s", (name, _src, method, routePath, want) => {
    const linker = new SchemaLinker(fx.root);
    const file = `${name}.mjs`;
    expect(summary(linker.link(file, lineOf(files[file]!, "X"), method, routePath))).toEqual(want);
  });
});

describe("targetOfName", () => {
  test("matches whole words of the callee name, else the body", () => {
    expect(targetOfName("validateQuery")).toBe("query");
    expect(targetOfName("validate_query")).toBe("query");
    expect(targetOfName("validateParams")).toBe("params");
    expect(targetOfName("checkParam")).toBe("params");
    expect(targetOfName("parseForm")).toBe("form");
    expect(targetOfName("validateBody")).toBe("body");
    for (const n of ["transformBody", "formatInput", "performCheck", "conform", "uniformBody", "paramountCheck"])
      expect(targetOfName(n), n).toBe("body");
  });
});

describe("registrationCall", () => {
  test("a file is walked once however many registrations are looked up in it", () => {
    const n = 300;
    const src = Array.from(
      { length: n },
      (_, i) => `app.post("/r${i}", (req, res) => res.json(S.parse(req.body)));`,
    ).join("\n");
    const sf = ts.createSourceFile("many.js", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let visits = 0;
    const counting = Object.create(ts, {
      forEachChild: {
        value: (node: any, cb: any) => {
          visits++;
          return ts.forEachChild(node, cb);
        },
      },
    });
    for (let line = 1; line <= n; line++) {
      const call = registrationCall(counting, sf, line, "POST");
      expect(call && (call.arguments[0] as ts.StringLiteral).text).toBe(`/r${line - 1}`);
    }
    const onePass = visits;
    // A single walk visits every node once; N walks would be N times that.
    expect(onePass).toBeLessThan(n * 30);
    visits = 0;
    registrationCall(counting, sf, 1, "POST");
    expect(visits).toBe(0);
  });
});

/* ------------------------------------------------------------- end to end */

function get(port: number, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function linkZod(root: string) {
  const target = path.dirname(require.resolve("zod/package.json", { paths: [PKG] }));
  fs.symlinkSync(fs.realpathSync(target), path.join(root, "node_modules", "zod"), "junction");
}

describe.each([
  ["express4", "-r"],
  ["express5", "--import"],
] as const)("schemas in the route list on %s (%s register)", (alias, flag) => {
  let fx: Fixture;
  const apps: Child[] = [];
  const ports: Record<string, number> = {};

  beforeAll(async () => {
    fx = makeFixture(alias, FILES);
    linkZod(fx.root);
    const register = flag === "--import" ? pathToFileURL(REGISTER).href : REGISTER;
    for (const entry of ["app.mjs", "app.cjs"]) {
      const app = run([flag, register, entry], fx.root, childEnv({ HOPLENS_PORT: String(await freePort()) }));
      apps.push(app);
      ports[entry] = (await app.waitFor<{ ready: number }>("ready")).ready;
    }
  }, 60000);

  afterAll(async () => {
    for (const a of apps) await a.kill();
    try {
      fs.unlinkSync(path.join(fx.root, "node_modules", "zod"));
    } catch {
      /* already gone */
    }
    fx?.cleanup();
  });

  test("every registration's schemas, as SchemaLinker reads them", async () => {
    const routes: Record<string, any> = {};
    for (const entry of ["app.mjs", "app.cjs"]) {
      routes[entry] = JSON.parse(await get(ports[entry]!, "/__hoplens/api/routes?fresh"));
    }
    for (const [marker, method, file, want, routePath] of CASES) {
      const src = FILES[file as keyof typeof FILES];
      const line = lineOf(src, marker);
      const m = routes[file].routes
        .flatMap((r: any) => r.methods.map((x: any) => ({ ...x, file: r.file, template: r.nextRoute })))
        .find(
          (x: any) => x.method === method && x.line === line && (routePath === undefined || x.template === routePath),
        );
      expect(m, `${marker}: ${method} at ${file}:${line}`).toBeDefined();
      expect(m.file).toBe(file);
      expect(summary(m.schemas), marker).toEqual(want);
    }
  });
});
