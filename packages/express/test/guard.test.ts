// The UI API guard (core api/guard.ts) end to end through the Express app-port mount and the
// standalone port: a real app in a child process, raw http requests so Host and Origin are ours.
import http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Child, type Fixture, REGISTER, childEnv, freePort, makeFixture, run } from "./helpers";

const APP = `
const express = require("express");
const app = express();
app.get("/api/items/:id", (req, res) => res.json({ id: req.params.id }));
const server = app.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ ready: server.address().port })));
`;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function send(port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<Res>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      // SSE never ends: the status and headers are the answer.
      if (String(res.headers["content-type"]).startsWith("text/event-stream")) {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" });
        req.destroy();
        return;
      }
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let parsed: any = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* text */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("express app-port mount and standalone port", () => {
  let fx: Fixture;
  let app: Child;
  let port: number;
  let uiPort: number;

  beforeAll(async () => {
    fx = makeFixture("express5", { "app.cjs": APP });
    uiPort = await freePort();
    app = run(["-r", REGISTER, "app.cjs"], fx.root, childEnv({ HOPLENS_PORT: String(uiPort) }));
    port = (await app.waitFor<{ ready: number }>("ready")).ready;
  }, 30000);

  afterAll(async () => {
    await app?.kill();
    fx?.cleanup();
  });

  test("the UI and API answer local names (127.0.0.1, localhost, with a local Origin)", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await send(port, "GET", "/__hoplens", { host })).status, host).toBe(200);
      const meta = await send(port, "GET", "/__hoplens/api/meta", { host, origin: `http://${host}` });
      expect(meta.status, host).toBe(200);
      expect(meta.body.framework.name).toBe("express");
    }
    const sse = await send(port, "GET", "/__hoplens/api/events", { host: `localhost:${port}` });
    expect(sse.status).toBe(200);
  });

  test("DNS rebinding: a foreign Host gets 403 on the page, the API and SSE; the app itself is untouched", async () => {
    const host = `attacker.example:${port}`;
    for (const p of ["/__hoplens", "/__hoplens/api/meta", "/__hoplens/api/traces", "/__hoplens/api/events"]) {
      const r = await send(port, "GET", p, { host, origin: `http://${host}` });
      expect(r.status, p).toBe(403);
      expect(r.body.code, p).toBe("forbidden");
      expect(r.body.error).toContain(`http://localhost:${port}/__hoplens`);
    }
    const own = await send(port, "GET", "/api/items/7", { host });
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ id: "7" });
  });

  test("a foreign Origin is 403; POST /api/run and DELETE need JSON from a page", async () => {
    const host = `localhost:${port}`;
    expect((await send(port, "GET", "/__hoplens/api/traces", { host, origin: "https://evil.example" })).status).toBe(
      403,
    );

    const body = JSON.stringify({ method: "GET", path: "/api/items/9" });
    const plain = await send(port, "POST", "/__hoplens/api/run", { host, "content-type": "text/plain" }, body);
    expect(plain.status).toBe(415);
    expect(plain.body.code).toBe("content-type");
    const ok = await send(
      port,
      "POST",
      "/__hoplens/api/run",
      { host, origin: `http://${host}`, "content-type": "application/json" },
      body,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe(200);

    const bare = await send(port, "DELETE", "/__hoplens/api/traces", { host, origin: "http://localhost:5173" });
    expect(bare.status).toBe(415);
    const del = await send(port, "DELETE", "/__hoplens/api/traces", {
      host,
      origin: "http://localhost:5173",
      "content-type": "application/json",
    });
    expect(del.status).toBe(200);
  });

  test("the standalone port: the Vite dev proxy shape passes, a rebound name does not", async () => {
    const vite = { host: `127.0.0.1:${uiPort}`, origin: "http://localhost:5173" };
    expect((await send(uiPort, "GET", "/__hoplens/api/meta", vite)).status).toBe(200);
    expect(
      (await send(uiPort, "DELETE", "/__hoplens/api/traces", { ...vite, "content-type": "application/json" })).status,
    ).toBe(200);
    // Next's fallback rewrite shape: Host rewritten to 127.0.0.1, the browser's host forwarded.
    const next = { host: `127.0.0.1:${uiPort}`, "x-forwarded-host": "localhost:3000" };
    expect((await send(uiPort, "GET", "/__hoplens/api/meta", next)).status).toBe(200);
    const rebound = { host: `127.0.0.1:${uiPort}`, "x-forwarded-host": "attacker.example:3000" };
    expect((await send(uiPort, "GET", "/__hoplens/api/meta", rebound)).status).toBe(403);
    expect((await send(uiPort, "GET", "/__hoplens/api/meta", { host: `attacker.example:${uiPort}` })).status).toBe(403);
  });
});
