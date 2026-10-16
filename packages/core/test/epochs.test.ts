// WP9a: epoch attribution (source watcher + chunk-name candidates), the EpochInfo ring, the import
// graph behind "affected routes", the regression rule and the /api/epochs, /api/regressions and
// /api/epochs/events endpoints.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { endpoints as epochEndpoints, epochsService, start as startEpochs } from "../src/api/epochs";
import { sendJson } from "../src/api/module";
import { EpochTracker, type MtimeProbe, candidatesFromChunks } from "../src/epoch";
import { ImportGraph, importSpecifiers } from "../src/importgraph";
import { REGRESSION_RULE, RegressionTracker, compareEpochs } from "../src/regressions";
import type { Runtime } from "../src/runtime";
import { handleUi, mountApi } from "../src/server";
import { type SourceChange, type SourceWatcher, isSourceFile, watchSources } from "../src/sourcewatch";
import { type EpochStats, RouteStatsStore } from "../src/stats";
import type { Finding, TraceFacts, TraceRecord } from "../src/types";
import { makeTrace } from "./helpers";

/* ---------------------------------------------------------------- helpers */

const tmpDirs: string[] = [];
function tmpProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-wp9a-"));
  tmpDirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

/** A source watcher stub: changes are handed out by drain(t) like the real one. */
function fakeSources(changes: SourceChange[] = []): SourceWatcher & { push(c: SourceChange): void } {
  const pending = [...changes];
  return {
    push: (c) => pending.push(c),
    drain(t) {
      const out = pending.filter((c) => c.at <= t);
      for (const c of out) pending.splice(pending.indexOf(c), 1);
      return out;
    },
    peek: () => [...pending],
    active: true,
    close() {},
  };
}

/** A probe whose mtime and chunk names the test controls. */
function fakeProbe(): MtimeProbe & { mtime: number; names: string[] } {
  const p = (() => p.mtime) as MtimeProbe & { mtime: number; names: string[] };
  p.mtime = 1000;
  p.names = [];
  p.drainNames = () => p.names.splice(0);
  return p;
}

function facts(over: Partial<TraceFacts> = {}): TraceFacts {
  return {
    time: { db: 10, cache: 0, ext: 20, fn: 5, framework: 3, compile: 0, idle: 2 },
    reqBytes: 0,
    resBytes: 0,
    counts: { spans: 5, db: 1, fetch: 1, cache: 0, fn: 1, warn: 0, error: 0 },
    cold: false,
    compileMs: 0,
    droppedSpans: 0,
    epoch: 0,
    ...over,
  };
}

let seq = 0;
function trace(
  duration: number,
  epoch: number,
  f: Partial<TraceFacts> = {},
  over: Partial<TraceRecord> = {},
): TraceRecord {
  return makeTrace([], {
    id: `w${++seq}`,
    startedAt: 1000 + seq,
    duration,
    facts: facts({ epoch, ...f }),
    ...over,
  });
}

const nplus1: Finding = {
  rule: "n-plus-one",
  severity: "warn",
  title: "N+1: 50x SELECT",
  fingerprint: "n-plus-one:select",
} as unknown as Finding;

/* ------------------------------------------------------- EpochTracker info */

describe("EpochTracker attribution", () => {
  test("epoch 0 is the start; a rebuild after a source save is attributed via src-watch", () => {
    const probe = fakeProbe();
    let clock = 10_000;
    const sources = fakeSources();
    const tr = new EpochTracker(probe, 0, () => clock, 2000, 5000, { sources });
    expect(tr.list()).toMatchObject([{ id: 0, via: "start", files: [] }]);
    tr.observe("GET /a", false);
    sources.push({ file: "src/lib/store.ts", at: 10_500, kind: "change" });
    probe.mtime = 11_000;
    probe.names.push("chunks/ssr/[root-of-the-server]__0ew924pdv5wjw._.js", "app/api/products/route.js");
    clock = 12_000;
    expect(tr.observe("GET /a", false)).toEqual({ epoch: 1, firstInEpoch: true });
    const info = tr.info(1)!;
    expect(info).toMatchObject({
      id: 1,
      at: 12_000,
      rebuiltAt: 11_000,
      files: ["src/lib/store.ts"],
      via: "src-watch",
      candidates: ["app/api/products/route"],
    });
    expect(sources.peek()).toEqual([]);
  });

  test("no source change: chunk-name candidates, else unknown", () => {
    const probe = fakeProbe();
    let clock = 0;
    const tr = new EpochTracker(probe, 0, () => (clock += 10_000), 2000, 5000, { sources: fakeSources() });
    tr.observe("GET /a", false);
    probe.mtime = 2000;
    probe.names.push("app/api/feed/route.js");
    tr.observe("GET /a", false);
    expect(tr.info(1)).toMatchObject({ via: "candidates", candidates: ["app/api/feed/route"], files: [] });
    probe.mtime = 3000;
    probe.names.push("chunks/[root-of-the-server]__abc._.js");
    tr.observe("GET /a", false);
    expect(tr.info(2)).toMatchObject({ via: "unknown", candidates: [] });
  });

  test("a save made after the rebuild was noticed waits for the next rebuild", () => {
    const probe = fakeProbe();
    let clock = 10_000;
    const sources = fakeSources([{ file: "src/a.ts", at: 15_000, kind: "change" }]);
    const tr = new EpochTracker(probe, 0, () => clock, 2000, 5000, { sources });
    tr.observe("GET /a", false);
    probe.mtime = 11_000;
    clock = 12_000;
    tr.observe("GET /a", false);
    expect(tr.info(1)?.files).toEqual([]);
    probe.mtime = 16_000;
    clock = 17_000;
    tr.observe("GET /a", false);
    expect(tr.info(2)?.files).toEqual(["src/a.ts"]);
  });

  test("a new-route compile drains its chunk names but keeps pending source saves", () => {
    const probe = fakeProbe();
    let clock = 10_000;
    const sources = fakeSources([{ file: "src/lib/db.ts", at: 9000, kind: "change" }]);
    const tr = new EpochTracker(probe, 0, () => clock, 2000, 5000, { sources });
    tr.observe("GET /a", false);
    probe.mtime = 10_500;
    probe.names.push("app/api/b/route.js");
    clock = 11_000;
    expect(tr.observe("GET /b", true).epoch).toBe(0); // on-demand compile, not an edit
    expect(sources.peek()).toHaveLength(1);
    probe.mtime = 50_000;
    clock = 50_000;
    tr.observe("GET /a", false);
    expect(tr.info(1)).toMatchObject({ files: ["src/lib/db.ts"], candidates: [] });
  });

  test("ring keeps the newest maxInfos; listeners fire and a throwing one is contained", () => {
    const probe = fakeProbe();
    let clock = 0;
    const tr = new EpochTracker(probe, 0, () => (clock += 10_000), 2000, 5000, { maxInfos: 3 });
    const seen: number[] = [];
    tr.onEpoch(() => {
      throw new Error("boom");
    });
    const off = tr.onEpoch((i) => seen.push(i.id));
    tr.observe("GET /a", false);
    for (let i = 0; i < 4; i++) {
      probe.mtime += 100_000;
      tr.observe("GET /a", false);
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(tr.list().map((i) => i.id)).toEqual([2, 3, 4]);
    off();
    probe.mtime += 100_000;
    tr.observe("GET /a", false);
    expect(seen).toHaveLength(4);
  });

  test("a plain probe function (no drainNames) still works", () => {
    let mtime = 1;
    let clock = 0;
    const tr = new EpochTracker(
      () => mtime,
      0,
      () => (clock += 10_000),
    );
    tr.observe("GET /a", false);
    mtime = 2;
    expect(tr.observe("GET /a", false).epoch).toBe(1);
    expect(tr.info(1)).toMatchObject({ via: "unknown", files: [] });
    expect(tr.watchingSources).toBe(false);
  });

  test("candidatesFromChunks", () => {
    expect(
      candidatesFromChunks([
        "app/api/orders/[id]/route.js",
        "app\\api\\feed\\route.js",
        "chunks/0psy__next-internal_server_app_api_db_products_route_actions_10f95-hp6novx.js",
        "chunks/ssr/src_lib_store_ts_8f3a._.js",
        "chunks/[root-of-the-server]__0ew924pdv5wjw._.js",
        "chunks/0j8i_next_dist_compiled_12zuze54hntye._.js",
      ]),
    ).toEqual(["app/api/db/products/route", "app/api/feed/route", "app/api/orders/[id]/route", "src/lib/store.ts"]);
  });
});

/* ---------------------------------------------------------- source watcher */

describe("watchSources", () => {
  test("isSourceFile", () => {
    expect(isSourceFile("src/lib/store.ts")).toBe(true);
    expect(isSourceFile("src\\app\\api\\feed\\route.ts")).toBe(true);
    expect(isSourceFile("proxy.ts")).toBe(true);
    expect(isSourceFile("src/node_modules/x/index.js")).toBe(false);
    expect(isSourceFile(".next/server/app.js")).toBe(false);
    expect(isSourceFile("src/.git/HEAD")).toBe(false);
    expect(isSourceFile("next-env.d.ts")).toBe(false);
    expect(isSourceFile("src/lib/store.test.ts")).toBe(false);
    expect(isSourceFile("src/app/globals.css")).toBe(false);
    expect(isSourceFile("tsconfig.tsbuildinfo")).toBe(false);
  });

  let w: SourceWatcher | undefined;
  afterEach(() => w?.close());

  test("a real save is pending until drained; a same-bytes save and ignored dirs are not", async () => {
    const root = tmpProject({
      "src/lib/store.ts": "export const a = 1;\n",
      "src/lib/same.ts": "export const b = 1;\n",
      "src/node_modules/x/index.js": "module.exports = 1;\n",
      "node_modules/y/index.js": "module.exports = 1;\n",
    });
    w = watchSources(root, { debounceMs: 30 });
    expect(w.active).toBe(true);
    await wait(150); // pre-hash
    fs.writeFileSync(path.join(root, "src/lib/same.ts"), "export const b = 1;\n"); // no-op save
    fs.writeFileSync(path.join(root, "src/node_modules/x/index.js"), "module.exports = 2;\n");
    fs.writeFileSync(path.join(root, "node_modules/y/index.js"), "module.exports = 2;\n");
    fs.writeFileSync(path.join(root, "src/lib/store.ts"), "export const a = 2;\n");
    await until(() => w!.peek().length > 0);
    await wait(100);
    expect(w.peek().map((c) => c.file)).toEqual(["src/lib/store.ts"]);
    expect(w.drain(0)).toEqual([]); // saved after t=0
    const got = w.drain(Date.now());
    expect(got).toMatchObject([{ file: "src/lib/store.ts", kind: "change" }]);
    expect(w.drain(Date.now())).toEqual([]);
  });

  test("deletes are reported; top-level files are watched without walking the root", async () => {
    const root = tmpProject({ "src/a.ts": "1", "proxy.ts": "export {}" });
    w = watchSources(root, { debounceMs: 30 });
    await wait(150);
    fs.rmSync(path.join(root, "src/a.ts"));
    fs.writeFileSync(path.join(root, "proxy.ts"), "export const x = 1;");
    await until(() => w!.peek().length >= 2);
    expect(
      w
        .drain(Date.now())
        .map((c) => `${c.kind}:${c.file}`)
        .sort(),
    ).toEqual(["change:proxy.ts", "delete:src/a.ts"]);
  });

  test("without src/, existing fallback dirs are watched", async () => {
    const root = tmpProject({ "app/api/x/route.ts": "export function GET() {}", "lib/db.ts": "1" });
    w = watchSources(root, { debounceMs: 30 });
    await wait(150);
    fs.writeFileSync(path.join(root, "lib/db.ts"), "2");
    await until(() => w!.peek().length > 0);
    expect(w.drain(Date.now()).map((c) => c.file)).toEqual(["lib/db.ts"]);
  });
});

/* ------------------------------------------------------------ import graph */

describe("ImportGraph", () => {
  test("importSpecifiers", () => {
    const src = `import a from "./a";
import type { B } from '@/lib/b';
import {
  c,
  d,
} from "../c";
export * from "./e";
import "./side";
const f = await import("./f");
const g = require("./g");
const s = "not from './h'";`;
    expect(importSpecifiers(src)).toEqual(["./a", "@/lib/b", "../c", "./e", "./side", "./f", "./g"]);
  });

  test("relative, alias and .js-for-.ts imports; only routes that reach the change", () => {
    const root = tmpProject({
      "tsconfig.json": `{
        // comment
        "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },
      }`,
      "src/app/api/products/route.ts": `import { list } from "@/lib/store";\nexport function GET() {}`,
      "src/app/api/catalog/route.ts": `import { cat } from "../../../lib/catalog.js";\nexport function GET() {}`,
      "src/app/api/feed/route.ts": `import { feed } from "@/lib/feed";\nimport x from "zod";\nexport function GET() {}`,
      "src/lib/store.ts": `import { q } from "./db";\nexport const list = q;`,
      "src/lib/catalog.ts": `export * from "./store";`,
      "src/lib/feed/index.ts": "export const feed = 1;",
      "src/lib/db.ts": "export const q = 1;",
    });
    const g = new ImportGraph(root);
    const routes = ["src/app/api/products/route.ts", "src/app/api/catalog/route.ts", "src/app/api/feed/route.ts"];
    expect([...g.affected(routes, ["src/lib/db.ts"])].sort()).toEqual([
      "src/app/api/catalog/route.ts",
      "src/app/api/products/route.ts",
    ]);
    expect([...g.affected(routes, ["src\\lib\\feed\\index.ts"])]).toEqual(["src/app/api/feed/route.ts"]);
    expect([...g.affected(routes, ["src/app/api/feed/route.ts"])]).toEqual(["src/app/api/feed/route.ts"]);
    expect(g.affected(routes, ["src/unrelated.ts"]).size).toBe(0);
  });
});

/* ------------------------------------------------------------- regressions */

describe("regressions", () => {
  const route = { key: "GET /api/products", method: "GET", route: "/api/products" };
  const ep = (epoch: number, warm: number, p50: number, over: Partial<EpochStats> = {}): EpochStats => ({
    epoch,
    count: warm,
    errors: 0,
    cold: 0,
    warm,
    p50,
    findings: [],
    firstSeen: 0,
    lastSeen: 0,
    ...over,
  });

  test("a traffic-mix change is not a regression: matched URL variants, weighted by the newer side", () => {
    const v = (url: string, warm: number, p50: number, db: number) => ({
      url,
      count: warm,
      warm,
      p50,
      p95: p50,
      time: { db: db * 5, cache: 0, ext: 0, fn: 10, framework: 0, compile: 0, idle: 0 },
      io: { db, fetch: 0, cache: 0, fn: 1 },
    });
    // Before: mostly ?mode=batch (fast, 1 query) plus some ?mode=n1. After: only ?mode=n1, which
    // itself got 40ms slower in its handler code. Route p50 would say +160ms and "db grew".
    const before = ep(0, 9, 66, {
      variants: [v("/api/products?mode=batch", 6, 50, 1), v("/api/products?mode=n1", 3, 178, 11)],
    });
    const after = ep(1, 5, 228, { variants: [v("/api/products?mode=n1", 5, 218, 11)] });
    const r = compareEpochs(route, before, after);
    expect(r.basis).toBe("variants");
    expect(r.urls).toEqual(["/api/products?mode=n1"]);
    expect(r.deltaMs).toBe(40);
    expect(r.status).toBe("regressed");
    expect(r.before).toMatchObject({ n: 3, p50: 178 });
    expect(r.after).toMatchObject({ n: 5, p50: 218 });
    expect(r.io?.db.delta).toBe(0);
    expect(r.grew).toBeUndefined();
  });

  test("no shared variant: falls back to the whole route", () => {
    const before = ep(0, 8, 41, { variants: [{ url: "/api/products?a=1", count: 8, warm: 8, p50: 41 }] });
    const after = ep(1, 8, 96, { variants: [{ url: "/api/products?b=1", count: 8, warm: 8, p50: 96 }] });
    const r = compareEpochs(route, before, after);
    expect(r.basis).toBe("route");
    expect(r.deltaMs).toBe(55);
  });

  test("rule: max(20%, 5ms) with warm n >= 3 on both sides", () => {
    expect(compareEpochs(route, ep(0, 8, 41), ep(1, 8, 96)).status).toBe("regressed");
    expect(compareEpochs(route, ep(0, 8, 100), ep(1, 8, 119)).status).toBe("unchanged"); // +19%
    expect(compareEpochs(route, ep(0, 8, 100), ep(1, 8, 120)).status).toBe("regressed"); // +20%
    expect(compareEpochs(route, ep(0, 8, 10), ep(1, 8, 14.9)).status).toBe("unchanged"); // +49% but < 5ms
    expect(compareEpochs(route, ep(0, 8, 10), ep(1, 8, 15)).status).toBe("regressed");
    expect(compareEpochs(route, ep(0, 8, 340), ep(1, 8, 200)).status).toBe("improved");
    expect(compareEpochs(route, ep(0, 8, 41), ep(1, 2, 96)).status).toBe("insufficient");
    expect(compareEpochs(route, ep(0, 2, 41), ep(1, 8, 96)).status).toBe("insufficient");
    expect(compareEpochs(route, ep(0, 8, 41), ep(1, 7, 96)).lowConfidence).toBe(true);
    expect(compareEpochs(route, ep(0, 8, 41), ep(1, 8, 96)).lowConfidence).toBe(false);
    expect(REGRESSION_RULE).toMatchObject({ minPct: 0.2, minMs: 5, minN: 3, confidentN: 8 });
  });

  test("from RouteStatsStore: bucket that grew, io delta and finding diff", () => {
    const stats = new RouteStatsStore();
    for (let i = 0; i < 4; i++) stats.add(trace(41, 0));
    stats.add(trace(900, 1, { cold: true })); // cold: never in the sample
    for (let i = 0; i < 3; i++)
      stats.add(
        trace(
          96,
          1,
          { time: { db: 60, cache: 0, ext: 20, fn: 5, framework: 3, compile: 0, idle: 2 } },
          { findings: [nplus1] },
        ),
      );
    for (let i = 0; i < 3; i++) {
      const t = trace(96, 1, { time: { db: 60, cache: 0, ext: 20, fn: 5, framework: 3, compile: 0, idle: 2 } });
      t.facts!.counts.db = 50;
      stats.add(t);
    }
    const res = new RegressionTracker().evaluate(stats.snapshot());
    expect(res.items).toHaveLength(1);
    const r = res.items[0]!;
    expect(r).toMatchObject({
      key: "GET /api/products",
      epoch: 1,
      baselineEpoch: 0,
      status: "regressed",
      lowConfidence: true, // n 4|6
      before: { n: 4, count: 4 },
      after: { n: 6, count: 7 },
      grew: { bucket: "db", beforeMs: 10, afterMs: 60, deltaMs: 50 },
    });
    expect(r.deltaPct!).toBeGreaterThan(1);
    expect(r.io?.db).toMatchObject({ before: 1 });
    expect(r.io!.db.after).toBeGreaterThan(20);
    expect(r.findings.added.map((f) => f.fingerprint)).toEqual(["n-plus-one:select"]);
    expect(r.findings.removed).toEqual([]);
  });

  test("a regression appears once warm n reaches 3 after the edit", () => {
    const stats = new RouteStatsStore();
    const tr = new RegressionTracker();
    for (let i = 0; i < 3; i++) stats.add(trace(40, 0));
    stats.add(trace(90, 1));
    stats.add(trace(90, 1));
    expect(tr.evaluate(stats.snapshot()).items[0]?.status).toBe("insufficient");
    stats.add(trace(90, 1));
    expect(tr.evaluate(stats.snapshot()).items[0]?.status).toBe("regressed");
  });

  test("baseline stays the last good epoch, also after the store's epoch window drops it", () => {
    const stats = new RouteStatsStore({ maxEpochs: 2 });
    const tr = new RegressionTracker();
    for (let i = 0; i < 3; i++) stats.add(trace(40, 0));
    for (const e of [1, 2, 3]) {
      for (let i = 0; i < 3; i++) stats.add(trace(100, e));
      tr.evaluate(stats.snapshot()); // as after every epoch bump
    }
    const items = tr.evaluate(stats.snapshot()).items;
    // Kept epochs are 2 and 3; both still compared with epoch 0 (the last good one).
    expect(items.map((i) => [i.epoch, i.baselineEpoch, i.status])).toEqual([
      [3, 0, "regressed"],
      [2, 0, "regressed"],
    ]);
    expect(tr.baseline("GET /api/products")?.epoch).toBe(0);
    // A fix: back to 40ms becomes the new baseline.
    for (let i = 0; i < 3; i++) stats.add(trace(40, 4));
    const after = tr.evaluate(stats.snapshot()).items;
    expect(after[0]).toMatchObject({ epoch: 4, baselineEpoch: 0, status: "unchanged" });
    expect(tr.baseline("GET /api/products")?.epoch).toBe(4);
  });

  test("affected routes without traffic since the edit are listed as no-traffic", () => {
    const stats = new RouteStatsStore();
    for (let i = 0; i < 3; i++) stats.add(trace(40, 0));
    const res = new RegressionTracker().evaluate(stats.snapshot(), {
      epoch: 2,
      routes: [
        { route: "/api/products", methods: ["GET"] },
        { route: "/api/p/[id]", methods: ["GET", "DELETE"] },
      ],
    });
    expect(res.epoch).toBe(2);
    expect(res.items.map((i) => [i.key, i.status, i.baselineEpoch])).toEqual([
      ["DELETE /api/p/[id]", "no-traffic", undefined],
      ["GET /api/p/[id]", "no-traffic", undefined],
      ["GET /api/products", "no-traffic", 0],
    ]);
  });
});

/* ------------------------------------------------------------------ API */

describe("/api/epochs, /api/regressions, /api/epochs/events", () => {
  let server: http.Server;
  let base: string;
  const probe = fakeProbe();
  let clock = 100_000;
  const sources = fakeSources();
  const root = tmpProject({
    "src/app/api/products/route.ts": `import { list } from "@/lib/store";\nexport function GET() {}`,
    "src/app/api/feed/route.ts": "export function GET() {}",
    "src/lib/store.ts": "export const list = 1;",
    "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
  });
  const store = new EventEmitter();
  const rt = {
    root,
    options: {},
    epochs: new EpochTracker(probe, 0, () => clock, 2000, 5000, { sources }),
    stats: new RouteStatsStore(),
    store,
    discover: () => ({
      routes: [
        {
          nextRoute: "/api/products",
          file: "src/app/api/products/route.ts",
          methods: [{ method: "GET", line: 2 }],
        },
        { nextRoute: "/api/feed", file: "src/app/api/feed/route.ts", methods: [{ method: "GET", line: 1 }] },
      ],
      typescript: true,
      scannedAt: 0,
    }),
  } as unknown as Runtime;
  const finish = (t: TraceRecord) => {
    rt.stats.add(t);
    store.emit("done", t);
  };

  beforeAll(async () => {
    mountApi({ endpoints: epochEndpoints });
    server = http.createServer((req, res) => {
      handleUi(rt, req, res).catch((err) => sendJson(res, 500, { error: String(err) }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__hoplens`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  );

  test("epoch list with affected routes; regressions; SSE epoch + regression events", async () => {
    rt.epochs.observe("GET /api/products", false);
    for (let i = 0; i < 3; i++) finish(trace(40, 0));

    let res = await fetch(`${base}/api/epochs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ epoch: 0, sourceWatch: true, items: [{ id: 0, via: "start" }] });

    const ctrl = new AbortController();
    const sse = await fetch(`${base}/api/epochs/events`, { signal: ctrl.signal });
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    const reader = sse.body!.getReader();
    let text = "";
    const readUntil = async (needle: string) => {
      const dec = new TextDecoder();
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        text += dec.decode(value);
      }
    };
    await readUntil("event: hello");

    // Edit store.ts, Next rebuilds, the next request notices.
    sources.push({ file: "src/lib/store.ts", at: clock + 10, kind: "change" });
    probe.mtime = clock + 20;
    clock += 1000;
    expect(rt.epochs.observe("GET /api/products", false).epoch).toBe(1);
    await readUntil("event: epoch");
    const epochData = JSON.parse(text.split("event: epoch\ndata: ")[1]!.split("\n")[0]!);
    expect(epochData).toMatchObject({
      id: 1,
      files: ["src/lib/store.ts"],
      via: "src-watch",
      routes: ["/api/products"],
      routesVia: "imports",
    });

    res = await fetch(`${base}/api/regressions`);
    let body: any = await res.json();
    expect(body.items.map((i: any) => [i.key, i.status])).toEqual([["GET /api/products", "no-traffic"]]);

    for (let i = 0; i < 3; i++) finish(trace(96, 1));
    await readUntil("event: regression");
    expect(text).toContain('"status":"regressed"');

    // More traffic for the same verdict: announced once, not per check.
    for (let i = 0; i < 3; i++) finish(trace(97, 1));
    await wait(400);
    probe.mtime = clock + 20;
    clock += 1000;
    rt.epochs.observe("GET /api/products", false); // epoch 2: a marker to read up to
    await readUntil('"id":2');
    expect(text.split("event: regression").length - 1).toBe(1);

    res = await fetch(`${base}/api/regressions?status=regressed&epoch=1`);
    body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ key: "GET /api/products", baselineEpoch: 0, status: "regressed" });
    res = await fetch(`${base}/api/regressions?epoch=0`);
    expect(((await res.json()) as any).items).toEqual([]);

    res = await fetch(`${base}/api/epochs?limit=2`);
    body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual([2, 1]);
    expect(body.items[1]).toMatchObject({ id: 1, routes: ["/api/products"] });

    ctrl.abort();
    await reader.cancel().catch(() => undefined);
    await until(() => store.listenerCount("done") === 0);
  });
});

describe("EpochsService starts with the runtime", () => {
  test("the module start hook locks a route's baseline on an edit before any UI call", async () => {
    const probe = fakeProbe();
    let clock = 500_000;
    const store = new EventEmitter();
    const rt = {
      root: tmpProject({ "src/app/api/x/route.ts": "export function GET() {}" }),
      options: {},
      epochs: new EpochTracker(probe, 0, () => clock, 2000, 5000, { sources: fakeSources() }),
      stats: new RouteStatsStore(),
      store,
      discover: () => ({ routes: [], typescript: true, scannedAt: 0 }),
    } as unknown as Runtime;
    startEpochs(rt);
    rt.epochs.observe("GET /api/products", false);
    for (let i = 0; i < 3; i++) rt.stats.add(trace(40, 0));
    probe.mtime = clock + 20;
    clock += 1000;
    expect(rt.epochs.observe("GET /api/products", false).epoch).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(epochsService(rt).regressions.baseline("GET /api/products")?.epoch).toBe(0);
  });
});
