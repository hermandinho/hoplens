// Request path P1 end to end: an example-like Express 5 ESM app (a products router whose handler
// calls an exported service twice) in child processes, preloaded with the built register hook.
// With HOPLENS_PATH=1, POST /__hoplens/api/traces/:id/path replays GET /api/products/1 once and
// returns the handler and findProduct lanes with their raw V8 block ranges, quality EXACT. Without
// the flag nothing of the inspector is loaded and the route answers 409 "path off"; under
// NODE_V8_COVERAGE the state is disabled-c8.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PATH_ON_LINE, pathBanner } from "../src/banner";
import { pathRequested } from "../src/gate";
import { type Fixture, REGISTER, childEnv, freePort, makeFixture, poll, run } from "./helpers";

const REGISTER_URL = pathToFileURL(REGISTER).href;

const SERVICE = `const ROWS = [{ id: 1, name: "Lamp", stock: 3 }, { id: 2, name: "Desk", stock: 0 }];

// A fake async query, like pool.query in the example app.
async function query(id) {
  await new Promise((r) => setTimeout(r, 2));
  return { rows: ROWS.filter((r) => r.id === id) };
}

/** One product by id, or null. */
export async function findProduct(id) {
  const { rows } = await query(id);
  return rows[0] ?? null;
}
`;

const ROUTES = `import { Router } from "express";
import { findProduct } from "../services/products.js";

export const products = Router();

products.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!(await findProduct(id))) {
    res.status(404).json({ error: "product not found", id });
    return;
  }
  const product = await findProduct(id);
  res.json({ ...product, inStock: product.stock > 0 });
});

products.post("/:id", (req, res) => res.json({ ok: true }));
`;

const SERVER = `import express from "express";
import { createRequire } from "node:module";
import { products } from "./routes/products.js";

const require = createRequire(import.meta.url);
/** What of the request path is loaded in this process. */
const probe = () => ({
  inspector: process.moduleLoadList.includes("NativeModule inspector"),
  coverageModule: Object.keys(require.cache).some((k) => /[\\\\/]core[\\\\/]dist[\\\\/]coverage\\.js$/.test(k)),
  coverage: globalThis[Symbol.for("hoplens.coverage")] !== undefined,
});
const app = express();
app.use("/api/products", products);
app.get("/probe", (_req, res) => res.json(probe()));
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port, probe: probe() })));
`;

interface Res {
  status: number;
  body: string;
}

function request(port: number, method: string, p: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const json = async (port: number, method: string, p: string) => {
  const r = await request(port, method, p);
  return { status: r.status, body: JSON.parse(r.body) };
};

/** The newest finished trace of `method path`. */
async function traceId(port: number, method: string, p: string): Promise<string> {
  const t = await poll(async () => {
    const list = (await json(port, "GET", "/__hoplens/api/traces")).body as any[];
    return list.find((x) => x.done && x.method === method && x.path === p);
  });
  return t.id;
}

interface Started {
  port: number;
  probe: Record<string, boolean>;
  stdout: () => string;
  kill: () => Promise<void>;
}

const started: Started[] = [];

async function start(env: Record<string, string | undefined>): Promise<Started> {
  const child = run(
    ["--import", REGISTER_URL, "src/server.js"],
    fx.root,
    childEnv({ HOPLENS_PORT: String(await freePort()), ...env }),
  );
  const ready = await child.waitFor<{ ready: number; probe: Record<string, boolean> }>("ready", 30000);
  const s = { port: ready.ready, probe: ready.probe, stdout: child.stdout, kill: child.kill };
  started.push(s);
  return s;
}

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture("express5", {
    "package.json": JSON.stringify({ name: "path-fixture", private: true, type: "module" }),
    "src/services/products.js": SERVICE,
    "src/routes/products.js": ROUTES,
    "src/server.js": SERVER,
  });
});
afterAll(async () => {
  await Promise.all(started.map((s) => s.kill()));
  fx?.cleanup();
});

describe("request path (HOPLENS_PATH=1)", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start({ HOPLENS_PATH: "1" });
  }, 40000);

  test("coverage started at boot; banner and meta say on", async () => {
    expect(s.probe).toMatchObject({ inspector: true, coverageModule: true, coverage: true });
    await poll(async () => (s.stdout().includes(PATH_ON_LINE) ? true : undefined));
    const meta = await json(s.port, "GET", "/__hoplens/api/meta");
    expect(meta.body.path).toEqual({ state: "on" });
  });

  test("POST path for GET /api/products/1: handler + findProduct lanes with block ranges, EXACT", async () => {
    // Warm the route first: the capture must hold even for code that already ran.
    for (let i = 0; i < 3; i++) expect((await request(s.port, "GET", "/api/products/1")).status).toBe(200);
    const id = await traceId(s.port, "GET", "/api/products/1");
    const r = await json(s.port, "POST", `/__hoplens/api/traces/${id}/path`);
    expect(r.status).toBe(200);
    const p = r.body.path;
    expect(r.body.traceId).toBe(p.traceId);
    expect(p.traceId).not.toBe(id);
    expect(p).toMatchObject({ v: 1, replayOf: id, quality: "exact", contamination: [] });
    expect(p.window.taint).toEqual([]);

    expect(p.lanes.map((l: any) => [l.kind, l.name, l.file, l.line, l.depth, l.truth])).toEqual([
      ["handler", "GET /api/products/:id", "src/routes/products.js", 6, 0, { t: "taken", n: 1 }],
      ["function", "findProduct", "src/services/products.js", 10, 1, { t: "taken", n: 2 }],
      ["function", "findProduct", "src/services/products.js", 10, 1, { t: "taken", n: 2 }],
    ]);

    const handler = p.functions[p.lanes[0].fnKey];
    expect(handler.calls).toEqual({ hops: 1, coverage: 1, checked: true });
    expect(handler.mapping).toBe("identity");
    expect(handler.blocks).toBe(true);
    // The whole handler ran once; the 404 branch (lines 8-11) never did.
    expect(handler.ranges[0]).toMatchObject({ count: 1, line: 6, endLine: 14 });
    const notFound = handler.ranges.find((x: any) => x.count === 0);
    expect(notFound).toMatchObject({ line: 8 });
    const src = fs.readFileSync(path.join(fx.root, "src/routes/products.js"), "utf8");
    expect(src.slice(notFound.start, notFound.end)).toContain(
      'res.status(404).json({ error: "product not found", id });',
    );

    const find = p.functions["src/services/products.js:10:findProduct"];
    expect(find).toMatchObject({ v8Name: "findProduct", blocks: true, startLine: 10, endLine: 13 });
    expect(find.calls).toEqual({ hops: 2, coverage: 2, checked: true });
    // `?? null` never ran: row 1 exists.
    const svc = fs.readFileSync(path.join(fx.root, "src/services/products.js"), "utf8");
    const nullRange = find.ranges.find((x: any) => x.count === 0);
    expect(svc.slice(nullRange.start, nullRange.end)).toMatch(/^(\?\? )?null$/);

    // GET serves the stored payload; the new trace is a path trace of the source.
    const again = await json(s.port, "GET", `/__hoplens/api/traces/${p.traceId}/path`);
    expect(again.status).toBe(200);
    expect(again.body.traceId).toBe(p.traceId);
    const trace = await json(s.port, "GET", `/__hoplens/api/traces/${p.traceId}`);
    expect(trace.body.pathTrace).toEqual({ quality: "exact", replayOf: id });
    expect((await json(s.port, "GET", `/__hoplens/api/traces/${id}/path`)).body.code).toBe("no-path");
    // The list summary carries the stamp too.
    const list = await json(s.port, "GET", "/__hoplens/api/traces");
    const row = (Array.isArray(list.body) ? list.body : list.body.traces).find((t: any) => t.id === p.traceId);
    expect(row.pathTrace).toEqual({ quality: "exact", replayOf: id });
  }, 30000);

  test("a POST source trace is refused with 400 and a reason", async () => {
    expect((await request(s.port, "POST", "/api/products/1")).status).toBe(200);
    const id = await traceId(s.port, "POST", "/api/products/1");
    const r = await json(s.port, "POST", `/__hoplens/api/traces/${id}/path`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("method");
    expect((await json(s.port, "POST", "/__hoplens/api/traces/tr_gone/path")).status).toBe(404);
  });
});

describe("request path off", () => {
  test("HOPLENS_PATH unset: no inspector, no coverage module, and the route answers 409 path off", async () => {
    const s = await start({});
    expect(s.probe).toEqual({ inspector: false, coverageModule: false, coverage: false });
    expect(s.stdout()).not.toContain("request path");
    expect((await request(s.port, "GET", "/api/products/1")).status).toBe(200);
    const id = await traceId(s.port, "GET", "/api/products/1");
    const r = await json(s.port, "POST", `/__hoplens/api/traces/${id}/path`);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "path-off", state: "off" });
    expect((await json(s.port, "GET", "/__hoplens/api/meta")).body.path.state).toBe("off");
    // Still nothing loaded after the runtime booted and answered.
    expect((await json(s.port, "GET", "/probe")).body).toEqual({
      inspector: false,
      coverageModule: false,
      coverage: false,
    });
  }, 40000);

  test("NODE_V8_COVERAGE set: disabled-c8, nothing started, 409 path off", async () => {
    const dump = path.join(fx.root, ".c8-dump");
    const s = await start({ HOPLENS_PATH: "1", NODE_V8_COVERAGE: dump });
    expect(s.probe).toMatchObject({ coverage: true, inspector: false });
    expect((await json(s.port, "GET", "/__hoplens/api/meta")).body.path.state).toBe("disabled-c8");
    await poll(async () => (s.stdout().includes("request path disabled: NODE_V8_COVERAGE") ? true : undefined));
    expect((await request(s.port, "GET", "/api/products/1")).status).toBe(200);
    const id = await traceId(s.port, "GET", "/api/products/1");
    const r = await json(s.port, "POST", `/__hoplens/api/traces/${id}/path`);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "path-off", state: "disabled-c8" });
  }, 40000);
});

describe("unit", () => {
  test("pathRequested reads HOPLENS_PATH=1|true only", () => {
    expect(pathRequested({})).toBe(false);
    expect(pathRequested({ HOPLENS_PATH: "0" })).toBe(false);
    expect(pathRequested({ HOPLENS_PATH: "1" })).toBe(true);
    expect(pathRequested({ HOPLENS_PATH: "TRUE" })).toBe(true);
  });

  test("pathBanner", () => {
    expect(pathBanner(undefined)).toBeUndefined();
    expect(pathBanner({ state: "on" })).toEqual({ info: PATH_ON_LINE });
    expect(pathBanner({ state: "disabled-c8" })?.note).toMatch(/NODE_V8_COVERAGE/);
    expect(pathBanner({ state: "error", reason: "boom" })?.note).toBe(
      "request path failed to start: boom; the app runs without it (unset HOPLENS_PATH to silence this)",
    );
    expect(pathBanner({ state: "off", reason: "worker thread" })?.note).toBe("request path off: worker thread");
  });
});
