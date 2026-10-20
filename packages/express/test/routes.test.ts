// M2 end to end: route templates, handler hops and Express's own dispatch semantics, on Express 4 and
// 5, through the built register hook. Every golden request is also replayed against the same app run
// without Hoplens (HOPLENS=0), and the responses must be identical.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Child,
  type ExpressAlias,
  type Fixture,
  INDEX,
  REGISTER,
  childEnv,
  freePort,
  makeFixture,
  poll,
  run,
} from "./helpers";

// `// @name` markers name the line a route is registered on (see lineOf).
const APP = `
const express = require("express");
const V5 = Number(require("express/package.json").version.split(".")[0]) >= 5;
const ROUTE = Symbol.for("hoplens.express.route");
const PATCHED = Symbol.for("hoplens.express.patched");
const rt = () => globalThis.__hoplens_runtime;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = express();

app.get("/plain", (req, res) => res.json({ ok: true })); // @plain
app.get("/items/:id", (req, res) => res.json({ id: req.params.id }));

const orders = express.Router({ mergeParams: true });
orders.get("/orders/:id", (req, res) => { // @orders
  const db = rt() && rt().beginHop("db", { name: "SELECT order" });
  if (db) db.end();
  res.json({ uid: req.params.uid, id: req.params.id });
});
app.use("/api/users/:uid", orders);

const shared = express.Router();
shared.get("/ping/:n", (req, res) => res.json({ base: req.baseUrl, n: req.params.n }));
app.use("/v1", shared);
app.use("/v2/:tenant", shared);

const admin = express();
admin.get("/stats", (req, res) => res.json({ admin: true })); // @admin
app.use("/admin", admin);

app.route("/x").get((req, res) => res.send("get x")).post((req, res) => res.send("post x")); // @x

if (V5) {
  app.get("/files/*splat", (req, res) => res.json({ splat: req.params.splat }));
  app.get("/opt{/:maybe}", (req, res) => res.json({ maybe: req.params.maybe ?? null }));
} else {
  app.get("/files/*", (req, res) => res.json({ splat: req.params[0] }));
  app.get("/opt/:maybe?", (req, res) => res.json({ maybe: req.params.maybe ?? null }));
}
app.get(/^\\/re\\/(\\d+)$/, (req, res) => res.json({ n: req.params[0] }));

// Dispatch semantics.
app.get("/fall", (req, res, next) => next("route"));
app.get("/fall", (req, res) => res.send("second"));
const exits = express.Router();
exits.get("/exit", (req, res, next) => next("router"));
exits.get("/exit", (req, res) => res.send("never"));
app.use("/rx", exits);
app.get("/rx/exit", (req, res) => res.send("after router"));
app.get("/err", (req, res, next) => {
  req.passed = new Error("passed");
  next(req.passed);
});
app.get("/throw", () => {
  throw new Error("thrown sync");
});
if (V5) {
  app.get("/async", async (req) => {
    await sleep(5);
    req.passed = new Error("rejected");
    throw req.passed;
  });
}
app.get("/ends", (req, res) => res.status(201).end("ended"));
// Responds, then hands on to audit middleware: the route that answered keeps the request.
app.get("/endnext", (req, res, next) => {
  res.end("ended");
  next();
});
app.use("/endnext", (req, res, next) => {});
app.get("/async-db", async (req, res) => { // @asyncdb
  await sleep(3);
  const db = rt() && rt().beginHop("db", { name: "SELECT async" });
  await sleep(2);
  if (db) db.end();
  res.json({ ok: true });
});
const probe = (req, res) => res.json({ traced: !!(rt() && rt().currentTrace()), route: req[ROUTE] ?? null });
app.get("/probe", probe);
app.get("/probe-ignored", probe);
app.get("/patched", (req, res) =>
  res.json({ dispatch: !!express.Route.prototype.dispatch[PATCHED], runtime: !!rt() }),
);

app.use((err, req, res, next) => {
  res.status(500).json({ caught: err.message, same: err === req.passed || err.message === "thrown sync" });
});

const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

function lineOf(marker: string): number {
  return APP.split("\n").findIndex((l) => l.includes(`// @${marker}`)) + 1;
}

interface Res {
  status: number;
  body: string;
}

function request(port: number, method: string, path: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function traceFor(port: number, method: string, path: string): Promise<any> {
  const summary = await poll(async () => {
    const list = JSON.parse((await request(port, "GET", "/__hoplens/api/traces")).body) as any[];
    return list.find((t) => t.done && t.method === method && t.url === path);
  });
  return JSON.parse((await request(port, "GET", `/__hoplens/api/traces/${summary.id}`)).body);
}

const handlers = (t: any) => t.spans.filter((s: any) => s.kind === "handler");

/** Golden requests, replayed with and without Hoplens. */
const GOLDEN: Array<[string, string]> = [
  ["GET", "/plain"],
  ["GET", "/items/42"],
  ["GET", "/api/users/7/orders/9"],
  ["GET", "/v1/ping/1"],
  ["GET", "/v2/acme/ping/2"],
  ["GET", "/admin/stats"],
  ["GET", "/x"],
  ["POST", "/x"],
  ["GET", "/files/a/b.txt"],
  ["GET", "/opt"],
  ["GET", "/opt/yes"],
  ["GET", "/re/123"],
  ["GET", "/fall"],
  ["GET", "/rx/exit"],
  ["GET", "/err"],
  ["GET", "/throw"],
  ["GET", "/async"],
  ["GET", "/ends"],
  ["GET", "/endnext"],
  ["GET", "/nope"],
];

describe.each([
  ["express4", "-r"],
  ["express5", "--import"],
] as const)("%s (%s register)", (alias: ExpressAlias, flag) => {
  const v5 = alias === "express5";
  let fx: Fixture;
  let app: Child;
  let plain: Child;
  let port: number;
  let plainPort: number;

  beforeAll(async () => {
    fx = makeFixture(alias, { "routes.cjs": APP });
    const register = flag === "--import" ? pathToFileURL(REGISTER).href : REGISTER;
    app = run(
      [flag, register, "routes.cjs"],
      fx.root,
      childEnv({ HOPLENS_PORT: String(await freePort()), HOPLENS_IGNORE: "/probe-ignored" }),
    );
    plain = run([flag, register, "routes.cjs"], fx.root, childEnv({ HOPLENS: "0" }));
    port = (await app.waitFor<{ ready: number }>("ready")).ready;
    plainPort = (await plain.waitFor<{ ready: number }>("ready")).ready;
  });

  afterAll(async () => {
    await app?.kill();
    await plain?.kill();
    fx?.cleanup();
  });

  test("golden dispatch: every response is identical with and without Hoplens", async () => {
    for (const [method, path] of GOLDEN) {
      const a = await request(port, method, path);
      const b = await request(plainPort, method, path);
      expect({ method, path, ...a }).toEqual({ method, path, ...b });
    }
    // The semantics themselves, as Express defines them.
    expect((await request(port, "GET", "/fall")).body).toBe("second");
    expect((await request(port, "GET", "/rx/exit")).body).toBe("after router");
    expect(JSON.parse((await request(port, "GET", "/err")).body)).toEqual({ caught: "passed", same: true });
    expect(JSON.parse((await request(port, "GET", "/throw")).body)).toEqual({ caught: "thrown sync", same: true });
    if (v5) expect(JSON.parse((await request(port, "GET", "/async")).body)).toEqual({ caught: "rejected", same: true });
    expect(await request(port, "GET", "/ends")).toEqual({ status: 201, body: "ended" });
    expect((await request(port, "GET", "/nope")).status).toBe(404);
    expect(app.stderr()).not.toContain("hoplens:express");
  });

  test.each([
    ["GET", "/plain", "/plain"],
    ["GET", "/items/42", "/items/:id"],
    ["GET", "/api/users/7/orders/9", "/api/users/:uid/orders/:id"],
    ["GET", "/v1/ping/1", "/v1/ping/:n"],
    ["GET", "/v2/acme/ping/2", "/v2/:tenant/ping/:n"],
    ["GET", "/admin/stats", "/admin/stats"],
    ["GET", "/x", "/x"],
    ["POST", "/x", "/x"],
    ["GET", "/opt/yes", "/opt/:maybe?"],
    ["GET", "/re/123", "/^\\/re\\/(\\d+)$/"],
    ["GET", "/fall", "/fall"],
    ["GET", "/rx/exit", "/rx/exit"],
    ["GET", "/endnext", "/endnext"],
  ])("%s %s is grouped under %s", async (method, path, template) => {
    await request(port, method, path);
    const t = await traceFor(port, method, path);
    expect(t.route).toBe(template);
    expect(t.kind).toBe("route");
  });

  test("Express 5 wildcards use the :name+ notation", async () => {
    await request(port, "GET", "/files/a/b.txt");
    const t = await traceFor(port, "GET", "/files/a/b.txt");
    expect(t.route).toBe(v5 ? "/files/:splat+" : "/files/*");
  });

  test("handler hop: named by method and template, located at the registration line", async () => {
    await request(port, "GET", "/api/users/7/orders/9");
    const t = await traceFor(port, "GET", "/api/users/7/orders/9");
    const [h, ...rest] = handlers(t);
    expect(rest).toHaveLength(0);
    expect(h.name).toBe("GET /api/users/:uid/orders/:id");
    expect(h.location).toEqual({ file: "routes.cjs", line: lineOf("orders") });
    const db = t.spans.find((s: any) => s.name === "SELECT order");
    expect(db.kind).toBe("db");
    expect(db.parentId).toBe(h.id);

    for (const [path, marker] of [
      ["/plain", "plain"],
      ["/admin/stats", "admin"],
      ["/x", "x"],
    ]) {
      await request(port, "GET", path!);
      const hop = handlers(await traceFor(port, "GET", path!))[0];
      expect(hop.location, path).toEqual({ file: "routes.cjs", line: lineOf(marker!) });
      expect(hop.location.file).not.toContain("node_modules");
    }
  });

  test("a hop opened after an await in an async handler nests under the handler hop", async () => {
    await request(port, "GET", "/async-db");
    const t = await traceFor(port, "GET", "/async-db");
    const [h] = handlers(t);
    expect(h.location.line).toBe(lineOf("asyncdb"));
    expect(t.spans.find((s: any) => s.name === "SELECT async")?.parentId).toBe(h.id);
  });

  test("next('route'): one hop per route dispatched, siblings, the template of the route that answered", async () => {
    await request(port, "GET", "/fall");
    const t = await traceFor(port, "GET", "/fall");
    const hs = handlers(t);
    expect(hs).toHaveLength(2);
    expect(hs[1].parentId).toBe(hs[0].parentId);
  });

  test("next(err): the hop ends once, failed, though both done(err) and 'finish' fire", async () => {
    await request(port, "GET", "/err");
    const t = await traceFor(port, "GET", "/err");
    expect(t.route).toBe("/err");
    const hs = handlers(t);
    expect(hs).toHaveLength(1);
    expect(hs[0].error?.message).toBe("passed");
    expect(t.status).toBe(500);
  });

  test("a handler that ends the response itself: one hop, no error", async () => {
    await request(port, "GET", "/ends");
    const t = await traceFor(port, "GET", "/ends");
    const hs = handlers(t);
    expect(hs).toHaveLength(1);
    expect(hs[0].error).toBeUndefined();
    expect(t.status).toBe(201);
  });

  test("404: no handler hop and no route template", async () => {
    await request(port, "GET", "/nope");
    const t = await traceFor(port, "GET", "/nope");
    expect(t.status).toBe(404);
    expect(handlers(t)).toHaveLength(0);
    expect(t.route).toBeUndefined();
  });

  test("an untraced request (HOPLENS_IGNORE) takes the original dispatch: no template on the request", async () => {
    const r = JSON.parse((await request(port, "GET", "/probe")).body);
    expect(r).toEqual({ traced: true, route: "/probe" });
    // Ignored paths never get a trace, so the dispatch patch must leave them alone.
    expect(JSON.parse((await request(port, "GET", "/probe-ignored")).body)).toEqual({ traced: false, route: null });
  });

  test("gate off: express is not patched at all", async () => {
    expect(JSON.parse((await request(plainPort, "GET", "/patched")).body)).toEqual({ dispatch: false, runtime: false });
    expect(JSON.parse((await request(port, "GET", "/patched")).body)).toEqual({ dispatch: true, runtime: true });
    expect(JSON.parse((await request(plainPort, "GET", "/probe")).body)).toEqual({ traced: false, route: null });
  });
});

// hoplens(app) from code: the app (and a route) exist before the patches go in.
const FROM_CODE = (index: string) => `
const express = require("express");
const app = express();
app.get("/early/:id", (req, res) => res.json({ id: req.params.id }));
const pre = express.Router({ mergeParams: true });
pre.get("/orders/:id", (req, res) => res.json({ uid: req.params.uid }));
app.use("/pre/:uid", pre);
// Built before the call, mounted after it (a router or sub-app required from its own module).
const built = express.Router({ mergeParams: true });
built.get("/orders/:id", (req, res) => res.json({ uid: req.params.uid }));
const builtSub = express();
builtSub.get("/stats", (req, res) => res.send("stats"));
require(${JSON.stringify(index)}).hoplens(app);
app.use("/built/:uid", built);
app.use("/admin", builtSub);
const r = express.Router();
r.get("/late/:id", (req, res) => res.json({ id: req.params.id })); // @late
app.use("/m/:k", r);
const sub = express();
sub.get("/s", (req, res) => res.send("s"));
app.use("/sub", sub);
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

describe.each(["express4", "express5"] as const)("hoplens(app) on %s", (alias) => {
  let fx: Fixture;
  let app: Child;
  let port: number;
  const src = FROM_CODE(INDEX);

  beforeAll(async () => {
    fx = makeFixture(alias, { "code.cjs": src });
    app = run(["code.cjs"], fx.root, childEnv({ HOPLENS_PORT: String(await freePort()) }));
    port = (await app.waitFor<{ ready: number }>("ready")).ready;
  });

  afterAll(async () => {
    await app?.kill();
    fx?.cleanup();
  });

  test("routes registered before and after the call get templates and handler hops", async () => {
    expect((await request(port, "GET", "/early/1")).body).toBe('{"id":"1"}');
    expect((await request(port, "GET", "/m/a/late/2")).body).toBe('{"id":"2"}');
    expect((await request(port, "GET", "/sub/s")).body).toBe("s");
    const early = await traceFor(port, "GET", "/early/1");
    expect(early.route).toBe("/early/:id");
    expect(handlers(early)).toHaveLength(1);
    const late = await traceFor(port, "GET", "/m/a/late/2");
    expect(late.route).toBe("/m/:k/late/:id");
    const line = src.split("\n").findIndex((l) => l.includes("// @late")) + 1;
    expect(handlers(late)[0].location).toEqual({ file: "code.cjs", line });
    expect((await traceFor(port, "GET", "/sub/s")).route).toBe("/sub/s");
  });

  test("a router or sub-app built before the call and mounted after it gets templates and handler hops", async () => {
    expect((await request(port, "GET", "/built/7/orders/9")).body).toBe('{"uid":"7"}');
    const t = await traceFor(port, "GET", "/built/7/orders/9");
    expect(t.route).toBe("/built/:uid/orders/:id");
    expect(handlers(t)).toHaveLength(1);
    expect((await request(port, "GET", "/admin/stats")).body).toBe("stats");
    const s = await traceFor(port, "GET", "/admin/stats");
    expect(s.route).toBe("/admin/stats");
    expect(handlers(s)).toHaveLength(1);
  });

  test("a router mounted before the call: mount param values never become part of the route", async () => {
    for (const uid of ["7", "acme"]) {
      expect((await request(port, "GET", `/pre/${uid}/orders/9`)).body).toBe(`{"uid":"${uid}"}`);
      expect((await traceFor(port, "GET", `/pre/${uid}/orders/9`)).route).toBe("/pre/:uid/orders/:id");
    }
  });
});

// hoplens(app, { root }) started from a directory where express does not resolve.
const ROOTED = `
const express = require("express");
const app = express();
require(${JSON.stringify(INDEX)}).hoplens(app, { root: __dirname });
app.get("/u/:id", (req, res) => res.json({ id: req.params.id }));
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

describe.each(["express4", "express5"] as const)("hoplens(app, { root }) on %s", (alias) => {
  let fx: Fixture;
  let elsewhere: Fixture;
  let app: Child;
  let port: number;

  beforeAll(async () => {
    fx = makeFixture(alias, { "rooted.cjs": ROOTED });
    elsewhere = makeFixture();
    app = run([`${fx.root}/rooted.cjs`], elsewhere.root, childEnv({ HOPLENS_PORT: String(await freePort()) }));
    port = (await app.waitFor<{ ready: number }>("ready")).ready;
  });

  afterAll(async () => {
    await app?.kill();
    fx?.cleanup();
    elsewhere?.cleanup();
  });

  test("express is patched from opts.root, not the cwd", async () => {
    expect((await request(port, "GET", "/u/1")).body).toBe('{"id":"1"}');
    const t = await traceFor(port, "GET", "/u/1");
    expect(t.route).toBe("/u/:id");
    expect(handlers(t)).toHaveLength(1);
  });
});
