// The request path's sticky switch through core: POST /api/path/enable|disable drive the adapter's
// PathControl (RuntimeConfig.path.control) and answer meta.path with `source` and `pending`.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { trustedCaller } from "../src/api/guard";
import { sendJson } from "../src/api/module";
import { type PathControl, pathMeta } from "../src/path/capture";
import type { Runtime } from "../src/runtime";
import { handleUi } from "../src/server";

/** A control over an in-memory flag, booted `on` from `source`. */
function memoryControl(source: PathControl["source"], on: boolean, fail = false) {
  let flag = on && source === "flag";
  return {
    get flag() {
      return flag;
    },
    source,
    pending: () => (source === "env" || flag === on ? undefined : flag ? "on" : "off"),
    enable() {
      if (fail) throw new Error("EACCES: permission denied");
      flag = true;
    },
    disable() {
      if (fail) throw new Error("EACCES: permission denied");
      flag = false;
    },
  } satisfies PathControl & { flag: boolean };
}

let rt: { options: Record<string, unknown>; pathControl?: PathControl };
let server: http.Server;
let base: string;

beforeAll(async () => {
  rt = { options: {} };
  server = http.createServer((req, res) => {
    handleUi(rt as unknown as Runtime, req, res).catch((err) => sendJson(res, 500, { error: String(err) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__hoplens`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = async (p: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe("POST /api/path/enable|disable", () => {
  test("no control (a custom adapter): 409 unsupported, pointing at HOPLENS_PATH", async () => {
    rt.pathControl = undefined;
    const r = await post("/api/path/enable");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "unsupported" });
    expect(r.body.error).toMatch(/HOPLENS_PATH=1/);
    expect(r.body.error).not.toMatch(/Express only/);
  });

  test("source env: 409, the env var wins; nothing written", async () => {
    const c = memoryControl("env", false);
    rt.pathControl = c;
    const r = await post("/api/path/enable");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("env");
    expect(r.body.error).toMatch(/always wins/);
    expect(c.flag).toBe(false);
  });

  test("default off: enable -> pending on; disable -> no pending", async () => {
    const c = memoryControl("default", false);
    rt.pathControl = c;
    const on = await post("/api/path/enable");
    expect(on.status).toBe(200);
    expect(on.body.path).toMatchObject({ state: "off", source: "default", pending: "on" });
    expect(c.flag).toBe(true);
    const off = await post("/api/path/disable");
    expect(off.status).toBe(200);
    expect(off.body.path.pending).toBeUndefined();
    expect(c.flag).toBe(false);
  });

  test("on via flag: disable -> pending off", async () => {
    rt.pathControl = memoryControl("flag", true);
    const r = await post("/api/path/disable");
    expect(r.body.path).toMatchObject({ source: "flag", pending: "off" });
  });

  test("a write error is a 500 write-failed with the reason", async () => {
    rt.pathControl = memoryControl("default", false, true);
    const r = await post("/api/path/enable");
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "write-failed" });
    expect(r.body.error).toMatch(/EACCES/);
  });

  test("a foreign Origin is refused (403), a local one is not", async () => {
    const c = memoryControl("default", false);
    rt.pathControl = c;
    expect((await post("/api/path/enable", { origin: "https://evil.example" })).status).toBe(403);
    expect(c.flag).toBe(false);
    expect((await post("/api/path/enable", { origin: "http://localhost:5173" })).status).toBe(200);
    expect(c.flag).toBe(true);
  });

  test("GET /api/meta carries source and pending", async () => {
    const c = memoryControl("default", false);
    rt.pathControl = c;
    c.enable();
    const meta = (await (await fetch(`${base}/api/meta`)).json()) as any;
    expect(meta.path).toMatchObject({ state: "off", source: "default", pending: "on" });
  });
});

describe("trustedCaller", () => {
  const req = (remoteAddress: string, headers: Record<string, unknown> = {}) => ({
    socket: { remoteAddress },
    headers: { host: "127.0.0.1:4983", ...headers },
  });
  test("loopback only, even with allowRemote; Origin same-host or local", () => {
    expect(trustedCaller(req("127.0.0.1"))).toBe(true);
    expect(trustedCaller(req("::1"))).toBe(true);
    expect(trustedCaller(req("10.0.0.2"))).toBe(false);
    expect(trustedCaller(req("127.0.0.1", { origin: "http://127.0.0.1:4983" }))).toBe(true);
    expect(trustedCaller(req("127.0.0.1", { origin: "http://localhost:3000" }))).toBe(true);
    expect(trustedCaller(req("127.0.0.1", { origin: "null" }))).toBe(false);
    expect(trustedCaller(req("127.0.0.1", { origin: "https://evil.example" }))).toBe(false);
  });
  test("DNS rebinding: a non-local Host is refused even when Origin matches it", () => {
    const rebound = { host: "attacker.example:4870" };
    expect(trustedCaller(req("127.0.0.1", { ...rebound, origin: "http://attacker.example:4870" }))).toBe(false);
    expect(trustedCaller(req("127.0.0.1", rebound))).toBe(false);
    expect(trustedCaller(req("127.0.0.1", { host: "localhost:4870", origin: "http://localhost:4870" }))).toBe(true);
    expect(trustedCaller(req("::1", { host: "[::1]:4870", origin: "http://[::1]:4870" }))).toBe(true);
  });
});

describe("pathMeta source / pending", () => {
  test("without a control: env when HOPLENS_PATH is set, else default", () => {
    expect(pathMeta(undefined, {}).source).toBe("default");
    expect(pathMeta(undefined, { HOPLENS_PATH: "1" }).source).toBe("env");
    expect(pathMeta(undefined, { HOPLENS_PATH: "0" })).toMatchObject({ source: "env" });
  });

  test("with a control: its source; off reasons per source", () => {
    expect(pathMeta(undefined, {}, memoryControl("default", false))).toEqual({
      state: "off",
      source: "default",
      reason: "enable it here, or restart with HOPLENS_PATH=1",
    });
    expect(pathMeta(undefined, { HOPLENS_PATH: "0" }, memoryControl("env", false)).reason).toBe(
      "HOPLENS_PATH=0 turns it off",
    );
    expect(pathMeta(undefined, {}, memoryControl("flag", true)).reason).toMatch(/load the register hook/);
    expect(pathMeta({ state: "on", take: () => undefined }, {}, memoryControl("flag", true))).toEqual({
      state: "on",
      source: "flag",
    });
  });

  test("a control whose pending throws still answers", () => {
    const c = {
      ...memoryControl("default", false),
      pending: () => {
        throw new Error("x");
      },
    };
    expect(pathMeta(undefined, {}, c).pending).toBeUndefined();
  });
});
