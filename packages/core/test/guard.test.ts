// The UI API guard (api/guard.ts): Host / Origin / forwarded host / content type, and proof that
// every mounted route sits behind it (handleUi runs it before routing).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type GuardRequest,
  bodyRefusal,
  guardRequest,
  loopbackAddress,
  loopbackAuthority,
  loopbackOrigin,
  trustedCaller,
} from "../src/api/guard";
import { sendJson } from "../src/api/module";
import type { Runtime } from "../src/runtime";
import { handleUi, mountApi, routeTable } from "../src/server";

const req = (headers: Record<string, unknown>, extra: Partial<GuardRequest> = {}): GuardRequest => ({
  method: "GET",
  socket: { remoteAddress: "127.0.0.1", localPort: 4983 },
  headers,
  ...extra,
});

describe("loopbackAuthority (Host)", () => {
  test.each([
    "localhost",
    "localhost:3000",
    "LOCALHOST:3000",
    "LocalHost",
    "localhost.",
    "localhost.:3000",
    "app.localhost:3000",
    "a.b.localhost",
    "127.0.0.1",
    "127.0.0.1:4983",
    "127.0.0.1.:4983",
    "127.1.2.3:80",
    "127.255.255.255",
    "[::1]",
    "[::1]:4983",
    "  localhost:3000  ",
  ])("allows %j", (h) => expect(loopbackAuthority(h)).toBe(true));

  test.each([
    undefined,
    "",
    "evil.example",
    "evil.example:3000",
    "localhost.evil.com",
    "localhost.evil.com:3000",
    "127.0.0.1.nip.io",
    "127.0.0.1.nip.io:4983",
    "localhostevil.com",
    "evil-localhost",
    "2130706433",
    "2130706433:4983",
    "0x7f000001",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "127.0.0.01",
    "127.1",
    "127.0.1",
    "127.0.0.256",
    "128.0.0.1",
    "0.0.0.0",
    "10.0.0.2:3000",
    "192.168.1.5:3000",
    "[::]",
    "[::2]",
    "[::ffff:127.0.0.1]",
    "[0:0:0:0:0:0:0:1]",
    "::1",
    "[::1",
    "[::1]x",
    "[::1]:",
    "localhost:",
    "localhost:abc",
    "localhost:123456",
    "localhost..",
    ".localhost",
    "localhost:3000:3000",
    "user@localhost",
    "localhost/path",
    "localhost, evil.example",
  ])("refuses %j", (h) => expect(loopbackAuthority(h)).toBe(false));

  test("non-string values are refused", () => {
    expect(loopbackAuthority(["localhost"])).toBe(false);
    expect(loopbackAuthority(42)).toBe(false);
  });
});

describe("loopbackOrigin", () => {
  test.each([
    "http://localhost:3000",
    "http://localhost",
    "https://localhost:8443",
    "HTTP://LOCALHOST:5173",
    "http://127.0.0.1:4983",
    "http://[::1]:4983",
    "http://app.localhost:3000",
    "http://localhost.:3000",
  ])("allows %j", (o) => expect(loopbackOrigin(o)).toBe(true));

  test.each([
    "null",
    "",
    "https://evil.example",
    "http://localhost.evil.com",
    "http://127.0.0.1.nip.io:4983",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://[::ffff:7f00:1]",
    "file://",
    "chrome-extension://abcdef",
    "ws://localhost:3000",
    "http://localhost:3000/",
    "http://localhost:3000/path",
    "http://user@localhost:3000",
    "http://localhost:3000, https://evil.example",
    "localhost:3000",
  ])("refuses %j", (o) => expect(loopbackOrigin(o)).toBe(false));
});

describe("loopbackAddress (socket)", () => {
  test("127/8, ::1 and mapped 127/8 only", () => {
    for (const a of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "::FFFF:127.9.9.9"])
      expect(loopbackAddress(a), a).toBe(true);
    for (const a of [undefined, "", "10.0.0.2", "::ffff:10.0.0.2", "192.168.1.1", "::", "fe80::1"])
      expect(loopbackAddress(a), String(a)).toBe(false);
  });
});

describe("guardRequest (default: local only)", () => {
  test("no Origin with a local Host is allowed (node fetch, curl, same-origin GET / EventSource)", () => {
    expect(guardRequest(req({ host: "127.0.0.1:4983" }))).toBeUndefined();
    expect(guardRequest(req({ host: "localhost:3000" }))).toBeUndefined();
    expect(guardRequest(req({ host: "[::1]:3000" }, { socket: { remoteAddress: "::1" } }))).toBeUndefined();
  });

  test("a missing Host is refused", () => {
    const r = guardRequest(req({}));
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe("forbidden");
  });

  test("a non-loopback client is refused before anything else", () => {
    const r = guardRequest(req({ host: "localhost:3000" }, { socket: { remoteAddress: "10.0.0.2" } }));
    expect(r?.status).toBe(403);
    expect(r?.body.error).toMatch(/allowRemote/);
  });

  test("DNS rebinding: a foreign Host is refused even when Origin matches it, or is absent", () => {
    for (const headers of [
      { host: "attacker.example:4983" },
      { host: "attacker.example:4983", origin: "http://attacker.example:4983" },
      { host: "localhost.evil.com:3000" },
      { host: "127.0.0.1.nip.io:4983" },
    ]) {
      const r = guardRequest(req(headers));
      expect(r?.status, JSON.stringify(headers)).toBe(403);
      expect(r?.body).toMatchObject({ code: "forbidden" });
      expect(r?.body.error).toContain("Open Hoplens at http://localhost:4983/__hoplens");
    }
  });

  test("a forwarded host (Next's rewrite: Host 127.0.0.1, x-forwarded-host the browser's) must be local too", () => {
    expect(guardRequest(req({ host: "127.0.0.1:4983", "x-forwarded-host": "localhost:3000" }))).toBeUndefined();
    expect(guardRequest(req({ host: "127.0.0.1:4983", "x-forwarded-host": "localhost:3000, 127.0.0.1:3000" }))).toBe(
      undefined,
    );
    for (const fwd of ["attacker.example:3000", "localhost:3000, attacker.example", ""]) {
      const r = guardRequest(req({ host: "127.0.0.1:4983", "x-forwarded-host": fwd }));
      expect(r?.status, fwd).toBe(403);
    }
  });

  test("Origin: loopback on any port passes; anything else is 403", () => {
    for (const origin of ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:4983", "http://[::1]:9"])
      expect(guardRequest(req({ host: "127.0.0.1:4983", origin })), origin).toBeUndefined();
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.com", ""]) {
      const r = guardRequest(req({ host: "127.0.0.1:4983", origin }));
      expect(r?.status, origin).toBe(403);
      expect(r?.body.error).toMatch(/only pages on this machine/);
    }
  });

  test("the Vite dev proxy (changeOrigin) and the app-port mount both pass", () => {
    const vite = { host: "127.0.0.1:4983", origin: "http://localhost:5173", "content-type": "application/json" };
    expect(guardRequest(req(vite, { method: "POST" }))).toBeUndefined();
    const appPort = { host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" };
    expect(guardRequest(req(appPort, { method: "DELETE" }))).toBeUndefined();
  });

  test("trustedCaller is the strict caller check", () => {
    expect(trustedCaller(req({ host: "127.0.0.1:4983" }))).toBe(true);
    expect(trustedCaller(req({ host: "evil.example" }))).toBe(false);
    expect(trustedCaller(req({ host: "127.0.0.1:4983" }, { socket: { remoteAddress: "10.0.0.2" } }))).toBe(false);
    expect(trustedCaller(req({ host: "127.0.0.1:4983", "x-forwarded-host": "evil.example" }))).toBe(false);
  });
});

describe("bodyRefusal (state-changing methods)", () => {
  const write = (method: string, headers: Record<string, unknown>) => bodyRefusal(req(headers, { method }));

  test("safe methods are never checked", () => {
    expect(write("GET", { origin: "http://localhost:3000", "content-type": "text/plain" })).toBeUndefined();
    expect(write("HEAD", { "content-type": "text/plain" })).toBeUndefined();
  });

  test.each(["POST", "PUT", "PATCH", "DELETE", "post"])("%s: JSON passes, simple content types are 415", (m) => {
    for (const ct of [
      "application/json",
      "application/json; charset=utf-8",
      "APPLICATION/JSON",
      "application/vnd.x+json",
    ])
      expect(write(m, { "content-type": ct, origin: "http://localhost:3000" }), ct).toBeUndefined();
    for (const ct of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
    ]) {
      const r = write(m, { "content-type": ct });
      expect(r?.status, ct).toBe(415);
      expect(r?.body.code).toBe("content-type");
      expect(r?.body.error).toMatch(/application\/json/);
    }
  });

  test("no content type: fine without Origin (curl -X POST, node), 415 from a page (forces a preflight)", () => {
    expect(write("POST", {})).toBeUndefined();
    expect(write("DELETE", {})).toBeUndefined();
    expect(write("POST", { origin: "http://localhost:8080" })?.status).toBe(415);
    expect(write("DELETE", { origin: "http://localhost:3000" })?.status).toBe(415);
  });

  test("guardRequest checks the caller first (403 beats 415)", () => {
    expect(guardRequest(req({ host: "evil.example", "content-type": "text/plain" }, { method: "POST" }))?.status).toBe(
      403,
    );
    expect(guardRequest(req({ host: "localhost", "content-type": "text/plain" }, { method: "POST" }))?.status).toBe(
      415,
    );
  });
});

describe("guardRequest with allowRemote", () => {
  const remote = (headers: Record<string, unknown>, method = "GET") =>
    guardRequest(req(headers, { method, socket: { remoteAddress: "192.168.1.20", localPort: 3000 } }), {
      allowRemote: true,
    });

  test("any client and Host (LAN address, name.local) without Origin", () => {
    expect(remote({ host: "192.168.1.5:3000" })).toBeUndefined();
    expect(remote({ host: "devbox.local:3000" })).toBeUndefined();
  });

  test("Origin must be loopback or the request's own host (cross-site CSRF stays blocked)", () => {
    expect(remote({ host: "192.168.1.5:3000", origin: "http://192.168.1.5:3000" })).toBeUndefined();
    expect(remote({ host: "devbox.local", origin: "http://devbox.local" })).toBeUndefined();
    expect(remote({ host: "devbox.local:443", origin: "https://devbox.local" })).toBeUndefined();
    expect(
      remote({ host: "127.0.0.1:4983", "x-forwarded-host": "devbox.local:3000", origin: "http://devbox.local:3000" }),
    ).toBe(undefined);
    expect(remote({ host: "192.168.1.5:3000", origin: "http://localhost:5173" })).toBeUndefined();
    expect(remote({ host: "192.168.1.5:3000", origin: "http://192.168.1.5:3001" })?.status).toBe(403);
    expect(remote({ host: "192.168.1.5:3000", origin: "https://evil.example" })?.status).toBe(403);
    expect(remote({ host: "192.168.1.5:3000", origin: "null" })?.status).toBe(403);
  });

  test("the content-type rule still applies", () => {
    const h = { host: "192.168.1.5:3000", origin: "http://192.168.1.5:3000" };
    expect(remote({ ...h, "content-type": "text/plain" }, "POST")?.status).toBe(415);
    expect(remote({ ...h, "content-type": "application/json" }, "POST")).toBeUndefined();
  });

  test("trustedCaller ignores allowRemote", () => {
    expect(trustedCaller(req({ host: "192.168.1.5:3000" }, { socket: { remoteAddress: "192.168.1.20" } }))).toBe(false);
  });
});

/* ------------------------------------------------------------ every route */

describe("every mounted route is behind the guard", () => {
  let server: http.Server;
  let port: number;
  let reached: string[] = [];

  beforeAll(async () => {
    // Mounted after the built-in modules, like any future api/ module: proves a new route can't skip it.
    mountApi({
      endpoints: [
        {
          method: "GET",
          path: "/api/__guard/probe",
          handle: (_q, res) => {
            reached.push("probe");
            sendJson(res, 200, {});
          },
        },
        {
          method: "POST",
          path: "/api/__guard/probe",
          handle: (_q, res) => {
            reached.push("post");
            sendJson(res, 200, {});
          },
        },
      ],
    });
    // No real runtime: a refused request must never reach a handler (they would throw on `{}`).
    const rt = { options: {} } as unknown as Runtime;
    server = http.createServer((q, s) => {
      handleUi(rt, q, s).catch((err) => {
        reached.push(`threw ${q.method} ${q.url}`);
        if (!s.headersSent) sendJson(s, 500, { error: String(err) });
        else s.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const send = (method: string, p: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let parsed: any = body;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      r.on("error", reject);
      r.end();
    });

  const concrete = (p: string) => `/__hoplens${p.replace(/:[a-zA-Z_]\w*/g, "x")}`;

  test("the table lists the routes that matter", () => {
    const keys = routeTable().map((r) => `${r.method} ${r.path}`);
    expect(keys.length).toBeGreaterThan(20);
    for (const k of [
      "GET /",
      "GET /api/events",
      "POST /api/run",
      "DELETE /api/traces",
      "GET /api/traces/:id/request",
      "GET /api/source",
      "POST /api/traces/:id/path",
      "POST /api/path/enable",
      "GET /api/__guard/probe",
    ])
      expect(keys).toContain(k);
  });

  test("a rebound Host gets 403 forbidden on every route", async () => {
    reached = [];
    for (const r of routeTable()) {
      const res = await send(r.method, concrete(r.path), { host: `attacker.example:${port}` });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body, `${r.method} ${r.path}`).toMatchObject({ code: "forbidden" });
      expect(res.body.error).toContain(`http://localhost:${port}/__hoplens`);
    }
    expect(reached).toEqual([]);
  });

  test("a foreign Origin gets 403 on every route, a foreign forwarded host too", async () => {
    reached = [];
    for (const r of routeTable()) {
      const a = await send(r.method, concrete(r.path), { host: `127.0.0.1:${port}`, origin: "https://evil.example" });
      expect(a.status, `${r.method} ${r.path}`).toBe(403);
      const b = await send(r.method, concrete(r.path), {
        host: `127.0.0.1:${port}`,
        "x-forwarded-host": "attacker.example:3000",
      });
      expect(b.status, `${r.method} ${r.path}`).toBe(403);
    }
    expect(reached).toEqual([]);
  });

  test("every POST / DELETE refuses a simple content type (415) and a page call without one", async () => {
    reached = [];
    const writes = routeTable().filter((r) => r.method !== "GET");
    expect(writes.length).toBeGreaterThan(4);
    for (const r of writes) {
      const plain = await send(r.method, concrete(r.path), { host: `localhost:${port}`, "content-type": "text/plain" });
      expect(plain.status, `${r.method} ${r.path}`).toBe(415);
      const page = await send(r.method, concrete(r.path), {
        host: `localhost:${port}`,
        origin: "http://localhost:8080",
      });
      expect(page.status, `${r.method} ${r.path}`).toBe(415);
    }
    expect(reached).toEqual([]);
  });

  test("a local caller reaches the handler", async () => {
    reached = [];
    expect((await send("GET", "/__hoplens/api/__guard/probe", { host: `localhost:${port}` })).status).toBe(200);
    const json = { host: `127.0.0.1:${port}`, origin: "http://localhost:5173", "content-type": "application/json" };
    expect((await send("POST", "/__hoplens/api/__guard/probe", json)).status).toBe(200);
    expect(reached).toEqual(["probe", "post"]);
  });

  test("unknown paths are guarded too (no endpoint discovery from a rebound page)", async () => {
    const res = await send("GET", "/__hoplens/api/nope", { host: "attacker.example" });
    expect(res.status).toBe(403);
  });
});
