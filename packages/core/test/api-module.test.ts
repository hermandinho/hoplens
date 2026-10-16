// Per-endpoint module contract (plan 4.1): a module's endpoints mount under /__hoplens with params,
// receive (req, res, rt, ctx), and never shadow a built-in route.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ApiEndpoint, readJson, sendJson } from "../src/api/module";
import type { Runtime } from "../src/runtime";
import { handleUi, mountApi } from "../src/server";

const rt = { options: {} } as unknown as Runtime;
let server: http.Server;
let base: string;

const endpoints: ApiEndpoint[] = [
  {
    method: "GET",
    path: "/api/__test/echo/:id",
    handle: (_req, res, got, ctx) =>
      sendJson(res, 200, { id: ctx.params.id, q: ctx.url.searchParams.get("q"), sameRt: got === rt }),
  },
  {
    method: "POST",
    path: "/api/__test/echo",
    handle: async (req, res) => sendJson(res, 201, { body: await readJson(req) }),
  },
  // Built-in path: must not win over the existing /api/meta handler.
  { method: "GET", path: "/api/meta", handle: (_req, res) => sendJson(res, 418, { shadowed: true }) },
];

beforeAll(async () => {
  mountApi({ endpoints });
  server = http.createServer((req, res) => {
    handleUi(rt, req, res).catch((err) => sendJson(res, 500, { error: String(err) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__hoplens`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("per-endpoint api modules", () => {
  test("GET with a :param and query string", async () => {
    const res = await fetch(`${base}/api/__test/echo/a%20b?q=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: "a b", q: "1", sameRt: true });
  });

  test("POST reads a JSON body", async () => {
    const res = await fetch(`${base}/api/__test/echo`, { method: "POST", body: JSON.stringify({ n: 2 }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ body: { n: 2 } });
  });

  test("a module cannot shadow a built-in endpoint", async () => {
    const res = await fetch(`${base}/api/meta`);
    expect(res.status).not.toBe(418);
  });
});
