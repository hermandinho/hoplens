// Epochs mode "restart": a watcher restarts the process on every save, so each Runtime start compares
// the sources with the manifest the previous one left (manifest.ts). These runtimes are never
// start()ed (that installs process-wide hooks): persistence is started directly, as persist.test does.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { epochsService } from "../src/api/epochs";
import { MANIFEST_FILE } from "../src/manifest";
import { Persister } from "../src/persist";
import { Runtime } from "../src/runtime";
import type { RouteInfo, TraceRecord } from "../src/types";
import { makeTrace, skeleton } from "./helpers";

let root: string;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const stateDir = () => path.join(root, "node_modules", ".cache", "hoplens");

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-restart-")));
  write("app.js", `const users = require("./routes/users");\nconst health = require("./routes/health");\n`);
  write(
    "routes/users.js",
    `const svc = require("../services/users");\nmodule.exports = (req, res) => res.json(svc.list());\n`,
  );
  write("routes/health.js", "module.exports = (req, res) => res.send('ok');\n");
  write("services/users.js", "exports.list = () => [1, 2, 3];\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// app.js registers "/" and requires every router; routes/users.js registers two templates.
const ROUTES = [
  { nextRoute: "/", file: "app.js", methods: [{ method: "GET", line: 3 }] },
  { nextRoute: "/api/users", file: "routes/users.js", methods: [{ method: "GET", line: 2 }] },
  { nextRoute: "/api/users/:id", file: "routes/users.js", methods: [{ method: "GET", line: 3 }] },
  { nextRoute: "/health", file: "routes/health.js", methods: [{ method: "GET", line: 1 }] },
] as unknown as RouteInfo[];

const runtimes: Runtime[] = [];
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.stop();
});

function make(mode: "restart" | "none" = "restart", typescript: () => unknown = () => ts): Runtime {
  const rt = new Runtime({
    options: { port: 0, basePath: "", distDir: "", root, persist: true, stateDir: stateDir() },
    discovery: { scan: () => ({ routes: ROUTES, typescript: false, scannedAt: 0 }) },
    epochs: { mode, typescript },
    persist: { flushMs: 0 },
  });
  runtimes.push(rt);
  (rt as any).startPersistence();
  return rt;
}

/** A new process: the previous one is gone (its rows flushed, as the 250ms timer does under a watcher). */
function restart(prev: Runtime | undefined, mode: "restart" | "none" = "restart"): Runtime {
  prev?.stop();
  return make(mode);
}

let seq = 0;
function finish(rt: Runtime, route: string, ms: number): TraceRecord {
  const { root: r, handler, fn } = skeleton(ms);
  const t = makeTrace([r, handler, fn], {
    id: `t${++seq}`,
    startedAt: 1_000_000 + seq,
    duration: ms,
    url: route,
    path: route,
    route,
  });
  const obs = rt.epochs.observe(`GET ${route}`, false);
  t.facts = {
    time: { db: 0, cache: 0, ext: 0, fn: ms - 4, framework: 1, compile: 0, idle: 0 },
    reqBytes: 0,
    resBytes: 0,
    counts: { spans: 3, db: 0, fetch: 0, cache: 0, fn: 1, warn: 0, error: 0 },
    cold: obs.firstInEpoch,
    compileMs: 0,
    droppedSpans: 0,
    epoch: obs.epoch,
  };
  const facts = t.facts;
  t.facts = undefined;
  t.done = false;
  rt.store.add(t, { rawHeaders: {} });
  t.facts = facts;
  rt.store.finish(t);
  return t;
}
const settle = () => new Promise((r) => setTimeout(r, 80)); // the store's finish timer fires "done"

describe("epochs mode restart", () => {
  test("first run: epoch 0 and a manifest; an edited service opens a restart epoch naming the file and its route", async () => {
    const a = make();
    expect(a.epochs.epoch).toBe(0);
    expect(fs.existsSync(path.join(stateDir(), MANIFEST_FILE))).toBe(true);
    // No build-output probe, chunk index or source watcher in-process.
    expect((a.epochs as any).chunks).toBeUndefined();
    expect((a.epochs as any).sources).toBeUndefined();
    for (const ms of [40, 10, 10, 10, 10, 10]) finish(a, "/api/users", ms);
    await settle();

    write("services/users.js", "exports.list = () => { for (let i = 0; i < 1e6; i++); return [1, 2, 3]; };\n");
    const b = restart(a);
    expect(b.epochs.epoch).toBe(1);
    const view = epochsService(b).list().items[0]!;
    expect(view).toMatchObject({
      id: 1,
      via: "restart",
      files: ["services/users.js"],
      deleted: [],
      // Both templates of the router file, not "/" of app.js (which only requires the router).
      routes: ["/api/users", "/api/users/:id"],
      routesVia: "imports",
    });
    expect(view.session).toBeUndefined();
    expect(view.rebuiltAt).toBeGreaterThan(0);

    // The first request after the restart is cold, like the first one after a rebuild.
    const first = finish(b, "/api/users", 90);
    expect(first.facts!.cold).toBe(true);
    for (let i = 0; i < 5; i++) finish(b, "/api/users", 60);
    await settle();
    const reg = epochsService(b).evaluate();
    const item = reg.items.find((r) => r.key === "GET /api/users" && r.epoch === 1);
    expect(item).toMatchObject({ status: "regressed", baselineEpoch: 0 });
    expect(item!.before!.n).toBe(5);
    expect(item!.after!.n).toBe(5);

    // The verdict survives the next process (persisted stats replayed across processes).
    const c = restart(b);
    expect(c.epochs.epoch).toBe(1); // nothing changed: same epoch
    const again = epochsService(c)
      .evaluate()
      .items.find((r) => r.key === "GET /api/users" && r.epoch === 1);
    expect(again).toMatchObject({ status: "regressed", baselineEpoch: 0 });
  });

  test("a whitespace- or comment-only save adds no epoch; the epoch goes on with its info", async () => {
    let rt = make();
    write("routes/health.js", "module.exports = (req, res) => res.send('a');\n");
    rt = restart(rt);
    expect(rt.epochs.epoch).toBe(1);
    write("routes/health.js", '// health check\nmodule.exports = (req, res) =>\n  res.send("a")\n');
    rt = restart(rt);
    expect(rt.epochs.epoch).toBe(1);
    const list = rt.epochs.list();
    expect(list.map((i) => [i.id, i.via])).toEqual([
      [0, "start"],
      [1, "restart"],
    ]);
    expect(list[1]!.files).toEqual(["routes/health.js"]);
    // The continued epoch: the first request of this process is still cold (a fresh process).
    expect(rt.epochs.observe("GET /health", false).firstInEpoch).toBe(true);
    // A real edit after it is epoch 2.
    write("routes/health.js", "module.exports = (req, res) => res.send('b');\n");
    rt = restart(rt);
    expect(rt.epochs.epoch).toBe(2);
    expect(epochsService(rt).list().items[0]).toMatchObject({ id: 2, routes: ["/health"] });
  });

  test("added and deleted files", () => {
    let rt = make();
    write("routes/new.js", "module.exports = 1;\n");
    fs.rmSync(path.join(root, "routes", "health.js"));
    rt = restart(rt);
    const info = rt.epochs.info(1)!;
    expect(info.files).toEqual(["routes/health.js", "routes/new.js"]);
    expect(info.deleted).toEqual(["routes/health.js"]);
  });

  test("a missing or corrupt manifest with persisted state: a new session epoch as before, and a fresh manifest", () => {
    let rt = make();
    finish(rt, "/health", 5);
    rt.stop();
    fs.writeFileSync(path.join(stateDir(), MANIFEST_FILE), "{ torn");
    rt = make();
    expect(rt.epochs.epoch).toBe(1);
    expect(rt.epochs.info(1)!.via).toBe("start");
    // Now a manifest exists again: no change -> same epoch.
    rt = restart(rt);
    expect(rt.epochs.epoch).toBe(1);
  });

  test("the manifest sits in the state dir and never lists it", () => {
    make();
    const m = JSON.parse(fs.readFileSync(path.join(stateDir(), MANIFEST_FILE), "utf8"));
    expect(Object.keys(m.files).sort()).toEqual(["app.js", "routes/health.js", "routes/users.js", "services/users.js"]);
  });

  test("an edit to app-level middleware maps to the routes of every router app.js mounts", () => {
    write(
      "app.js",
      `const auth = require("./middleware/auth");\nconst users = require("./routes/users");\nconst health = require("./routes/health");\n`,
    );
    write("middleware/auth.js", "module.exports = (req, res, next) => next();\n");
    let rt = make();
    write("middleware/auth.js", "module.exports = (req, res, next) => setTimeout(next, 50);\n");
    rt = restart(rt);
    expect(epochsService(rt).list().items[0]).toMatchObject({
      files: ["middleware/auth.js"],
      routes: ["/", "/api/users", "/api/users/:id", "/health"],
    });
    // A router's own helper still maps to that router alone.
    write("services/users.js", "exports.list = () => [];\n");
    rt = restart(rt);
    expect(epochsService(rt).list().items[0]).toMatchObject({ routes: ["/api/users", "/api/users/:id"] });
  });

  test("a restart with nothing changed leaves the manifest file alone", () => {
    let rt = make();
    const file = path.join(stateDir(), MANIFEST_FILE);
    const before = fs.readFileSync(file, "utf8");
    rt = restart(rt);
    rt = restart(rt);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("a failed flush of the epoch row leaves the old manifest, so the next start finds the edit again", () => {
    let rt = make();
    write("routes/health.js", "module.exports = (req, res) => res.send('b');\n");
    const fail = () => vi.spyOn(Persister.prototype, "flush").mockReturnValueOnce(false);
    rt.stop();
    let spy = fail();
    rt = make();
    spy.mockRestore();
    expect(rt.epochs.epoch).toBe(1);
    // That process dies before a later flush gets its rows out: the next one opens the edit again.
    (rt as any).persister.buffer = [];
    rt = restart(rt);
    expect(rt.epochs.epoch).toBe(1);
    expect(rt.epochs.info(1)).toMatchObject({ via: "restart", files: ["routes/health.js"] });
    // A failed first flush that a later one makes good writes the manifest then: no second epoch.
    write("routes/health.js", "module.exports = (req, res) => res.send('c');\n");
    rt.stop();
    spy = fail();
    rt = make();
    spy.mockRestore();
    expect(rt.epochs.epoch).toBe(2);
    rt = restart(rt);
    expect(rt.epochs.epoch).toBe(2);
  });

  test("mode none is unchanged: every process is a new epoch, no manifest", () => {
    let rt = make("none");
    rt = restart(rt, "none");
    expect(rt.epochs.epoch).toBe(1);
    expect(rt.epochs.info(1)!.via).toBe("start");
    expect(fs.existsSync(path.join(stateDir(), MANIFEST_FILE))).toBe(false);
  });
});

describe("samePortRetryMs", () => {
  const hold = async (): Promise<{ server: http.Server; port: number }> => {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, port: (server.address() as AddressInfo).port };
  };
  const ui = (port: number, samePortRetryMs?: number) =>
    new Promise<Runtime>((resolve) => {
      const rt = new Runtime({
        options: { port, basePath: "", distDir: "", root, persist: false },
        discovery: { scan: () => ({ routes: [], typescript: false, scannedAt: 0 }) },
        epochs: { mode: "restart" },
        samePortRetryMs,
        banner: (r) => resolve(r),
      });
      runtimes.push(rt);
      (rt as any).listen(port, 0, Date.now());
    });

  test("waits for the configured port while the previous process still holds it", async () => {
    const { server, port } = await hold();
    setTimeout(() => server.close(), 300);
    const rt = await ui(port, 1000);
    expect(rt.uiPort).toBe(port);
  });

  test("moves up once the wait is over, and at once without it", async () => {
    const a = await hold();
    try {
      const t0 = Date.now();
      const waited = await ui(a.port, 200);
      expect(waited.uiPort).not.toBe(a.port);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
      const t1 = Date.now();
      const plain = await ui(a.port);
      expect(plain.uiPort).not.toBe(a.port);
      expect(Date.now() - t1).toBeLessThan(150);
    } finally {
      a.server.close();
    }
  });
});
