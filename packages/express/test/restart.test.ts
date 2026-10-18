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

test("the UI waits for its port while the previous process still holds it", async () => {
  const appPort = await freePort();
  const uiPort = await freePort();
  // Stands in for the old process of a restart, still closing the UI port.
  const holder = http.createServer();
  await new Promise<void>((r) => holder.listen(uiPort, "127.0.0.1", () => r()));
  const c = run(
    ["-r", REGISTER, "app.cjs"],
    fx.root,
    childEnv({ APP_PORT: String(appPort), HOPLENS_PORT: String(uiPort) }),
  );
  try {
    // The UI tried its port when the app started listening, just before this answers.
    pids.add(await appPid(appPort));
    await new Promise((r) => setTimeout(r, 300));
    expect(bannerPorts(c.stdout())).toEqual([]);
    holder.close();
    const ports = await poll(async () => {
      const p = bannerPorts(c.stdout());
      return p.length ? p : undefined;
    }, 10000);
    expect(ports).toEqual([uiPort]);
  } finally {
    await c.kill();
    holder.close();
  }
}, 30000);
