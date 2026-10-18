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

const APP_MJS = `
import express from "express";
import { z } from "zod";
import * as ctrl from "./controller.mjs";
import updateOrder, { createOrder, listOrders } from "./handlers.mjs";
import { OrderBody, ListQuery, RenamedItem } from "./schemas.mjs";
import { validate, validateQuery, zValidator } from "./validate.mjs";
import { OrderController, orders } from "./classes.mjs";

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
const app = express();
app.post("/signup", express.json(), signup); // @signup
app.post("/ping", express.json(), handlers.ping); // @ping
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

const FILES = {
  "schemas.mjs": SCHEMAS_MJS,
  "handlers.mjs": HANDLERS_MJS,
  "controller.mjs": CONTROLLER_MJS,
  "validate.mjs": VALIDATE_MJS,
  "classes.mjs": CLASSES_MJS,
  "app.mjs": APP_MJS,
  "schemas.cjs": CJS_SCHEMAS,
  "handlers.cjs": CJS_HANDLERS,
  "app.cjs": CJS_APP,
};

/** [marker, method, file, expected targets with schema names] for the fixture registrations. */
const CASES: Array<[string, string, string, Array<[string, string | undefined]>]> = [
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
  ["signup", "POST", "app.cjs", [["body", "Signup"]]],
  ["ping", "POST", "app.cjs", [["body", "schemas.Ping"]]],
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

  test.each(CASES)("%s (%s in %s)", (marker, method, file, want) => {
    const linker = new SchemaLinker(fx.root);
    const line = lineOf(FILES[file as keyof typeof FILES], marker);
    expect(summary(linker.link(file, line, method))).toEqual(want);
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
    for (const [marker, method, file, want] of CASES) {
      const src = FILES[file as keyof typeof FILES];
      const line = lineOf(src, marker);
      const m = routes[file].routes
        .flatMap((r: any) => r.methods.map((x: any) => ({ ...x, file: r.file })))
        .find((x: any) => x.method === method && x.line === line);
      expect(m, `${marker}: ${method} at ${file}:${line}`).toBeDefined();
      expect(m.file).toBe(file);
      expect(summary(m.schemas), marker).toEqual(want);
    }
  });
});
