import { describe, expect, test } from "vitest";
import type { HostStat, QueryStat, TraceSummary } from "../src/api/types";
import {
  findShape,
  fmtPerRequest,
  groupByHost,
  holdOrder,
  hostOfShape,
  perRequest,
  stepShape,
} from "../src/state/queries";
import { foldBatches, splitUrl } from "../src/state/requestLog";

/* WP4 lists: the log's path + query split, and the Queries list | subject helpers.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/lists.test.ts */

const q = (fingerprint: string, extra: Partial<QueryStat> = {}): QueryStat => {
  const colon = fingerprint.indexOf(":");
  const prefix = fingerprint.slice(0, colon);
  return {
    fingerprint,
    kind: prefix === "fetch" ? "fetch" : prefix === "redis" ? "cache" : "db",
    shape: fingerprint.slice(colon + 1),
    calls: 1,
    traces: 1,
    timedCalls: 1,
    totalMs: 1,
    errors: 0,
    callers: [],
    routes: [],
    traceIds: [],
    lastSeen: 0,
    ...extra,
  };
};

const host = (h: string, calls: number): HostStat =>
  ({ host: h, calls, errorPct: 0, cachedPct: 0, uncachedPct: 0, statuses: {}, lastSeen: 0 }) as HostStat;

describe("splitUrl (log rows show the query dim after the path)", () => {
  test("keeps the query, so /api/feed variants differ", () => {
    expect(splitUrl("/api/feed", "/api/feed?fast=0")).toEqual({ path: "/api/feed", query: "?fast=0" });
    expect(splitUrl("/api/feed", "/api/feed?limit=10&fast=1")).toEqual({
      path: "/api/feed",
      query: "?limit=10&fast=1",
    });
  });
  test("no query, an empty one, a fragment, an absolute url", () => {
    expect(splitUrl("/api/cart", "/api/cart")).toEqual({ path: "/api/cart", query: "" });
    expect(splitUrl("/api/cart", "/api/cart?")).toEqual({ path: "/api/cart", query: "" });
    expect(splitUrl("/a", "/a?x=1#top")).toEqual({ path: "/a", query: "?x=1" });
    expect(splitUrl("/a", "http://localhost:3000/a?x=1")).toEqual({ path: "/a", query: "?x=1" });
    expect(splitUrl("/a", undefined)).toEqual({ path: "/a", query: "" });
  });
});

describe("findShape (#/q/<shape>)", () => {
  const list = [q("db:select 1"), q("fetch:GET api.x.dev/v1/a")];
  test("by fingerprint, else by bare shape", () => {
    expect(findShape(list, "fetch:GET api.x.dev/v1/a")?.fingerprint).toBe("fetch:GET api.x.dev/v1/a");
    expect(findShape(list, "select 1")?.fingerprint).toBe("db:select 1");
    expect(findShape(list, "db:nope")).toBeUndefined();
    expect(findShape(list, undefined)).toBeUndefined();
  });
});

describe("stepShape (j/k)", () => {
  const rows = [q("db:a"), q("db:b"), q("db:c")];
  test("moves within the list and stops at the ends", () => {
    expect(stepShape(rows, "db:a", 1)).toBe("db:b");
    expect(stepShape(rows, "db:b", -1)).toBe("db:a");
    expect(stepShape(rows, "db:c", 1)).toBe("db:c");
    expect(stepShape(rows, "db:a", -1)).toBe("db:a");
  });
  test("starts at the first (j) or last (k) row without a selection or when it left the list", () => {
    expect(stepShape(rows, undefined, 1)).toBe("db:a");
    expect(stepShape(rows, undefined, -1)).toBe("db:c");
    expect(stepShape(rows, "db:gone", 1)).toBe("db:a");
    expect(stepShape([], undefined, 1)).toBeUndefined();
  });
});

describe("holdOrder (never re-sort under the cursor)", () => {
  test("no hold: the given order", () => {
    const rows = [q("db:b"), q("db:a")];
    expect(holdOrder(rows, null)).toEqual({ rows, fresh: 0 });
  });
  test("held: the frozen order with fresh numbers, new shapes at the end and counted", () => {
    const resorted = [q("db:c", { totalMs: 99 }), q("db:a", { totalMs: 50 }), q("db:new"), q("db:b")];
    const out = holdOrder(resorted, ["db:a", "db:b", "db:c"]);
    expect(out.rows.map((r) => r.fingerprint)).toEqual(["db:a", "db:b", "db:c", "db:new"]);
    expect(out.rows[2]?.totalMs).toBe(99);
    expect(out.fresh).toBe(1);
  });
  test("held: a shape that disappeared is simply gone", () => {
    const out = holdOrder([q("db:b")], ["db:a", "db:b"]);
    expect(out.rows.map((r) => r.fingerprint)).toEqual(["db:b"]);
    expect(out.fresh).toBe(0);
  });
});

describe("loop marker", () => {
  test("calls per request", () => {
    expect(perRequest({ calls: 540, traces: 45 })).toBe(12);
    expect(perRequest({ calls: 3, traces: 0 })).toBe(0);
    expect(fmtPerRequest(12)).toBe("12");
    expect(fmtPerRequest(2.5)).toBe("2.5");
    expect(fmtPerRequest(2)).toBe("2");
    expect(fmtPerRequest(10.4)).toBe("10");
  });
});

describe("group by host", () => {
  test("hostOfShape reads the host of a fetch shape", () => {
    expect(hostOfShape("GET jsonplaceholder.typicode.com/users/:id")).toBe("jsonplaceholder.typicode.com");
    expect(hostOfShape("GET api.open-meteo.com/v1/forecast?latitude&longitude")).toBe("api.open-meteo.com");
    expect(hostOfShape("POST Example.COM?x")).toBe("example.com");
    expect(hostOfShape("GET localhost:3000/api/x")).toBe("localhost:3000");
    expect(hostOfShape("GET /api/self")).toBe("");
  });
  test("fetch shapes under their host, hosts in the server's order, unknown hosts after", () => {
    const groups = groupByHost(
      [
        q("db:select 1"),
        q("fetch:GET b.dev/x"),
        q("fetch:GET a.dev/y"),
        q("fetch:GET z.dev/q"),
        q("fetch:GET a.dev/z"),
        q("fetch:GET /api/self"),
      ],
      [host("a.dev", 9), host("b.dev", 3), host("idle.dev", 1)],
    );
    expect(groups.map((g) => [g.host, g.shapes.map((s) => s.shape)])).toEqual([
      ["a.dev", ["GET a.dev/y", "GET a.dev/z"]],
      ["b.dev", ["GET b.dev/x"]],
      ["idle.dev", []],
      ["z.dev", ["GET z.dev/q"]],
      ["", ["GET /api/self"]],
    ]);
    expect(groups[0]?.stat?.calls).toBe(9);
    expect(groups[3]?.stat).toBeUndefined();
  });
  test("with a sort, hosts follow the column (summed total), not the server's by-calls order", () => {
    const shapes = [
      q("fetch:GET slow.dev/a", { totalMs: 4000 }),
      q("fetch:GET busy.dev/a", { totalMs: 2000, calls: 30 }),
      q("fetch:GET slow.dev/b", { totalMs: 3000 }),
      q("fetch:GET busy.dev/b", { totalMs: 1500, calls: 20 }),
    ];
    const hosts = [host("busy.dev", 50), host("slow.dev", 2), host("idle.dev", 1)];
    const order = (o: Parameters<typeof groupByHost>[2]) => groupByHost(shapes, hosts, o).map((g) => g.host);
    expect(order({ by: "totalMs", desc: true })).toEqual(["slow.dev", "busy.dev", "idle.dev"]);
    expect(order({ by: "calls", desc: true })).toEqual(["busy.dev", "slow.dev", "idle.dev"]);
    // Held: the order the (frozen) shapes come in.
    expect(order("listed")).toEqual(["slow.dev", "busy.dev", "idle.dev"]);
    expect(groupByHost([...shapes].reverse(), hosts, "listed").map((g) => g.host)).toEqual([
      "busy.dev",
      "slow.dev",
      "idle.dev",
    ]);
  });
});

describe("foldBatches (a Replay xN batch is one log row)", () => {
  const t = (id: string, batchId?: string) => ({ id, batchId }) as TraceSummary;
  // Newest first, as the log lists them.
  const list = [t("n1"), t("b3", "B"), t("b2", "B"), t("b1", "B"), t("n0"), t("s1", "S")];

  test("keeps the newest run of each batch, in place, with its run count", () => {
    const { rows, batchSize } = foldBatches(list);
    expect(rows.map((r) => r.id)).toEqual(["n1", "b3", "n0", "s1"]);
    expect([...batchSize]).toEqual([["b3", 3]]);
  });

  test("a run opened from the replay strip stands in for its batch", () => {
    const { rows, batchSize } = foldBatches(list, "b2");
    expect(rows.map((r) => r.id)).toEqual(["n1", "b2", "n0", "s1"]);
    expect(batchSize.get("b2")).toBe(3);
  });

  test("a lone run (single-run batch) is a plain row", () => {
    expect(foldBatches(list, "s1").batchSize.has("s1")).toBe(false);
  });
});
