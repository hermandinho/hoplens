// Express 4 and 5 end to end: a real app in a child process, preloaded with the built register hook
// (`-r` for 4, `--import` for 5), read back through the Hoplens API on the app's own port.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Child,
  type ExpressAlias,
  type Fixture,
  REGISTER,
  childEnv,
  freePort,
  makeFixture,
  poll,
  run,
} from "./helpers";

const APP = `
const path = require("node:path");
const express = require("express");
const app = express();
app.use("/static", express.static(path.join(__dirname, "public")));
app.get("/api/items/:id", (req, res) => res.json({ id: req.params.id }));
// Runs from the request's 'end' (body-parser): its log lands in the trace only if the context held.
app.post("/api/login", express.json(), (req, res) => {
  console.log("login " + req.body.user);
  res.json({ ok: true, user: req.body.user });
});
// Both parsers mounted: body-parser 1.x leaves a stray {} for an unmatched type or a failed parse.
app.post("/api/form", express.json(), express.urlencoded({ extended: false }), (req, res) => res.json({ ok: true }));
// Continues from the request's own 'end' with no AsyncResource binding (raw-body binds its callback;
// a hand-rolled reader does not): needs HttpTap.bindRequestEmitter.
app.post("/api/raw", (req, res) => {
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    console.log("raw " + text.length);
    res.json({ length: text.length });
  });
});
app.get("/boom", () => {
  throw new Error("boom");
});
app.get("/custom-error", (req, res, next) => next(new Error("nope")));
app.use((err, req, res, next) => {
  if (req.path === "/custom-error") return res.status(418).set("x-app", "mine").json({ error: err.message });
  next(err);
});
const server = app.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: server.address().port }));
});
`;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, method: string, path: string, chunks: string[] = [], headers = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    // Later chunks are written on later ticks, so the body arrives over several 'data' events.
    const write = (i: number) => {
      if (i >= chunks.length) return void req.end();
      req.write(chunks[i]);
      setTimeout(() => write(i + 1), 60);
    };
    write(0);
  });
}

async function traces(port: number): Promise<any[]> {
  return JSON.parse((await request(port, "GET", "/__hoplens/api/traces")).body);
}

async function traceFor(port: number, match: (t: any) => boolean): Promise<any> {
  const summary = await poll(async () => (await traces(port)).find((t) => t.done && match(t)));
  return JSON.parse((await request(port, "GET", `/__hoplens/api/traces/${summary.id}`)).body);
}

describe.each([
  ["express4", "-r", /^4\./],
  ["express5", "--import", /^5\./],
] as const)("%s (%s register)", (alias: ExpressAlias, flag, version) => {
  let fx: Fixture;
  let app: Child;
  let port: number;

  beforeAll(async () => {
    fx = makeFixture(alias, { "app.cjs": APP, "public/app.css": "body { color: red; }\n" });
    const register = flag === "--import" ? pathToFileURL(REGISTER).href : REGISTER;
    app = run([flag, register, "app.cjs"], fx.root, childEnv({ HOPLENS_PORT: String(await freePort()) }));
    port = (await app.waitFor<{ ready: number }>("ready")).ready;
  });

  afterAll(async () => {
    await app?.kill();
    fx?.cleanup();
  });

  test("/__hoplens on the app port serves the UI; /api/meta names express", async () => {
    const ui = await request(port, "GET", "/__hoplens");
    expect(ui.status).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
    const meta = JSON.parse((await request(port, "GET", "/__hoplens/api/meta")).body);
    expect(meta.framework.name).toBe("express");
    expect(meta.framework.version).toMatch(version);
    expect(meta.appPort).toBe(port);
  });

  test("GET /api/items/42 and /api/items/43 are captured", async () => {
    expect((await request(port, "GET", "/api/items/42")).body).toBe('{"id":"42"}');
    expect((await request(port, "GET", "/api/items/43")).body).toBe('{"id":"43"}');
    const a = await traceFor(port, (t) => t.path === "/api/items/42");
    const b = await traceFor(port, (t) => t.path === "/api/items/43");
    for (const t of [a, b]) {
      expect(t.method).toBe("GET");
      expect(t.status).toBe(200);
      expect(t.kind).toBe("route");
    }
  });

  test.each([
    ["in one chunk", ['{"user":"ada","password":"hunter2"}']],
    ["in 2 delayed chunks", ['{"user":"bob",', '"password":"hunter2"}']],
  ])("POST with express.json, body %s: captured with the password redacted", async (_label, chunks) => {
    const user = chunks[0]!.includes("ada") ? "ada" : "bob";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (chunks.length === 1) headers["content-length"] = String(Buffer.byteLength(chunks[0]!));
    const res = await request(port, "POST", "/api/login", [...chunks], headers);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, user });
    const mine = await poll(async () => {
      for (const s of await traces(port)) {
        if (!s.done || s.method !== "POST" || s.path !== "/api/login") continue;
        const full = JSON.parse((await request(port, "GET", `/__hoplens/api/traces/${s.id}`)).body);
        if (full.request.body?.json?.user === user) return full;
      }
      return undefined;
    });
    expect(mine.status).toBe(200);
    expect(mine.logs.map((l: any) => l.text)).toContain(`login ${user}`);
    expect(mine.request.body.json.password).not.toBe("hunter2");
    expect(String(mine.request.body.json.password)).toContain("[redacted]");
    expect(JSON.stringify(mine)).not.toContain("hunter2");
  });

  test.each([
    ["an unmatched content type", "application/xml", '<a password="x"/>', 200],
    ["malformed JSON", "application/json", "{bad", 400],
  ])("POST /api/form with %s records no body", async (_label, type, body, status) => {
    const tag = `case=s${status}`;
    const res = await request(port, "POST", `/api/form?${tag}`, [body], {
      "content-type": type,
      "content-length": String(Buffer.byteLength(body)),
    });
    expect(res.status).toBe(status);
    const t = await traceFor(port, (s) => s.method === "POST" && s.url?.includes(tag));
    expect(t.status).toBe(status);
    expect(t.request.body).toBeUndefined();
  });

  test("POST /api/form with a real {} JSON body records it", async () => {
    const res = await request(port, "POST", "/api/form?case=empty", ["{}"], {
      "content-type": "application/json",
      "content-length": "2",
    });
    expect(res.status).toBe(200);
    const t = await traceFor(port, (s) => s.method === "POST" && s.url?.includes("case=empty"));
    expect(t.request.body?.json).toEqual({});
  });

  test("a handler continued from the request's 'end' after delayed chunks stays in its trace", async () => {
    const res = await request(port, "POST", "/api/raw", ["abc", "defg"], { "content-type": "text/plain" });
    expect(res.body).toBe('{"length":7}');
    const t = await traceFor(port, (s) => s.path === "/api/raw");
    expect(t.logs.map((l: any) => l.text)).toContain("raw 7");
  });

  test("an express.static css file is tagged kind 'asset'", async () => {
    const css = await request(port, "GET", "/static/app.css");
    expect(css.status).toBe(200);
    expect(css.body).toBe("body { color: red; }\n");
    const t = await traceFor(port, (s) => s.path === "/static/app.css");
    expect(t.kind).toBe("asset");
  });

  test("a throwing handler and an error middleware still return the app's own response", async () => {
    const boom = await request(port, "GET", "/boom");
    expect(boom.status).toBe(500);
    expect(boom.body).toContain("Error: boom");
    const custom = await request(port, "GET", "/custom-error");
    expect(custom.status).toBe(418);
    expect(custom.headers["x-app"]).toBe("mine");
    expect(custom.body).toBe('{"error":"nope"}');
    const t = await traceFor(port, (s) => s.path === "/custom-error");
    expect(t.status).toBe(418);
    const b = await traceFor(port, (s) => s.path === "/boom");
    expect(b.status).toBe(500);
    expect(app.stderr()).not.toContain("hoplens:express");
  });
});
