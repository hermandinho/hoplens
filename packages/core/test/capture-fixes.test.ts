import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyCold, classify, pickErrorOrigin, sameRequest } from "../src/capture";
import { EpochTracker, distMtimeProbe, isRebuildFile } from "../src/epoch";
import { computeFacts } from "../src/facts";
import { TraceStore, summarize } from "../src/store";
import { makeTrace, span } from "./helpers";

describe("sameRequest (regression: was ||)", () => {
  const t = { path: "/api/orders", method: "POST" };
  test("matches only when path AND method match", () => {
    expect(sameRequest(t, { url: "http://localhost:3000/api/orders", method: "POST" })).toBe(true);
  });
  test("an inner new Request() with the same method but another path is not the incoming request", () => {
    expect(sameRequest(t, { url: "https://api.stripe.com/v1/charges", method: "POST" })).toBe(false);
  });
  test("same path with another method is not the incoming request", () => {
    expect(sameRequest(t, { url: "http://localhost:3000/api/orders", method: "GET" })).toBe(false);
  });
});

describe("pickErrorOrigin (regression: picked latest-starting, not deepest)", () => {
  test("deepest errored span by parent chain wins even if it started earlier", () => {
    const err = (m: string) => ({ type: "Error", message: m, stack: "" });
    const root = span({ kind: "request", start: 0, end: 100, error: err("root") });
    const handler = span({ kind: "handler", parentId: root.id, start: 1, end: 99, error: err("handler") });
    const deep = span({ kind: "function", parentId: handler.id, start: 2, end: 10, error: err("deep") });
    // A later-starting but shallower errored sibling (e.g. an error log span on the handler).
    const late = span({ kind: "custom", parentId: root.id, start: 50, end: 60, error: err("late") });
    expect(pickErrorOrigin([root, handler, deep, late])?.error?.message).toBe("deep");
  });
  test("none / single", () => {
    expect(pickErrorOrigin([span({ kind: "request" })])).toBeUndefined();
    const one = span({ kind: "db", error: { type: "E", message: "m", stack: "" } });
    expect(pickErrorOrigin([one])).toBe(one);
  });
});

describe("classify: compile kind", () => {
  test.each([
    "NextNodeServer.findPageComponents",
    "LoadComponents.loadRouteModule",
    "RouteModule.prepare",
    "AppRouteRouteModule.loadUserland",
  ])("%s → compile", (type) => {
    expect(classify("x", type, {})).toBe("compile");
  });
  test("by span name and router stays router", () => {
    expect(classify("resolve page components", undefined, {})).toBe("compile");
    expect(classify("load route module", undefined, {})).toBe("compile");
    expect(classify("x", "NextNodeServer.getRequestHandler", {})).toBe("router");
    expect(classify("compileTemplate", undefined, {})).toBe("custom");
  });
  test("summary hop count ignores compile and router spans", () => {
    const t = makeTrace([span({ kind: "compile" }), span({ kind: "router" }), span({ kind: "handler" })]);
    expect(summarize(t).hops).toBe(1);
  });
});

describe("EpochTracker", () => {
  test("first hit per route per epoch is cold; output change bumps the epoch", () => {
    let mtime = 1000;
    let clock = 0;
    const tr = new EpochTracker(
      () => mtime,
      0,
      () => clock++,
    );
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 0, firstInEpoch: true });
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 0, firstInEpoch: false });
    mtime = 2000; // an edit rebuilt something
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 1, firstInEpoch: true });
    expect(tr.observe("GET /a", false).firstInEpoch).toBe(false);
  });

  test("on-demand compile of a brand-new route does not bump the epoch", () => {
    let mtime = 1000;
    const tr = new EpochTracker(() => mtime, 0);
    tr.observe("GET /a", false);
    mtime = 2000; // /b compiled on its first hit
    expect(tr.observe("GET /b", true)).toEqual({ epoch: 0, firstInEpoch: true });
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 0, firstInEpoch: false });
  });

  test("chunk writes trailing a new-route compile, seen by a later request, do not bump the epoch", () => {
    let mtime = 1000;
    let clock = 0;
    const tr = new EpochTracker(
      () => mtime,
      250,
      () => clock,
    );
    tr.observe("GET /a", false);
    clock = 1000;
    tr.observe("GET /b", true); // compiles /b on its first hit; probes even inside the throttle window
    mtime = 2000; // Turbopack finishes writing /b's chunks after the response
    clock = 1500;
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 0, firstInEpoch: false });
    // A real edit later on still bumps.
    mtime = 20_000;
    clock = 20_000;
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 1, firstInEpoch: true });
  });

  test("trailing writes made inside the settle window but first seen later do not bump", () => {
    let mtime = 0;
    let clock = 1000;
    const tr = new EpochTracker(
      () => mtime,
      0,
      () => clock,
    );
    tr.observe("GET /a", false);
    tr.observe("GET /b", true); // new-route compile at 1000
    mtime = 1500; // its chunks land 500ms later (watcher timestamp)...
    clock = 60_000; // ...but the next request only comes a minute later
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 0, firstInEpoch: false });
  });

  test("a full route map evicts the least recently seen route, not everything", () => {
    const tr = new EpochTracker(() => 1, 0, Date.now, 2000, 3);
    for (const r of ["a", "b", "c"]) tr.observe(r, false);
    tr.observe("a", false); // a is now the most recent
    tr.observe("d", false); // evicts b
    expect(tr.observe("a", false).firstInEpoch).toBe(false);
    expect(tr.observe("c", false).firstInEpoch).toBe(false);
    expect(tr.observe("b", false).firstInEpoch).toBe(true);
  });

  test("probe is throttled", () => {
    let calls = 0;
    const tr = new EpochTracker(
      () => {
        calls++;
        return 1;
      },
      1000,
      () => 5,
    );
    for (let i = 0; i < 10; i++) tr.observe("GET /a", false);
    expect(calls).toBe(1);
  });
});

describe("applyCold (regression: a fast first compile of a new route bumped the epoch)", () => {
  const facts = (compileMs: number) => ({ ...computeFacts(makeTrace([])), compileMs });
  test("first visit compiling in 71ms (< coldCompileMs) is a new-route compile, not an edit", () => {
    let mtime = 1000;
    let clock = 0;
    const tr = new EpochTracker(
      () => mtime,
      0,
      () => (clock += 10),
    );
    applyCold(tr, "GET /api/products", facts(4), 300);
    applyCold(tr, "GET /api/products", facts(4), 300);
    mtime = 2000; // Turbopack writes /api/newsletter's chunks
    const first = facts(71.65);
    applyCold(tr, "POST /api/newsletter", first, 300);
    expect(first).toMatchObject({ epoch: 0, cold: true });
    const warm = facts(4.36);
    applyCold(tr, "GET /api/products", warm, 300);
    expect(warm).toMatchObject({ epoch: 0, cold: false });
  });
  test("an edit still makes the next hit cold", () => {
    let mtime = 1000;
    let clock = 0;
    const tr = new EpochTracker(
      () => mtime,
      0,
      () => (clock += 10_000),
    );
    applyCold(tr, "GET /a", facts(4), 300);
    mtime = 50_000;
    const f = facts(5);
    applyCold(tr, "GET /a", f, 300);
    expect(f).toMatchObject({ epoch: 1, cold: true });
  });
});

describe("distMtimeProbe (regression: dir mtimes missed edits and counted manifest rewrites)", () => {
  test("isRebuildFile", () => {
    expect(isRebuildFile("chunks/ssr/[root-of-the-server]__0ew924pdv5wjw._.js")).toBe(true);
    expect(isRebuildFile("app/api/feed/route.js")).toBe(true);
    expect(isRebuildFile("1234.abcd.hot-update.js")).toBe(true);
    expect(isRebuildFile("chunks/x._.js.map")).toBe(false);
    expect(isRebuildFile("middleware-build-manifest.js")).toBe(false);
    expect(isRebuildFile("app-paths-manifest.json")).toBe(false);
    expect(isRebuildFile("app/page_client-reference-manifest.js")).toBe(false);
    expect(isRebuildFile("app/api/catalog")).toBe(false);
  });

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return cond();
  };

  test("in-place chunk rewrite counts; manifest rewrite and route dir churn don't", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-epoch-"));
    const server = path.join(root, ".next", "dev", "server");
    fs.mkdirSync(path.join(server, "chunks", "ssr"), { recursive: true });
    fs.writeFileSync(path.join(server, "chunks", "ssr", "a._.js"), "1");
    try {
      const probe = distMtimeProbe(root, ".next");
      expect(probe()).toBe(0); // arms the watcher
      await new Promise((r) => setTimeout(r, 100));
      // Manifest rewrite via temp file + rename (what moved the dir mtime), and a route dir created.
      fs.writeFileSync(path.join(server, "app-paths-manifest.json.tmp"), "{}");
      fs.renameSync(path.join(server, "app-paths-manifest.json.tmp"), path.join(server, "app-paths-manifest.json"));
      fs.writeFileSync(path.join(server, "next-font-manifest.js"), "x");
      fs.mkdirSync(path.join(server, "app", "api", "catalog"), { recursive: true });
      await new Promise((r) => setTimeout(r, 300));
      expect(probe()).toBe(0);
      // An edit: Turbopack rewrites an existing chunk in place (directory mtimes don't move).
      fs.writeFileSync(path.join(server, "chunks", "ssr", "a._.js"), "2");
      expect(await until(() => probe() > 0)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("TraceStore.finish after clear", () => {
  test("a trace cleared while in flight does not emit done", () => {
    const store = new TraceStore(10);
    const t = makeTrace([], { id: "tr_a", done: false });
    store.add(t, { rawHeaders: {} });
    const seen: string[] = [];
    store.on("done", (x) => seen.push(x.id));
    store.clear();
    store.finish(t);
    expect(seen).toEqual([]);
    const u = makeTrace([], { id: "tr_b", done: false });
    store.add(u, { rawHeaders: {} });
    store.finish(u);
    expect(seen).toEqual(["tr_b"]);
  });
});
