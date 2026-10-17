import http from "node:http";
import Module from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bannerText } from "../src/banner";
import { shouldStart } from "../src/gate";
import { ignoredPrefixes, resolveOptions } from "../src/options";
import { resolveExpress } from "../src/resolve";
import { ROUTE_KEY, joinPath, mountArg, normalizeTemplate, segmentsMatch } from "../src/routes";
import { requestedPort } from "../src/start";
import { createTap, describeRequest, requestBody } from "../src/tap";
import { PKG, makeFixture } from "./helpers";

describe("gate", () => {
  test.each([
    [{}, true],
    [{ NODE_ENV: "development" }, true],
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "test" }, false],
    [{ NODE_ENV: "production", HOPLENS_FORCE: "1" }, true],
    [{ NODE_ENV: "test", HOPLENS_FORCE: "1" }, true],
    [{ HOPLENS: "0" }, false],
    [{ NODE_ENV: "development", HOPLENS: "0" }, false],
    [{ NODE_ENV: "production", HOPLENS: "0", HOPLENS_FORCE: "1" }, false],
    [{ NODE_ENV: "production", HOPLENS_FORCE: "true" }, false],
  ])("%j -> %s", (env, expected) => {
    expect(shouldStart(env)).toBe(expected);
  });
});

describe("options", () => {
  test("defaults: persist on, stateDir under node_modules/.cache, no distDir", () => {
    const o = resolveOptions(undefined, {}, "/app");
    expect(o).toMatchObject({ port: 4983, basePath: "", distDir: "", root: "/app", configured: true, persist: true });
    expect(o.stateDir).toBe(path.join("/app", "node_modules", ".cache", "hoplens"));
  });

  test("HOPLENS_PORT, then HOPLENS_OPTIONS, then code options win in that order", () => {
    const env = {
      HOPLENS_PORT: "5000",
      HOPLENS_OPTIONS: JSON.stringify({ port: 5001, persist: false, maxTraces: 10 }),
    };
    expect(resolveOptions(undefined, env, "/app")).toMatchObject({ port: 5001, persist: false, maxTraces: 10 });
    expect(resolveOptions({ port: 5002 }, env, "/app")).toMatchObject({ port: 5002, persist: false });
    expect(resolveOptions(undefined, { HOPLENS_PORT: "5000" }, "/app").port).toBe(5000);
  });

  test("bad HOPLENS_OPTIONS JSON is ignored", () => {
    expect(resolveOptions(undefined, { HOPLENS_OPTIONS: "{nope" }, "/app").port).toBe(4983);
  });

  test("a UI port that is not a port falls back to 4983 (listen() would throw mid-boot)", () => {
    expect(resolveOptions(undefined, { HOPLENS_PORT: "99999" }, "/app").port).toBe(4983);
    expect(resolveOptions({ port: -1 }, {}, "/app").port).toBe(4983);
    expect(resolveOptions({ port: 1.5 }, {}, "/app").port).toBe(4983);
    expect(resolveOptions({ port: 0 }, {}, "/app").port).toBe(0);
  });

  test("HOPLENS_IGNORE adds internal prefixes", () => {
    expect(ignoredPrefixes({ HOPLENS_IGNORE: " /health, /metrics ,," })).toEqual(["/health", "/metrics"]);
    const tap = createTap((u) => u, { HOPLENS_IGNORE: "/health" });
    expect(tap.internalPrefixes).toEqual(["/favicon.ico", "/.well-known/", "/health"]);
    expect(tap.bindRequestEmitter).toBe(true);
    expect(tap.classifyRequest?.({ accept: "text/html" }, "GET")).toBe("route");
  });
});

describe("resolveExpress", () => {
  test("resolves the app root's express and its version; undefined when absent", () => {
    const withIt = makeFixture("express4");
    const without = makeFixture();
    // pnpm sets NODE_PATH for scripts, which would find the workspace's express from any root.
    const nodePath = process.env.NODE_PATH;
    Reflect.deleteProperty(process.env, "NODE_PATH");
    (Module as any)._initPaths();
    try {
      expect(resolveExpress(withIt.root)?.version).toMatch(/^4\./);
      expect(resolveExpress(without.root)).toBeUndefined();
    } finally {
      if (nodePath !== undefined) process.env.NODE_PATH = nodePath;
      (Module as any)._initPaths();
      withIt.cleanup();
      without.cleanup();
    }
  });
});

function fakeReq(url: string, headers: Record<string, string> = {}, body?: unknown): http.IncomingMessage {
  const req = new http.IncomingMessage(null as any);
  req.url = url;
  req.headers = headers;
  if (body !== undefined) (req as any).body = body;
  return req;
}

function fakeRes(status: number, type?: string): http.ServerResponse {
  const res = new http.ServerResponse(fakeReq("/"));
  res.statusCode = status;
  if (type) res.setHeader("content-type", type);
  return res;
}

describe("tap.describe", () => {
  const norm = (u: string) => u.replace(/\/\d+/g, "/:id");
  test("static types on 200 and extension on a bare 304 are assets", () => {
    expect(describeRequest(fakeReq("/static/app.css?v=1"), fakeRes(200, "text/css; charset=UTF-8"), norm)).toEqual({
      route: "/static/app.css",
      kind: "asset",
    });
    expect(describeRequest(fakeReq("/a.js"), fakeRes(200, "application/javascript"), norm)?.kind).toBe("asset");
    expect(describeRequest(fakeReq("/logo.png"), fakeRes(200, "image/png"), norm)?.kind).toBe("asset");
    expect(describeRequest(fakeReq("/f.woff2"), fakeRes(200, "font/woff2"), norm)?.kind).toBe("asset");
    expect(describeRequest(fakeReq("/app.css"), fakeRes(304), norm)?.kind).toBe("asset");
  });

  test("JSON, HTML, errors and non-asset 304s are left to core", () => {
    expect(describeRequest(fakeReq("/api/items/1"), fakeRes(200, "application/json"), norm)).toBeUndefined();
    expect(describeRequest(fakeReq("/"), fakeRes(200, "text/html"), norm)).toBeUndefined();
    expect(describeRequest(fakeReq("/missing.css"), fakeRes(404, "text/css"), norm)).toBeUndefined();
    expect(describeRequest(fakeReq("/api/items"), fakeRes(304), norm)).toBeUndefined();
  });

  test("uses originalUrl when a mounted router rewrote req.url", () => {
    const req = fakeReq("/app.css");
    (req as any).originalUrl = "/static/app.css";
    expect(describeRequest(req, fakeRes(200, "text/css"), norm)?.route).toBe("/static/app.css");
  });
});

describe("tap.requestBody", () => {
  test("a parsed body on a request that declared one", () => {
    const req = fakeReq("/", { "content-type": "application/json", "content-length": "12" }, { a: 1 });
    expect(requestBody(req)).toEqual({ contentType: "application/json", value: { a: 1 } });
    const chunked = fakeReq("/", { "transfer-encoding": "chunked" }, { a: 1 });
    expect(requestBody(chunked)?.value).toEqual({ a: 1 });
  });

  test("express.json's {} on a bodiless request, or no body at all, is nothing", () => {
    expect(requestBody(fakeReq("/", {}, {}))).toBeUndefined();
    expect(requestBody(fakeReq("/", { "content-length": "0" }, {}))).toBeUndefined();
    expect(requestBody(fakeReq("/", { "content-length": "5" }))).toBeUndefined();
  });

  test("body-parser 1.x's stray {} (no parser read the stream, or the parse failed) is nothing", () => {
    const json = { "content-type": "application/json", "content-length": "4" };
    // Unmatched type: `req.body ||= {}` without reading, so no `_body`.
    expect(requestBody(fakeReq("/", { "content-type": "application/xml", "content-length": "9" }, {}))).toBeUndefined();
    // Malformed JSON: read (`_body`), parse failed, request answered with an error.
    const bad = fakeReq("/", json, {});
    (bad as any)._body = true;
    (bad as any).res = { statusCode: 400 };
    expect(requestBody(bad)).toBeUndefined();
    // A real `{}`: read, two bytes, kept even when the handler answers 4xx.
    const empty = fakeReq("/", { "content-type": "application/json", "content-length": "2" }, {});
    (empty as any)._body = true;
    (empty as any).res = { statusCode: 422 };
    expect(requestBody(empty)?.value).toEqual({});
    // Read and answered 2xx (e.g. `{ }` with whitespace): kept.
    const spaced = fakeReq("/", json, {});
    (spaced as any)._body = true;
    (spaced as any).res = { statusCode: 200 };
    expect(requestBody(spaced)?.value).toEqual({});
  });

  test("Express 5 (body-parser 2.x sets no `_body`) keeps an empty {}", () => {
    const req = fakeReq("/", { "content-type": "application/json", "content-length": "2" }, {});
    expect(requestBody(req, false)?.value).toEqual({});
    expect(createTap((u) => u, {}, "5.1.0").requestBody?.(req)?.value).toEqual({});
    expect(createTap((u) => u, {}, "4.21.2").requestBody?.(req)).toBeUndefined();
    expect(createTap((u) => u, {}).requestBody?.(req)).toBeUndefined();
  });
});

describe("start.requestedPort", () => {
  test("a TCP port from listen's arguments", () => {
    expect(requestedPort([6983, "127.0.0.1"])).toBe(6983);
    expect(requestedPort(["6983"])).toBe(6983);
    expect(requestedPort([{ port: 7000, host: "::" }])).toBe(7000);
    expect(requestedPort([0])).toBeUndefined();
    expect(requestedPort([])).toBeUndefined();
    expect(requestedPort(["/tmp/app.sock"])).toBeUndefined();
    expect(requestedPort([{ path: "/tmp/app.sock" }])).toBeUndefined();
    expect(requestedPort([70000])).toBeUndefined();
  });
});

describe("banner", () => {
  test("app port from listen plus the standalone UI port", () => {
    const text = bannerText(4983, 3001);
    expect(text).toContain("◆ Hoplens");
    expect(text).toContain("http://localhost:3001/__hoplens");
    expect(text).toContain("http://127.0.0.1:4983");
  });

  test("UI only, and notes", () => {
    expect(bannerText(4983, undefined, ["x"])).toContain("http://127.0.0.1:4983\n   ! x");
    expect(bannerText(undefined, 3001)).not.toContain("also");
  });
});

describe("route templates", () => {
  test.each([
    ["/files/*splat", "/files/:splat+"],
    ["/opt{/:maybe}", "/opt/:maybe?"],
    ["/a{/:b}{/:c}", "/a/:b?/:c?"],
    ["/f{.json}", "/f(.json)?"],
    ["/x{/*rest}", "/x/:rest*"],
    ["/x{*rest}", "/x:rest*"],
    ["/users/:id", "/users/:id"],
  ])("Express 5 %s -> %s", (input, out) => {
    expect(normalizeTemplate(input)).toBe(out);
  });

  test.each([
    ["", "/", "/"],
    ["", "/x", "/x"],
    ["/api", "/", "/api"],
    ["/api/", "/x", "/api/x"],
    ["/api", "x", "/api/x"],
  ])("joinPath(%j, %j) = %s", (a, b, out) => {
    expect(joinPath(a, b)).toBe(out);
  });

  test.each([
    ["/v2/:tenant", "/v2/acme", true],
    ["/v1", "/v2/acme", false],
    ["/v1", "/V1", true],
    ["/a/:b?", "/a", true],
    ["/a/:b", "/a", false],
    ["/a", "/a/b", false],
    ["/^\\/re/", "/anything", true],
    ["/files/:splat+", "/files/a/b", true],
  ])("segmentsMatch(%s, %s) = %s", (t, c, out) => {
    expect(segmentsMatch(t, c)).toBe(out);
  });

  test("mountArg reads use()'s path argument the way Express does", () => {
    const fn = () => {};
    expect(mountArg([fn])).toBe("/");
    expect(mountArg([[fn, fn]])).toBe("/");
    expect(mountArg(["/api", fn])).toBe("/api");
    expect(mountArg([["/a", "/b"], fn])).toEqual(["/a", "/b"]);
  });

  test("describeRequest prefers the dispatched route's template over asset tagging", () => {
    const res = { statusCode: 200, getHeader: () => "text/css" } as any;
    const req = { url: "/static/app.css" } as any;
    expect(describeRequest(req, res, (u) => u)).toEqual({ route: "/static/app.css", kind: "asset" });
    req[ROUTE_KEY] = "/static/:file";
    expect(describeRequest(req, res, (u) => u)).toEqual({ route: "/static/:file", kind: "route" });
    expect(describeRequest({ url: "/x", [ROUTE_KEY]: "/x" } as any, { statusCode: 500 } as any, (u) => u)).toEqual({
      route: "/x",
      kind: "route",
    });
  });
});
