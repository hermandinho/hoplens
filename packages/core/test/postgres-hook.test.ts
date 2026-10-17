import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { als, installPostgresHook } from "../src/capture";
import { DEFAULT_REDACT } from "../src/options";
import type { Runtime } from "../src/runtime";
import { makeRedactor } from "../src/serialize";

// The real postgres.js (a devDependency), resolved from this package's root like an app's would be.
const root = path.resolve(__dirname, "..");
const req = createRequire(path.join(root, "package.json"));
const pkgDir = path.dirname(path.dirname(path.dirname(req.resolve("postgres"))));
const exporter = new InMemorySpanExporter();
let CjsQuery: any;
let EsmQuery: any;

beforeAll(async () => {
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  await installPostgresHook({ root, redactor: makeRedactor([...DEFAULT_REDACT]) } as unknown as Runtime);
  CjsQuery = req(path.join(pkgDir, "cjs", "src", "query.js")).Query;
  EsmQuery = (await import(pathToFileURL(path.join(pkgDir, "src", "query.js")).href)).Query;
});

afterAll(() => {
  trace.disable();
});

function inTrace<T>(fn: () => T): T {
  return als.run({} as never, fn);
}

/**
 * Stands in for the pool handler (which Sql() tags with `debug`): builds the statement, then
 * settles the query 30ms later.
 */
function handler(opts: { fail?: boolean; result?: unknown; sql?: string } = {}) {
  const h = (q: any) => {
    q.string = opts.sql ?? (typeof q.strings === "string" ? q.strings : q.strings.join("?"));
    q.parameters = q.args;
    setTimeout(() => {
      if (opts.fail) return q.reject(new Error("boom"));
      q.resolve(opts.result ?? result([{ id: 1 }, { id: 2 }], 2));
    }, 30);
  };
  return Object.assign(h, { debug: false });
}

function result(rows: unknown[], count: number) {
  return Object.assign([...rows], { count });
}

function tagged(Query: any, h = handler()) {
  const strings: any = ["SELECT * FROM users WHERE id = ", " AND org = ", ""];
  strings.raw = strings;
  return new Query(strings, [7, "acme"], h);
}

describe("postgres.js hook", () => {
  test("tagged query (CJS build): span lasts until it settles, with SQL, params and row count", async () => {
    exporter.reset();
    const rows = await inTrace(async () => await tagged(CjsQuery));
    expect(rows.count).toBe(2);
    const [s] = exporter.getFinishedSpans();
    expect(s!.name).toBe("postgres.query");
    expect(s!.attributes["hoplens.kind"]).toBe("db");
    expect(s!.attributes["db.system"]).toBe("postgresql");
    expect(s!.attributes["db.statement"]).toBe("SELECT * FROM users WHERE id = ? AND org = ?");
    expect(JSON.parse(String(s!.attributes["hoplens.db.params"]))).toEqual([7, "acme"]);
    expect(s!.attributes["db.rows"]).toBe(2);
    expect(Number(s!.attributes["hoplens.duration"])).toBeGreaterThanOrEqual(20);
  });

  test("the ESM build is patched too", async () => {
    exporter.reset();
    expect(EsmQuery).not.toBe(CjsQuery);
    await inTrace(async () => await tagged(EsmQuery));
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["postgres.query"]);
  });

  test("unsafe() query (how Drizzle calls it) carries the raw SQL", async () => {
    exporter.reset();
    await inTrace(async () => await new CjsQuery("select 1 where $1 = $1", [3], handler()));
    expect(exporter.getFinishedSpans()[0]!.attributes["db.statement"]).toBe("select 1 where $1 = $1");
  });

  test("failure: span is marked errored and the caller still gets the error", async () => {
    exporter.reset();
    const err = await inTrace(() => tagged(CjsQuery, handler({ fail: true })).catch((e: Error) => e));
    expect((err as Error).message).toBe("boom");
    const [s] = exporter.getFinishedSpans();
    expect(s!.status.code).toBe(2);
  });

  test("awaiting the same query twice opens one span", async () => {
    exporter.reset();
    await inTrace(async () => {
      const q = tagged(CjsQuery);
      await q;
      await q;
    });
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  test("an awaited tagged query is located at its call site, from the construction stack", async () => {
    exporter.reset();
    await inTrace(async () => await tagged(CjsQuery));
    const [s] = exporter.getFinishedSpans();
    expect(s!.attributes["hoplens.file"]).toBe("test/postgres-hook.test.ts");
  });

  test("multi-statement simple query: row count is summed over the statements", async () => {
    exporter.reset();
    const multi = [result([{ a: 1 }], 1), result([], 4)];
    await inTrace(async () => await new CjsQuery("update t set a = 1; select 1", [], handler({ result: multi })));
    expect(exporter.getFinishedSpans()[0]!.attributes["db.rows"]).toBe(5);
  });

  test("identifier fragments in args are not reported as params once the statement is built", async () => {
    exporter.reset();
    const q = new CjsQuery(["select * from ", ""], [{ identifier: "users" }], (x: any) => {
      x.string = 'select * from "users"';
      x.parameters = [];
      setTimeout(() => x.resolve(result([], 0)), 1);
    });
    q.handler.debug = false;
    await inTrace(async () => await q);
    const [s] = exporter.getFinishedSpans();
    expect(s!.attributes["db.statement"]).toBe('select * from "users"');
    expect(s!.attributes["db.rows"]).toBe(0);
    expect(s!.attributes["hoplens.db.params"]).toBeUndefined();
  });

  test("sql.file() (no strings until the file is read) is still traced", async () => {
    exporter.reset();
    await inTrace(async () => await new CjsQuery([], [], handler({ sql: "select 42" })));
    expect(exporter.getFinishedSpans()[0]!.attributes["db.statement"]).toBe("select 42");
  });

  test("driver-internal queries (raw connection handler, no debug flag) are not traced", async () => {
    exporter.reset();
    const raw = (q: any) => setTimeout(() => q.resolve(result([], 0)), 1);
    await inTrace(async () => await new CjsQuery(["select b.oid from pg_catalog.pg_type"], [], raw));
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("a query cancelled before it runs opens no span", async () => {
    exporter.reset();
    const canceller = (q: any) => {
      q.cancelled = true;
      q.reject(new Error("canceling statement"));
    };
    const q = new CjsQuery(["select pg_sleep(1)"], [], handler(), canceller);
    q.cancel();
    await inTrace(async () => {
      await q.catch(() => undefined);
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    // Nothing left open either: a later traced query is the only span.
    await inTrace(async () => await tagged(CjsQuery));
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  test("streams are left alone", async () => {
    exporter.reset();
    await inTrace(async () => {
      const q = tagged(CjsQuery);
      q.streaming = true;
      await q;
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("outside a traced request nothing is recorded", async () => {
    exporter.reset();
    await tagged(CjsQuery);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("real client: a connection failure ends the span errored with the statement", async () => {
    exporter.reset();
    // A port nothing listens on: grab a free one and close it.
    const port = await new Promise<number>((ok) => {
      const srv = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => ok(p));
      });
    });
    const postgres = req("postgres");
    const sql = postgres({ host: "127.0.0.1", port, connect_timeout: 2, max: 1, onnotice: () => {} });
    try {
      const err = await inTrace(() => sql`select ${1}::int as n`.catch((e: Error) => e));
      expect(err).toBeInstanceOf(Error);
      const [s] = exporter.getFinishedSpans();
      expect(s!.name).toBe("postgres.query");
      expect(s!.status.code).toBe(2);
      expect(s!.attributes["db.statement"]).toBe("select $1::int as n");
      expect(s!.attributes["hoplens.file"]).toBe("test/postgres-hook.test.ts");
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
