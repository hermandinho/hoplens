// HttpTap.bindRequestEmitter: request events keep the trace context when the body arrives late.
// Installs the real http emit hook in this test process (each vitest file runs isolated).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { als, bindRequestEmitter, installHttpHook } from "../src/capture";
import { makeRedactor } from "../src/serialize";
import { TraceStore } from "../src/store";

type Seen = { handler: boolean; data: boolean[]; end: boolean; timer: boolean };

describe("installHttpHook: bindRequestEmitter", () => {
  const rt: any = {
    options: { lateSpanGraceMs: 0, serverTiming: false },
    redactor: makeRedactor([]),
    store: new TraceStore(50),
    root: process.cwd(),
    httpTap: { internalPrefixes: [] },
    routeInfo: () => undefined,
    proxyFile: () => undefined,
    handleUi: (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("ui"),
  };
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    installHttpHook(rt);
    // The body-parser shape: the handler continues from 'end', not from the request event.
    server = http.createServer((req, res) => {
      const seen: Seen = { handler: !!als.getStore(), data: [], end: false, timer: false };
      req.on("data", () => seen.data.push(!!als.getStore()));
      req.on("end", () => {
        seen.end = !!als.getStore();
        setTimeout(() => {
          seen.timer = !!als.getStore();
          res.end(JSON.stringify(seen));
        }, 5);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** POST whose second chunk is written after a delay, so it lands on a later tick. */
  function slowPost(): Promise<Seen> {
    return new Promise((resolve, reject) => {
      const req = http.request({ port, host: "127.0.0.1", method: "POST", path: "/api/orders" }, (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve(JSON.parse(text)));
      });
      req.on("error", reject);
      req.write('{"a":');
      setTimeout(() => req.end("1}"), 50);
    });
  }

  test("flag on: the 2nd 'data', 'end' and a timer started from 'end' keep the store", async () => {
    rt.httpTap = { internalPrefixes: [], bindRequestEmitter: true };
    const seen = await slowPost();
    expect(seen.handler).toBe(true);
    expect(seen.data.length).toBeGreaterThanOrEqual(2);
    expect(seen.data.every(Boolean)).toBe(true);
    expect(seen.end).toBe(true);
    expect(seen.timer).toBe(true);
  });

  test("flag off (Next's default): context is lost after the first chunk -- why the flag exists", async () => {
    rt.httpTap = { internalPrefixes: [] };
    const seen = await slowPost();
    expect(seen.handler).toBe(true);
    expect(seen.data.length).toBeGreaterThanOrEqual(2);
    expect(seen.data[0]).toBe(true);
    expect(seen.data.at(-1)).toBe(false);
    expect(seen.end).toBe(false);
    expect(seen.timer).toBe(false);
  });

  test("idempotent, and removeListener still finds the original listener", () => {
    const req = new http.IncomingMessage(null as any);
    const ctx: any = { trace: { id: "tr_x" }, t0: 0 };
    bindRequestEmitter(req, ctx);
    const once = req.emit;
    bindRequestEmitter(req, ctx);
    expect(req.emit).toBe(once);
    let calls = 0;
    const fn = () => {
      calls++;
      expect(als.getStore()).toBe(ctx);
    };
    req.on("data", fn);
    req.emit("data", "x");
    req.removeListener("data", fn);
    req.emit("data", "y");
    expect(calls).toBe(1);
  });
});
