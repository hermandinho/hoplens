// Runtime.start() with a UI port listen() rejects synchronously, and the http hook once the runtime
// is stopped. Own file: start() installs process-wide hooks bound to this one runtime.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, expect, test } from "vitest";
import { Runtime } from "../src/runtime";

const servers: http.Server[] = [];
let rt: Runtime | undefined;
afterAll(async () => {
  rt?.stop();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function get(path: string): Promise<{ status: number; body: string }> {
  const server = http.createServer((_req, res) => res.end("app"));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return { status: r.status, body: await r.text() };
}

test("an invalid UI port is reported through the banner, not thrown out of start()", async () => {
  let banners = 0;
  rt = new Runtime({
    options: { port: 99999, basePath: "", distDir: "", root: process.cwd(), persist: false },
    discovery: { scan: () => ({ routes: [], typescript: false, scannedAt: 0 }) },
    epochs: { mode: "none" },
    banner: () => {
      banners++;
    },
  });
  expect(() => rt!.start()).not.toThrow();
  expect(banners).toBe(1);
  expect(rt.uiPort).toBeUndefined();
  // Running: the app port's /__hoplens is the runtime's.
  expect((await get("/__hoplens/api/meta")).body).not.toBe("app");

  rt.stop();
  // Stopped: the hook passes requests through, /__hoplens included, and traces nothing new.
  const before = rt.store.list().length;
  expect(await get("/__hoplens/api/meta")).toEqual({ status: 200, body: "app" });
  expect(await get("/hello")).toEqual({ status: 200, body: "app" });
  expect(rt.store.list().length).toBe(before);
});
