// Edits across restarts: an app under `node --watch` restarts on every save, and each new process
// compares the sources with the manifest the previous one left (core epochs mode "restart").
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Child, type Fixture, REGISTER, childEnv, freePort, makeFixture, poll, run } from "./helpers";

let fx: Fixture;
let child: Child | undefined;
const pids = new Set<number>();

const service = (delay: number, extra = "") => `${extra}exports.DELAY = ${delay};\nexports.list = () => [1, 2, 3];\n`;

beforeAll(() => {
  fx = makeFixture("express5", {
    "app.cjs": `
      const express = require("express");
      const app = express();
      app.use("/api", require("./routes/users.cjs"));
      app.use(require("./routes/meta.cjs"));
      app.listen(Number(process.env.APP_PORT), "127.0.0.1");
    `,
    "routes/users.cjs": `
      const express = require("express");
      const svc = require("../services/users.cjs");
      const r = express.Router();
      r.get("/users", (req, res) => setTimeout(() => res.json(svc.list()), svc.DELAY));
      module.exports = r;
    `,
    "routes/meta.cjs": `
      const express = require("express");
      const r = express.Router();
      r.get("/pid", (req, res) => res.json({ pid: process.pid }));
      module.exports = r;
    `,
    "services/users.cjs": service(1),
  });
});
afterAll(async () => {
  await child?.kill();
  // On Windows killing the watcher can leave its app process behind, holding both ports.
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
  }
  fx.cleanup();
});

function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}
const json = async (port: number, p: string) => JSON.parse((await get(port, p)).body);

/** The app's pid once a process other than `not` answers. */
async function appPid(port: number, not?: number): Promise<number> {
  return poll(async () => {
    const { pid } = await json(port, "/pid");
    if (typeof pid !== "number" || pid === not) return undefined;
    pids.add(pid);
    return pid;
  }, 20000);
}

async function traffic(port: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) expect((await get(port, "/api/users")).status).toBe(200);
  // The store's finish timer, then the 250ms persist flush (a watcher kills the process unannounced).
  await new Promise((r) => setTimeout(r, 900));
}

/** The standalone UI ports the banners of every process printed so far. */
const bannerPorts = (out: string) => [...out.matchAll(/also http:\/\/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]));

test("node --watch: a saved edit is a restart epoch naming the file and route, with a verdict; a whitespace save is none", async () => {
  const appPort = await freePort();
  const uiPort = await freePort();
  child = run(
    ["--watch", "-r", REGISTER, "app.cjs"],
    fx.root,
    childEnv({ APP_PORT: String(appPort), HOPLENS_PORT: String(uiPort) }),
  );
  const pid1 = await appPid(appPort);
  const e0 = await json(appPort, "/__hoplens/api/epochs");
  expect(e0.items.map((i: any) => i.via)).toEqual(["start"]);
  await traffic(appPort, 7);

  // A real edit: node --watch restarts the app.
  fs.writeFileSync(path.join(fx.root, "services", "users.cjs"), service(40));
  const pid2 = await appPid(appPort, pid1);
  const e1 = await json(appPort, "/__hoplens/api/epochs");
  const edit = e1.items[0];
  expect(edit).toMatchObject({
    id: e0.epoch + 1,
    via: "restart",
    files: ["services/users.cjs"],
    routes: ["/api/users"],
    routesVia: "imports",
  });
  expect(edit.session).toBeUndefined();

  await traffic(appPort, 7);
  const reg = await json(appPort, `/__hoplens/api/regressions?epoch=${edit.id}`);
  const v = reg.items.find((r: any) => r.key === "GET /api/users");
  expect(v).toMatchObject({ status: "regressed", baselineEpoch: e0.epoch });
  expect(v.before.n).toBeGreaterThanOrEqual(3);
  expect(v.after.n).toBeGreaterThanOrEqual(3);

  // Whitespace and a comment only: the app restarts, but no new epoch.
  fs.writeFileSync(path.join(fx.root, "services", "users.cjs"), service(40, "// tuned\n\n").replace(" = ", "  =  "));
  const pid3 = await appPid(appPort, pid2);
  const e2 = await json(appPort, "/__hoplens/api/epochs");
  expect(e2.epoch).toBe(edit.id);
  expect(e2.items.filter((i: any) => i.via === "restart").map((i: any) => i.id)).toEqual([edit.id]);
  expect(pid3).not.toBe(pid2);

  // The standalone UI stayed on its port across both restarts.
  expect((await get(uiPort, "/api/meta")).status).toBe(200);
  await poll(async () => (bannerPorts(child!.stdout()).length >= 3 ? true : undefined), 5000);
  expect(new Set(bannerPorts(child.stdout()))).toEqual(new Set([uiPort]));
}, 90000);

/**
 * Preloaded before the register hook: reports each UI listen and each listen error on HOPLENS_PORT
 * (and the 9 above it) as a JSON stdout line, written synchronously, and on the first EADDRINUSE
 * freezes the process until the test creates PROBE_RELEASE. The UI's same-port window
 * (samePortRetryMs, 1s of wall clock from its first try) is then not raced by the test's own
 * scheduling: under a loaded CPU the test used to learn of the app's listen by HTTP polling, sleep
 * 300ms and only then free the port, by when the window could have closed and the UI moved up a
 * port. The freeze runs after core's error handler scheduled its retry (core adds its once("error")
 * before listen, this one is added at listen), so what follows the release is core's own retry.
 */
const PORT_PROBE = `
  const fs = require("fs");
  const net = require("net");
  const uiPort = Number(process.env.HOPLENS_PORT);
  const say = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");
  let frozen = false;
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const port = typeof args[0] === "number" ? args[0] : args[0] && args[0].port;
    if (port >= uiPort && port < uiPort + 10) {
      say({ probeListen: port });
      this.once("error", (err) => {
        say({ probeError: port, code: err.code });
        if (frozen || err.code !== "EADDRINUSE") return;
        frozen = true;
        const cell = new Int32Array(new SharedArrayBuffer(4));
        const until = Date.now() + 60000;
        while (!fs.existsSync(process.env.PROBE_RELEASE) && Date.now() < until) Atomics.wait(cell, 0, 0, 10);
        say({ probeReleased: port });
      });
    }
    return listen.apply(this, args);
  };
`;

/** Every JSON stdout line of a child that has `key`. */
const jsonLines = (out: string, key: string): any[] =>
  out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((v) => v && key in v);

test("the UI waits for its port while the previous process still holds it", async () => {
  fs.writeFileSync(path.join(fx.root, "port-probe.cjs"), PORT_PROBE);
  const release = path.join(fx.root, "port-probe.release");
  fs.rmSync(release, { force: true });
  const appPort = await freePort();
  const uiPort = await freePort();
  // Stands in for the old process of a restart, still closing the UI port.
  const holder = http.createServer();
  await new Promise<void>((r) => holder.listen(uiPort, "127.0.0.1", () => r()));
  const c = run(
    ["-r", "./port-probe.cjs", "-r", REGISTER, "app.cjs"],
    fx.root,
    childEnv({ APP_PORT: String(appPort), HOPLENS_PORT: String(uiPort), PROBE_RELEASE: release }),
  );
  try {
    // The UI tried its port at the app's listen and found it held: no banner, nothing else tried.
    const busy = await c.waitFor("probeError", 20000);
    expect(busy).toEqual({ probeError: uiPort, code: "EADDRINUSE" });
    expect(bannerPorts(c.stdout())).toEqual([]);
    expect(jsonLines(c.stdout(), "probeListen").map((l) => l.probeListen)).toEqual([uiPort]);
    // The old process lets go; the UI's next try of the same port takes it.
    await new Promise<void>((r) => holder.close(() => r()));
    fs.writeFileSync(release, "");
    const ports = await poll(async () => {
      const p = bannerPorts(c.stdout());
      return p.length ? p : undefined;
    }, 20000);
    expect(ports).toEqual([uiPort]);
    // It retried its own port after the busy try, never one further up.
    const tried = jsonLines(c.stdout(), "probeListen").map((l) => l.probeListen);
    expect(tried.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tried)).toEqual(new Set([uiPort]));
    expect((await get(uiPort, "/api/meta")).status).toBe(200);
    pids.add(await appPid(appPort));
  } finally {
    await c.kill();
    holder.close();
  }
}, 60000);
