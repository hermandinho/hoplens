import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { als, installPgHook } from "../src/capture";
import type { Runtime } from "../src/runtime";

// A fake `pg` in a throwaway project root: query() answers through the callback after 30ms and
// returns undefined, the way pg-pool's Pool.query calls Client.prototype.query.
const FAKE_PG = `
class Client {
  query(text, values, cb) {
    if (typeof values === "function") { cb = values; values = undefined; }
    if (cb) { setTimeout(() => (text.includes("FAIL") ? cb(new Error("boom")) : cb(null, { rowCount: 3, rows: [] })), 30); return undefined; }
    return new Promise((r) => setTimeout(() => r({ rowCount: 1, rows: [] }), 30));
  }
}
module.exports = { Client };
`;

let root: string;
const exporter = new InMemorySpanExporter();

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-pg-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.mkdirSync(path.join(root, "node_modules", "pg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pg", "index.js"), FAKE_PG);
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  installPgHook({ root, redactor: undefined } as unknown as Runtime);
});

afterAll(() => {
  trace.disable();
  fs.rmSync(root, { recursive: true, force: true });
});

function client() {
  const req = require("node:module").createRequire(path.join(root, "package.json"));
  return new (req("pg").Client)();
}

function inTrace<T>(fn: () => T): T {
  return als.run({} as never, fn);
}

describe("pg hook", () => {
  test("callback-style query: span lasts until the callback fires and carries the row count", async () => {
    exporter.reset();
    const c = client();
    const res = await inTrace(
      () =>
        new Promise<{ rowCount: number }>((ok, ko) =>
          c.query("SELECT 1", [], (e: Error, r: any) => (e ? ko(e) : ok(r))),
        ),
    );
    expect(res.rowCount).toBe(3);
    const s = exporter.getFinishedSpans()[0]!;
    expect(s.name).toBe("pg.query");
    expect(s.attributes["db.rows"]).toBe(3);
    expect(Number(s.attributes["hoplens.duration"])).toBeGreaterThanOrEqual(20);
  });

  test("callback-style error: span is marked errored and the caller still gets the error", async () => {
    exporter.reset();
    const c = client();
    const err = await inTrace(() => new Promise<Error>((ok) => c.query("SELECT FAIL", (e: Error) => ok(e))));
    expect(err.message).toBe("boom");
    const s = exporter.getFinishedSpans()[0]!;
    expect(s.status.code).toBe(2);
  });

  test("promise-style query still works", async () => {
    exporter.reset();
    const r = await inTrace(() => client().query("SELECT 2"));
    expect(r.rowCount).toBe(1);
    expect(exporter.getFinishedSpans()[0]!.attributes["db.rows"]).toBe(1);
  });
});
