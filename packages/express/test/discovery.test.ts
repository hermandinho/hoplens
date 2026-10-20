// M3 end to end: route discovery (GET /__hoplens/api/routes) on Express 4 and 5 through the built
// register hook, and from hoplens(app). Every listed route must carry the template its traces get
// (RouteInfo.nextRoute === TraceRecord.route), its methods and the line that registered it.
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
const app = express();

app.get("/plain", (req, res) => res.send("plain")); // @plain
app.get("/items/:id", (req, res) => res.json({ id: req.params.id })); // @items
app.route("/x").get((req, res) => res.send("get x")).post((req, res) => res.send("post x")); // @x
app.get("/y", (req, res) => res.send("get y")); // @yget
app.put("/y", (req, res) => res.send("put y")); // @yput
app.all("/any", (req, res) => res.send("any")); // @any

const orders = express.Router({ mergeParams: true });
orders.get("/orders/:id", (req, res) => res.json({ uid: req.params.uid })); // @orders
orders.delete("/orders/:id", (req, res) => res.status(204).end()); // @ordersdel
app.use("/api/users/:uid", orders);

const shared = express.Router();
shared.get("/ping/:n", (req, res) => res.send("pong")); // @ping
app.use(["/v1", "/v2/:tenant"], shared);

const admin = express();
admin.get("/stats", (req, res) => res.send("stats")); // @admin
const deep = express();
deep.patch("/inner/:k", (req, res) => res.send("inner")); // @inner
admin.use("/deep", deep);
app.use("/admin", admin);

if (V5) {
  app.get("/files/*splat", (req, res) => res.send("file")); // @files
  app.get("/opt{/:maybe}", (req, res) => res.send("opt")); // @opt
} else {
  app.get("/files/:splat+", (req, res) => res.send("file")); // @files4
  app.get("/opt/:maybe?", (req, res) => res.send("opt")); // @opt4
}
app.get(/^\\/re\\/(\\d+)$/, (req, res) => res.send("re")); // @re

// Registers a route while handling a request: listed on the next scan.
app.post("/add", (req, res) => {
  app.get("/late/:id", (q, r) => r.send("late")); // @late
  res.send("added");
});

const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

function lineOf(src: string, marker: string): number {
  return src.split("\n").findIndex((l) => l.includes(`// @${marker}`)) + 1;
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

async function routes(port: number): Promise<any> {
  return JSON.parse((await request(port, "GET", "/__hoplens/api/routes?fresh")).body);
}

async function traceFor(port: number, method: string, path: string): Promise<any> {
  const summary = await poll(async () => {
    const list = JSON.parse((await request(port, "GET", "/__hoplens/api/traces")).body) as any[];
    return list.find((t) => t.done && t.method === method && t.url === path);
  });
  return JSON.parse((await request(port, "GET", `/__hoplens/api/traces/${summary.id}`)).body);
}

/** [template, method, marker, a concrete URL] for every fixture route. */
function expected(v5: boolean): Array<[string, string, string, string]> {
  return [
    ["/plain", "GET", "plain", "/plain"],
    ["/items/:id", "GET", "items", "/items/42"],
    ["/x", "GET", "x", "/x"],
    ["/x", "POST", "x", "/x"],
    ["/y", "GET", "yget", "/y"],
    ["/y", "PUT", "yput", "/y"],
    ["/any", "ANY", "any", "/any"],
    ["/api/users/:uid/orders/:id", "GET", "orders", "/api/users/7/orders/9"],
    ["/api/users/:uid/orders/:id", "DELETE", "ordersdel", "/api/users/7/orders/9"],
    ["/v1/ping/:n", "GET", "ping", "/v1/ping/1"],
    ["/v2/:tenant/ping/:n", "GET", "ping", "/v2/acme/ping/2"],
    ["/admin/stats", "GET", "admin", "/admin/stats"],
    ["/admin/deep/inner/:k", "PATCH", "inner", "/admin/deep/inner/3"],
    ["/files/:splat+", "GET", v5 ? "files" : "files4", "/files/a/b.txt"],
    ["/opt/:maybe?", "GET", v5 ? "opt" : "opt4", "/opt/yes"],
    ["/^\\/re\\/(\\d+)$/", "GET", "re", "/re/123"],
    ["/add", "POST", "", "/add"],
  ];
}

describe.each([
  ["express4", "-r"],
  ["express5", "--import"],
] as const)("discovery on %s (%s register)", (alias: ExpressAlias, flag) => {
  const v5 = alias === "express5";
  let fx: Fixture;
  let app: Child;
  let port: number;

  beforeAll(async () => {
    fx = makeFixture(alias, { "disc.cjs": APP });
    const register = flag === "--import" ? pathToFileURL(REGISTER).href : REGISTER;
    app = run([flag, register, "disc.cjs"], fx.root, childEnv({ HOPLENS_PORT: String(await freePort()) }));
    port = (await app.waitFor<{ ready: number }>("ready")).ready;
  });

  afterAll(async () => {
    await app?.kill();
    fx?.cleanup();
  });

  test("lists every route before any request: full templates, methods, registration lines", async () => {
    const d = await routes(port);
    expect(d.typescript).toBe(false);
    expect(typeof d.scannedAt).toBe("number");
    for (const [template, method, marker] of expected(v5)) {
      const r = d.routes.find((x: any) => x.nextRoute === template);
      expect(r, template).toBeDefined();
      expect(r.router).toBe("express");
      expect(r.file, template).toBe("disc.cjs");
      const m = r.methods.find((x: any) => x.method === method);
      expect(m, `${method} ${template}`).toBeDefined();
      if (marker) expect(m.line, `${method} ${template}`).toBe(lineOf(APP, marker));
      expect(m.schemas).toEqual([]);
      expect(m.readsBody).toBe(["POST", "PUT", "PATCH"].includes(method));
    }
    // One entry per template; ids unique and usable as the builder's `${id}::${method}` key.
    const templates = d.routes.map((r: any) => r.nextRoute);
    expect(new Set(templates).size).toBe(templates.length);
    const ids = d.routes.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toContain("::");
    expect(d.routes.find((r: any) => r.nextRoute === "/x").methods.map((m: any) => m.method)).toEqual(["GET", "POST"]);
    expect(d.routes.find((r: any) => r.nextRoute === "/late/:id")).toBeUndefined();
  });

  test("path and params are in the builder's notation", async () => {
    const d = await routes(port);
    const by = (t: string) => d.routes.find((r: any) => r.nextRoute === t);
    expect(by("/api/users/:uid/orders/:id").path).toBe("/api/users/:uid/orders/:id");
    expect(by("/api/users/:uid/orders/:id").params).toEqual([
      { name: "uid", catchAll: false, optional: false },
      { name: "id", catchAll: false, optional: false },
    ]);
    expect(by("/opt/:maybe?").path).toBe("/opt/:maybe*");
    expect(by("/opt/:maybe?").params).toEqual([{ name: "maybe", catchAll: false, optional: true }]);
    expect(by("/files/:splat+").params).toEqual([{ name: "splat", catchAll: true, optional: false }]);
    const re = by("/^\\/re\\/(\\d+)$/");
    expect(re.path).toBe(re.nextRoute);
    expect(re.params).toEqual([]);
  });

  test("every listed route's template is the one its traces carry", async () => {
    const d = await routes(port);
    for (const [template, method, , url] of expected(v5)) {
      const verb = method === "ANY" ? "GET" : method;
      await request(port, verb, url);
      const t = await traceFor(port, verb, url);
      expect(t.route, `${verb} ${url}`).toBe(template);
      expect(d.routes.some((r: any) => r.nextRoute === t.route)).toBe(true);
      expect(t.routeFile).toBe("disc.cjs");
    }
  });

  test("a route registered after the first request is listed on the next scan", async () => {
    expect((await request(port, "POST", "/add")).body).toBe("added");
    const d = await routes(port);
    const late = d.routes.find((r: any) => r.nextRoute === "/late/:id");
    expect(late?.methods).toEqual([{ method: "GET", line: lineOf(APP, "late"), schemas: [], readsBody: false }]);
    await request(port, "GET", "/late/5");
    expect((await traceFor(port, "GET", "/late/5")).route).toBe("/late/:id");
  });

  test("HEAD and OPTIONS answered by Express itself add no routes or methods", async () => {
    expect((await request(port, "HEAD", "/plain")).status).toBe(200);
    expect((await request(port, "OPTIONS", "/y")).status).toBe(200);
    await traceFor(port, "HEAD", "/plain");
    const d = await routes(port);
    expect(d.routes.filter((r: any) => r.nextRoute === "/plain")).toHaveLength(1);
    expect(d.routes.find((r: any) => r.nextRoute === "/plain").methods.map((m: any) => m.method)).toEqual(["GET"]);
    expect(d.routes.find((r: any) => r.nextRoute === "/y").methods.map((m: any) => m.method)).toEqual(["GET", "PUT"]);
    for (const r of d.routes) for (const m of r.methods) expect(["HEAD", "OPTIONS"]).not.toContain(m.method);
    expect(app.stderr()).not.toContain("hoplens:express");
  });
});

// hoplens(app) from code, no register hook: the app and some routes exist before the call.
const FROM_CODE = (index: string) => `
const express = require("express");
const app = express();
app.get("/early/:id", (req, res) => res.send("early"));
const pre = express.Router({ mergeParams: true });
pre.get("/orders/:id", (req, res) => res.send("pre"));
app.use("/pre/:uid", pre);
// A sub-app built before the call (its own module, say) and mounted after it.
const builtSub = express();
builtSub.get("/stats", (req, res) => res.send("stats"));
require(${JSON.stringify(index)}).hoplens(app);
app.use("/admin", builtSub);
app.get("/after/:id", (req, res) => res.send("after")); // @after
const sub = express();
sub.post("/s", (req, res) => res.send("s")); // @sub
app.use("/sub", sub);
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

describe.each(["express4", "express5"] as const)("discovery from hoplens(app) on %s", (alias) => {
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

  test("the adopted app is walked: routes registered after the call, with their lines", async () => {
    const d = await routes(port);
    const after = d.routes.find((r: any) => r.nextRoute === "/after/:id");
    expect(after?.file).toBe("code.cjs");
    expect(after?.methods[0]).toMatchObject({ method: "GET", line: lineOf(src, "after") });
    const sub = d.routes.find((r: any) => r.nextRoute === "/sub/s");
    expect(sub?.methods[0]).toMatchObject({ method: "POST", line: lineOf(src, "sub"), readsBody: true });
    // Registered before the call: listed with no file (no call site was recorded).
    const early = d.routes.find((r: any) => r.nextRoute === "/early/:id");
    expect(early?.file).toBe("");
    expect(early?.methods[0]?.method).toBe("GET");
    // A sub-app built before the call and mounted after it: listed before any request reaches it.
    const stats = d.routes.find((r: any) => r.nextRoute === "/admin/stats");
    expect(stats?.methods.map((m: any) => m.method)).toEqual(["GET"]);
  });

  test("a route under a mount the walk could not see is listed once a request reached it", async () => {
    await request(port, "GET", "/pre/7/orders/9");
    const t = await traceFor(port, "GET", "/pre/7/orders/9");
    expect(t.route).toBe("/pre/:uid/orders/:id");
    // No registration file: no route file and no made-up handler location.
    expect(t.routeFile).toBeUndefined();
    const d = await routes(port);
    const pre = d.routes.filter((r: any) => r.nextRoute === "/pre/:uid/orders/:id");
    expect(pre).toHaveLength(1);
    expect(pre[0].methods.map((m: any) => m.method)).toEqual(["GET"]);
  });
});

// hoplens(app) on an app with no router yet: the router built after the first scan is still walked.
const BARE = (index: string) => `
const express = require("express");
const app = express();
require(${JSON.stringify(index)}).hoplens(app);
const server = app.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: server.address().port }));
  process.stdin.resume();
  process.stdin.once("data", () => {
    app.get("/later/:id", (req, res) => res.send("later"));
    console.log(JSON.stringify({ added: true }));
  });
});
`;

describe.each(["express4", "express5"] as const)("discovery of a router built after the first scan on %s", (alias) => {
  let fx: Fixture;
  let app: Child;
  let port: number;

  beforeAll(async () => {
    fx = makeFixture(alias, { "bare.cjs": BARE(INDEX) });
    app = run(["bare.cjs"], fx.root, childEnv({ HOPLENS_PORT: String(await freePort()) }), true);
    port = (await app.waitFor<{ ready: number }>("ready")).ready;
  });

  afterAll(async () => {
    await app?.kill();
    fx?.cleanup();
  });

  test("routes registered after a scan saw no router are listed on the next scan", async () => {
    expect((await routes(port)).routes).toEqual([]);
    app.proc.stdin!.write("go\n");
    await app.waitFor("added");
    const d = await routes(port);
    expect(d.routes.map((r: any) => r.nextRoute)).toEqual(["/later/:id"]);
  });
});
