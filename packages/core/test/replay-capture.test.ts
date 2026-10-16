import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installHttpHook } from "../src/capture";
import { makeRedactor } from "../src/serialize";
import { TraceStore, summarize } from "../src/store";
import type { TraceRecord } from "../src/types";

// Own file: installHttpHook patches http.Server for the whole worker.
describe("capture reads x-hoplens-batch (WP7)", () => {
  const store = new TraceStore(50);
  const rt: any = {
    options: { lateSpanGraceMs: 0 },
    redactor: makeRedactor([]),
    store,
    root: process.cwd(),
    routeInfo: () => undefined,
    proxyFile: () => undefined,
    handleUi: (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("ui"),
  };
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    installHttpHook(rt);
    server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const hit = async (headers: Record<string, string>) => {
    const done = new Promise<TraceRecord>((resolve) => store.once("done", resolve));
    const r = await fetch(`http://127.0.0.1:${port}/api/feed`, { headers });
    await r.text();
    return done;
  };

  test("tags the trace and keeps the header out of the captured request headers", async () => {
    const t = await hit({ "x-hoplens-run": "run-1", "x-hoplens-batch": "b_123" });
    expect(t.runId).toBe("run-1");
    expect(t.batchId).toBe("b_123");
    expect(summarize(t).batchId).toBe("b_123");
    expect(t.request.headers["x-hoplens-batch"]).toBeUndefined();
    expect(t.request.headers["x-hoplens-run"]).toBeUndefined();
  });

  test("no header, no batchId", async () => {
    const t = await hit({});
    expect(t.batchId).toBeUndefined();
    expect("batchId" in t).toBe(false);
  });
});
