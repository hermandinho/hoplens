// WP9c: module-level chunk diff (format sniff, module hashes, route -> chunk -> modules), its use by the
// epoch tracker (no-op rebuilds create no epoch, chunk-diff attribution, saves confirmed by the rebuilt
// code), routesVia "chunks" in /api/epochs, and the dist probe re-arming after `rm -rf .next`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { epochsService } from "../src/api/epochs";
import {
  ChunkIndex,
  type ChunkUpdate,
  moduleSourcePath,
  parseChunk,
  routeFromEntry,
  sniffChunkFormat,
} from "../src/chunkindex";
import { type ChunkDiffer, EpochTracker, type MtimeProbe, createEpochTracker, distMtimeProbe } from "../src/epoch";
import type { Runtime } from "../src/runtime";
import type { SourceChange, SourceWatcher } from "../src/sourcewatch";
import { RouteStatsStore } from "../src/stats";

/* ---------------------------------------------------------------- fixtures */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

function write(abs: string, text: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** A Turbopack (Next 16) server chunk with the given modules. */
function tpChunk(mods: Record<string, string>, mapTag = "x"): string {
  const parts = Object.entries(mods).map(
    ([id, body]) => `"${id}", ((__turbopack_context__) => {\n"use strict";\n\n${body}\n}),`,
  );
  return `module.exports = [\n${parts.join("\n")}\n];\n\n//# sourceMappingURL=${mapTag}._.js.map\n`;
}

/** A Turbopack route entry file loading the given chunks. */
function tpEntry(route: string, chunks: string[]): string {
  return [
    `var R=require("../../../chunks/[turbopack]_runtime.js")("server/app${route}/route.js")`,
    ...chunks.map((c) => `R.c("server/chunks/${c}")`),
    `module.exports=R.m("[project]/app-route.js [app-route] (ecmascript)").exports`,
  ].join("\n");
}

/**
 * A temp project whose Turbopack ids carry a monorepo prefix (`[project]/<dir name>/src/...`), like the
 * example under the workspace root, with three compiled routes: products and orders use the store,
 * feed doesn't.
 */
function tpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-wp9c-"));
  tmpDirs.push(root);
  const pfx = `[project]/${path.basename(root)}`;
  const id = (f: string) => `${pfx}/${f} [app-route] (ecmascript)`;
  write(path.join(root, "src/lib/store.ts"), "export const list = () => [1];\n");
  write(path.join(root, "src/lib/schemas.ts"), "export const Q = 1;\n");
  for (const r of ["products", "orders", "feed"]) write(path.join(root, `src/app/api/${r}/route.ts`), "export {}\n");
  const server = path.join(root, ".next", "dev", "server");
  const mods = {
    store: id("src/lib/store.ts"),
    schemas: id("src/lib/schemas.ts"),
    products: id("src/app/api/products/route.ts"),
    orders: id("src/app/api/orders/route.ts"),
    feed: id("src/app/api/feed/route.ts"),
    zod: "[project]/node_modules/.pnpm/zod@4.1.0/node_modules/zod/v4/core/core.js [app-route] (ecmascript)",
    internal: `${pfx}/.next-internal/server/app/api/feed/route/actions.js [app-rsc] (server actions loader, ecmascript)`,
  };
  const code = {
    store: "const list = () => [1];\n__turbopack_context__.s(['list', () => list]);",
    schemas: "const Q = 1;",
    products: "async function GET() { return list(); }",
    orders: "async function GET() { return list(); }",
    feed: "async function GET() { return Q; }",
    zod: "var core = {};",
    internal: "",
  };
  const chunk = (name: string, keys: (keyof typeof mods)[], over: Partial<typeof code> = {}, tag = "a") =>
    write(
      path.join(server, "chunks", name),
      tpChunk(Object.fromEntries(keys.map((k) => [mods[k], over[k] ?? code[k]])), tag),
    );
  const writeAll = (over: Partial<typeof code> = {}, tag = "a") => {
    chunk("[root-of-the-server]__p1._.js", ["products", "store", "schemas"], over, tag);
    chunk("[root-of-the-server]__o1._.js", ["orders", "store"], over, tag);
    chunk("[root-of-the-server]__f1._.js", ["feed", "schemas", "internal"], over, tag);
    chunk("1h6z_zod_v4_core_0abc._.js", ["zod"], over, tag);
    write(path.join(server, "chunks", "[turbopack]_runtime.js"), 'var RUNTIME_PUBLIC_PATH = "server/chunks/x";\n');
    write(
      path.join(server, "app/api/products/route.js"),
      tpEntry("/api/products", ["1h6z_zod_v4_core_0abc._.js", "[root-of-the-server]__p1._.js"]),
    );
    write(path.join(server, "app/api/orders/route.js"), tpEntry("/api/orders", ["[root-of-the-server]__o1._.js"]));
    write(path.join(server, "app/api/feed/route.js"), tpEntry("/api/feed", ["[root-of-the-server]__f1._.js"]));
  };
  writeAll();
  const allPaths = () => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) out.push(p);
      }
    };
    walk(server);
    return out;
  };
  return { root, server, mods, code, chunk, writeAll, allPaths };
}

/* ---------------------------------------------------------------- parsing */

describe("chunk format sniff and parse", () => {
  test("sniffChunkFormat", () => {
    expect(sniffChunkFormat(tpChunk({ "[project]/a.ts [app-route] (ecmascript)": "1" }))).toBe("turbopack-chunk");
    // Next 15 object shape, and the strict-mode IIFE variant Next 16 writes for some chunks.
    expect(
      sniffChunkFormat(
        `module.exports = {\n\n"[project]/a.ts [app-route] (ecmascript)": ((__turbopack_context__) => {\n}),\n};`,
      ),
    ).toBe("turbopack-chunk");
    expect(
      sniffChunkFormat(
        'module.exports = [\n(()=>{"use strict";return[\n"[project]/a.js [app-route] (ecmascript)", ((__turbopack_context__) => {\n}),\n]})()];',
      ),
    ).toBe("turbopack-chunk");
    expect(sniffChunkFormat(tpEntry("/api/x", ["a.js"]))).toBe("turbopack-entry");
    expect(sniffChunkFormat("var RUNTIME_PUBLIC_PATH = 'x';", "chunks/[turbopack]_runtime.js")).toBe(
      "turbopack-runtime",
    );
    expect(
      sniffChunkFormat(
        'exports.modules = {\n\n/***/ "(rsc)/./src/lib/store.ts":\n/***/ ((module, __webpack_exports__, __webpack_require__) => {\neval("x");\n/***/ }),\n};',
      ),
    ).toBe("webpack");
    expect(sniffChunkFormat("self.__BUILD_MANIFEST = {}")).toBe("unknown");
    expect(sniffChunkFormat("console.log(1)")).toBe("unknown");
  });

  test("module hashes ignore the source map comment; an edit changes only that module", () => {
    const a = "[project]/src/a.ts [app-route] (ecmascript)";
    const b = "[project]/src/b.ts [app-route] (ecmascript)";
    const one = parseChunk(tpChunk({ [a]: "const x = 1;", [b]: "const y = 2;" }, "one"));
    const same = parseChunk(tpChunk({ [a]: "const x = 1;", [b]: "const y = 2;" }, "two"));
    const edited = parseChunk(tpChunk({ [a]: "const x = 1;", [b]: "const y = 3;" }, "one"));
    expect([...one.modules.keys()]).toEqual([a, b]);
    expect(same.modules).toEqual(one.modules);
    expect(edited.modules.get(a)).toBe(one.modules.get(a));
    expect(edited.modules.get(b)).not.toBe(one.modules.get(b));
  });

  test("webpack modules: eval source maps stripped; vendor chunks become loads", () => {
    const wp = (code: string, map: string) =>
      [
        'exports.id = "app/api/products/route";',
        "exports.modules = {",
        "",
        '/***/ "(rsc)/./src/lib/store.ts":',
        "/***/ ((module, __webpack_exports__, __webpack_require__) => {",
        `eval("${code}\\n//# sourceURL=webpack-internal:///(rsc)/./src/lib/store.ts\\n//# sourceMappingURL=data:application/json;base64,${map}");`,
        "/***/ }),",
        "};",
        'var __webpack_exports__ = __webpack_require__.X(0, ["vendor-chunks/next","vendor-chunks/zod"], () => (__webpack_exec__("x")));',
      ].join("\n");
    const a = parseChunk(wp("const x = 1;", "AAAA"));
    const b = parseChunk(wp("const x = 1;", "BBBB"));
    const c = parseChunk(wp("const x = 2;", "AAAA"));
    expect(a.format).toBe("webpack");
    expect([...a.modules.keys()]).toEqual(["(rsc)/./src/lib/store.ts"]);
    expect(b.modules).toEqual(a.modules);
    expect(c.modules).not.toEqual(a.modules);
    expect(a.loads).toEqual(["vendor-chunks/next", "vendor-chunks/zod"]);
  });

  test("moduleSourcePath and routeFromEntry", () => {
    expect(moduleSourcePath("[project]/examples/next16-app/src/lib/store.ts [app-route] (ecmascript)")).toBe(
      "examples/next16-app/src/lib/store.ts",
    );
    expect(moduleSourcePath("[project]/src/app/page.tsx [app-rsc] (ecmascript, Next.js Server Component)")).toBe(
      "src/app/page.tsx",
    );
    expect(moduleSourcePath("[externals]/path [external] (path, cjs)")).toBeUndefined();
    expect(moduleSourcePath("(rsc)/./src/lib/store.ts")).toBe("src/lib/store.ts");
    expect(moduleSourcePath("./src/lib/store.ts")).toBe("src/lib/store.ts");
    expect(routeFromEntry("app/api/orders/[id]/route.js")).toBe("/api/orders/[id]");
    expect(routeFromEntry("app/page.js")).toBe("/");
    expect(routeFromEntry("app/(shop)/@modal/cart/page.js")).toBe("/cart");
    expect(routeFromEntry("pages/api/x.js")).toBe("/api/x");
    expect(routeFromEntry("pages/index.js")).toBe("/");
    expect(routeFromEntry("pages/_app.js")).toBeUndefined();
    expect(routeFromEntry("chunks/abc.js")).toBeUndefined();
    expect(routeFromEntry("app/api/x/route_client-reference-manifest.js")).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- the index */

describe("ChunkIndex", () => {
  test("an edit to store.ts: files and only the compiled routes that load it", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    expect(idx.describe([]).compiled).toEqual(["/api/feed", "/api/orders", "/api/products"]);

    p.writeAll({ store: "const list = () => [1, 2];\n__turbopack_context__.s(['list', () => list]);" }, "b");
    const u = idx.update(p.allPaths());
    expect(u).toMatchObject({ trusted: true, added: [], removed: [], modified: [p.mods.store] });
    const d = idx.describe(u.modified);
    expect(d.files).toEqual(["src/lib/store.ts"]);
    expect(d.routes).toEqual(["/api/orders", "/api/products"]);
    expect(d.external).toEqual([]);
  });

  test("a formatter-only rebuild (same module code, new source maps) changes nothing", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    p.writeAll({}, "formatted");
    const d = idx.diff(p.allPaths());
    expect(d).toMatchObject({ trusted: true, changed: [], files: [], routes: [] });
  });

  test("externals and .next-internal never show as project files; packages are named", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    p.writeAll({ zod: "var core = { v: 2 };", internal: "// changed" }, "c");
    const d = idx.diff(p.allPaths());
    expect(d.files).toEqual([]);
    expect(d.external).toEqual(["zod"]);
    expect(d.routes).toEqual(["/api/feed", "/api/products"]);
  });

  test("an unknown written file, an unprimed index or an overflow sweep past its budget make the diff untrusted", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next", { prime: false });
    // Not primed: everything is "added" and nothing is trusted.
    const cold = idx.update(p.allPaths());
    expect(cold.trusted).toBe(true); // no dir was ever primed, and update() itself built the baseline
    const idx2 = new ChunkIndex(p.root, ".next");
    expect(idx2.primed).toBe(false);
    expect(idx2.update([]).trusted).toBe(false);
    await until(() => idx2.primed);
    // An overflow is swept by mtime (see the Windows test below); only a sweep past its budget is untrusted.
    expect(idx2.update([], true).trusted).toBe(true);
    const small = new ChunkIndex(p.root, ".next", { maxSweepEntries: 3 });
    await until(() => small.primed);
    expect(small.update([], true).trusted).toBe(false);
    const odd = path.join(p.server, "chunks", "weird.js");
    write(odd, "console.log('not a chunk')");
    expect(idx2.update([odd]).trusted).toBe(false);
  });

  test("a module that moved to a new chunk is not a change; one gone from every chunk is removed", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    // orders' chunk is split in two under a new name: same code, no change.
    p.chunk("[root-of-the-server]__o2._.js", ["store"]);
    p.chunk("[root-of-the-server]__o1._.js", ["orders"]);
    const moved = idx.update([
      path.join(p.server, "chunks", "[root-of-the-server]__o2._.js"),
      path.join(p.server, "chunks", "[root-of-the-server]__o1._.js"),
    ]);
    expect(moved).toMatchObject({ trusted: true, added: [], modified: [], removed: [] });
    // feed stops importing schemas, and no other chunk... still has it (products): not removed.
    p.chunk("[root-of-the-server]__f1._.js", ["feed", "internal"], { feed: "async function GET() { return 1; }" });
    const u = idx.update([path.join(p.server, "chunks", "[root-of-the-server]__f1._.js")]);
    expect(u.modified).toEqual([p.mods.feed]);
    expect(u.removed).toEqual([]);
  });

  test("in a never-seen chunk: another hash of a project module is an edit, of a package module is not", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    // Next builds `next` twice under one id (pnpm peer variants), so package copies differ unedited.
    p.chunk("[root-of-the-server]__v2._.js", ["zod", "store"], { zod: "var core = { variant: 2 };", store: "edited" });
    const u = idx.update([path.join(p.server, "chunks", "[root-of-the-server]__v2._.js")]);
    expect(u.modified).toEqual([p.mods.store]);
    expect(u.added).toEqual([p.mods.zod]);
  });

  test("writes the watcher missed: new or moved route entries and the chunks they load are swept in", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    // A route compiled while no event arrived: entry + chunk on disk, never handed to update().
    p.chunk("[root-of-the-server]__x1._.js", ["store"]);
    write(path.join(p.server, "app/api/extra/route.js"), tpEntry("/api/extra", ["[root-of-the-server]__x1._.js"]));
    expect(idx.update([])).toMatchObject({ trusted: true, modified: [] });
    expect(idx.describe([]).compiled).toContain("/api/extra");
    p.writeAll({ store: "const list = () => [4];" }, "s");
    p.chunk("[root-of-the-server]__x1._.js", ["store"], { store: "const list = () => [4];" });
    const d = idx.diff([path.join(p.server, "chunks", "[root-of-the-server]__p1._.js")]);
    expect(d.routes).toEqual(["/api/extra", "/api/orders", "/api/products"]);
  });

  test("Windows watcher overflow (no names at all): the mtime sweep still finds the edit, trusted", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    expect(idx.sweepAll()).toEqual([]); // nothing moved since the prime
    await wait(20); // a distinct mtime even on coarse clocks
    p.writeAll({ store: "const list = () => [9];" }, "o");
    const u = idx.update([], true);
    expect(u).toMatchObject({ trusted: true, modified: [p.mods.store], added: [], removed: [] });
    expect(idx.describe(u.modified).routes).toEqual(["/api/orders", "/api/products"]);
    // Read once: the next overflow with nothing written sweeps nothing and changes nothing.
    expect(idx.sweepAll()).toEqual([]);
    expect(idx.update([], true)).toMatchObject({ trusted: true, modified: [] });
    // A formatter-only rebuild seen only as an overflow is still "no change".
    await wait(20);
    p.writeAll({ store: "const list = () => [9];" }, "fmt");
    expect(idx.update([], true)).toMatchObject({ trusted: true, modified: [], added: [], removed: [] });
  });

  test("rearm after the output dir is wiped and recreated: unchanged code stays unchanged", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    idx.rearm(p.server); // same dir: a no-op
    expect(idx.primed).toBe(true);
    fs.rmSync(path.join(p.root, ".next"), { recursive: true, force: true });
    p.writeAll({}, "fresh");
    idx.rearm(p.server);
    await until(() => idx.primed);
    expect(idx.diff(p.allPaths())).toMatchObject({ trusted: true, changed: [] });
    p.writeAll({ store: "const list = () => [];" }, "fresh2");
    const d = idx.diff(p.allPaths());
    expect(d.files).toEqual(["src/lib/store.ts"]);
    expect(d.routes).toEqual(["/api/orders", "/api/products"]);
  });

  test("after a wipe, routes not compiled again are no longer counted as compiled", async () => {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    fs.rmSync(path.join(p.root, ".next"), { recursive: true, force: true });
    // Only products is compiled again.
    p.chunk("[root-of-the-server]__p1._.js", ["products", "store", "schemas"]);
    write(
      path.join(p.server, "app/api/products/route.js"),
      tpEntry("/api/products", ["[root-of-the-server]__p1._.js"]),
    );
    idx.rearm(p.server);
    await until(() => idx.primed);
    expect(idx.describe([]).compiled).toEqual(["/api/products"]);
  });
});

/* ---------------------------------------------------------------- epoch tracker */

function fakeSources(): SourceWatcher & { push(c: SourceChange): void; pending: SourceChange[] } {
  const pending: SourceChange[] = [];
  return {
    pending,
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

/** A probe the test drives: mtime, chunk names and written paths. */
function fakeProbe(): MtimeProbe & { mtime: number; written: string[]; overflow: boolean } {
  const p = (() => p.mtime) as MtimeProbe & { mtime: number; written: string[]; overflow: boolean };
  p.mtime = 1000;
  p.written = [];
  p.overflow = false;
  p.drainNames = () => [];
  p.drainPaths = () => ({ paths: p.written.splice(0), overflow: p.overflow });
  return p;
}

describe("EpochTracker with the chunk diff", () => {
  async function setup() {
    const p = tpProject();
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    const probe = fakeProbe();
    const sources = fakeSources();
    let clock = 10_000;
    const tr = new EpochTracker(probe, 0, () => clock, 2000, 5000, { sources, chunks: idx });
    tr.observe("GET /api/products", false); // baseline mtime
    tr.observe("GET /api/feed", false);
    const rebuild = (over: Partial<typeof p.code>, tag: string) => {
      p.writeAll(over, tag);
      probe.written.push(...p.allPaths());
      probe.mtime = clock + 5;
      clock += 1000;
    };
    return { p, idx, probe, sources, tr, rebuild, tick: (ms: number) => (clock += ms), now: () => clock };
  }

  test("a formatter-only save creates no epoch, and its pending save is not pinned on the next rebuild", async () => {
    const s = await setup();
    s.sources.push({ file: "src/lib/store.ts", at: s.now(), kind: "change" }); // bytes changed: whitespace
    s.rebuild({}, "fmt");
    expect(s.tr.observe("GET /api/products", false).epoch).toBe(0);
    expect(s.tr.list()).toHaveLength(1);
    expect(s.sources.pending).toEqual([]);
    // A later real edit to another file names only that file.
    s.sources.push({ file: "src/lib/schemas.ts", at: s.now(), kind: "change" });
    s.rebuild({ schemas: "const Q = 2;" }, "real");
    expect(s.tr.observe("GET /api/products", false).epoch).toBe(1);
    expect(s.tr.info(1)).toMatchObject({ files: ["src/lib/schemas.ts"], via: "src-watch" });
  });

  test("an edit: saves confirmed by the rebuilt code; client-only saves dropped; routes from chunks", async () => {
    const s = await setup();
    s.sources.push({ file: "src/lib/store.ts", at: s.now(), kind: "change" });
    s.sources.push({ file: "src/components/Button.tsx", at: s.now(), kind: "change" }); // client-only
    s.rebuild({ store: "const list = () => [9];" }, "e1");
    expect(s.tr.observe("GET /api/feed", false).epoch).toBe(1);
    expect(s.tr.info(1)).toMatchObject({
      files: ["src/lib/store.ts"],
      via: "src-watch",
      chunkScope: { routes: ["/api/orders", "/api/products"], compiled: ["/api/feed", "/api/orders", "/api/products"] },
    });
  });

  test("no save seen (watcher off or missed it): via chunk-diff names the file", async () => {
    const s = await setup();
    s.rebuild({ store: "const list = () => [7];" }, "e2");
    s.tr.observe("GET /api/feed", false);
    expect(s.tr.info(1)).toMatchObject({ files: ["src/lib/store.ts"], via: "chunk-diff" });
  });

  test("only a package changed: candidates name it", async () => {
    const s = await setup();
    s.rebuild({ zod: "var core = 3;" }, "e3");
    s.tr.observe("GET /api/feed", false);
    expect(s.tr.info(1)).toMatchObject({ files: [], via: "candidates", candidates: ["zod"] });
  });

  test("an edit first written by a new-route compile is carried to the next rebuild", async () => {
    const s = await setup();
    // store.ts edited, then a never-seen route compiles first and writes the edited module.
    s.rebuild({ store: "const list = () => [5];" }, "e4");
    expect(s.tr.observe("GET /api/orders", true).epoch).toBe(0); // absorbed
    // The next rebuild rewrites products' chunks with the same (already seen) code.
    s.tick(5000);
    s.rebuild({ store: "const list = () => [5];" }, "e4b");
    expect(s.tr.observe("GET /api/products", false).epoch).toBe(1);
    expect(s.tr.info(1)).toMatchObject({ files: ["src/lib/store.ts"], via: "chunk-diff" });
  });

  test("late writes that only add modules (a route compiled for the first time) are no epoch", async () => {
    const s = await setup();
    const extra = path.join(s.p.server, "chunks", "[root-of-the-server]__n1._.js");
    write(
      extra,
      tpChunk({ [`[project]/${path.basename(s.p.root)}/src/app/api/new/route.ts [app-route] (ecmascript)`]: "1" }),
    );
    s.probe.written.push(extra);
    s.probe.mtime = s.now() + 5;
    s.tick(5000);
    expect(s.tr.observe("GET /api/products", false).epoch).toBe(0);
  });

  test("a module seen for the first time next to an edit is not attributed unless the watcher saw it saved", async () => {
    const s = await setup();
    const pfx = `[project]/${path.basename(s.p.root)}`;
    const missed = path.join(s.p.server, "chunks", "[root-of-the-server]__m1._.js");
    write(missed, tpChunk({ [`${pfx}/src/lib/other.ts [app-route] (ecmascript)`]: "x" }));
    write(path.join(s.p.root, "src/lib/other.ts"), "export {}");
    write(missed.replace("m1", "m2"), tpChunk({ [`${pfx}/src/lib/new.ts [app-route] (ecmascript)`]: "y" }));
    write(path.join(s.p.root, "src/lib/new.ts"), "export {}");
    s.sources.push({ file: "src/lib/new.ts", at: s.now(), kind: "change" });
    s.rebuild({ store: "const list = () => [3];" }, "e5");
    s.probe.written.push(missed, missed.replace("m1", "m2"));
    // other.ts: first seen now (its chunk was missed earlier), not saved -> not attributed;
    // new.ts: new and saved -> confirmed.
    s.tr.observe("GET /api/feed", false);
    expect(s.tr.info(1)?.files).toEqual(["src/lib/new.ts", "src/lib/store.ts"]);
  });

  test("a route compiled before the first probe is baselined, so a later edit to it is an epoch", async () => {
    // Next 16 loads instrumentation (and so creates the tracker) inside the first request, which then
    // compiles its route: those chunks are written before the build-output watcher saw anything, and
    // the first probe only took the baseline mtime. Measured on the next16 example (Turbopack): editing
    // that route rewrote its `[root-of-the-server]` chunk in place, every module read as "added", the
    // trusted diff had no edits and no epoch was created.
    const p = tpProject();
    const server = p.server;
    fs.rmSync(path.join(server, "app"), { recursive: true, force: true });
    fs.rmSync(path.join(server, "chunks"), { recursive: true, force: true });
    write(path.join(server, "chunks", "[turbopack]_runtime.js"), 'var RUNTIME_PUBLIC_PATH = "server/chunks/x";\n');
    const idx = new ChunkIndex(p.root, ".next");
    await until(() => idx.primed);
    const probe = fakeProbe();
    probe.mtime = 0; // nothing seen yet: the first compile happened before the watcher was armed
    const sources = fakeSources();
    let clock = 10_000;
    const tr = new EpochTracker(probe, 0, () => clock, 2000, 5000, { sources, chunks: idx });
    p.writeAll(); // the first request's on-demand compile
    expect(tr.observe("GET /api/products", true).epoch).toBe(0);
    clock += 30_000;
    tr.observe("GET /api/products", false);
    clock += 30_000;
    // The edit: products' chunk rewritten in place with the new route code.
    sources.push({ file: "src/app/api/products/route.ts", at: clock, kind: "change" });
    p.chunk("[root-of-the-server]__p1._.js", ["products", "store", "schemas"], {
      products: "async function GET() { return list().concat(2); }",
    });
    probe.written.push(path.join(server, "chunks", "[root-of-the-server]__p1._.js"));
    probe.mtime = clock + 5;
    clock += 1000;
    expect(tr.observe("GET /api/products", false).epoch).toBe(1);
    expect(tr.info(1)).toMatchObject({ files: ["src/app/api/products/route.ts"], via: "src-watch" });
    expect(tr.info(1)?.chunkScope?.routes).toEqual(["/api/products"]);
  });

  test("an untrusted diff falls back to the old rule (bump, watcher attribution)", async () => {
    const s = await setup();
    s.sources.push({ file: "src/lib/store.ts", at: s.now(), kind: "change" });
    s.rebuild({}, "same");
    s.probe.written.length = 0; // the names were lost too
    s.probe.overflow = true;
    (s.idx as unknown as { maxSweepEntries: number }).maxSweepEntries = 1; // and the sweep can't recover
    expect(s.tr.observe("GET /api/products", false).epoch).toBe(1);
    expect(s.tr.info(1)).toMatchObject({ files: ["src/lib/store.ts"], via: "src-watch" });
    expect(s.tr.info(1)?.chunkScope).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- api */

describe("/api/epochs with a chunk scope", () => {
  test("routesVia chunks: compiled routes from the chunks, uncompiled ones from the import graph", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-wp9c-api-"));
    tmpDirs.push(root);
    write(path.join(root, "src/lib/store.ts"), "export const list = 1;");
    write(path.join(root, "src/lib/types.ts"), 'import type { X } from "./store";\nexport type Y = X;');
    write(path.join(root, "src/app/api/products/route.ts"), 'import { list } from "../../../lib/store";');
    write(path.join(root, "src/app/api/feed/route.ts"), 'import type { Y } from "../../../lib/types";');
    write(path.join(root, "src/app/api/orders/route.ts"), 'import { list } from "../../../lib/store";');
    write(path.join(root, "src/app/api/report/route.ts"), "export {};");
    const probe = fakeProbe();
    let clock = 1;
    const chunks: ChunkDiffer = {
      update: (): ChunkUpdate => ({ trusted: true, added: [], modified: ["m"], removed: [] }),
      describe: () => ({
        trusted: true,
        changed: ["m"],
        files: ["src/lib/store.ts"],
        external: [],
        // feed imports store only for a type: the bundler erased it, so its chunks don't carry store.
        routes: ["/api/products"],
        compiled: ["/api/feed", "/api/products"],
      }),
    };
    const epochs = new EpochTracker(probe, 0, () => clock, 2000, 5000, { chunks });
    const route = (r: string) => ({ nextRoute: `/api/${r}`, file: `src/app/api/${r}/route.ts`, methods: [] });
    const rt = {
      root,
      options: {},
      epochs,
      stats: new RouteStatsStore(),
      store: { on() {}, off() {} },
      discover: () => ({ routes: ["products", "feed", "orders", "report"].map(route), typescript: true, scannedAt: 0 }),
    } as unknown as Runtime;
    epochs.observe("GET /api/products", false);
    probe.mtime = 2000;
    clock = 3000;
    epochs.observe("GET /api/products", false);
    const items = epochsService(rt).list().items;
    expect(items[0]).toMatchObject({
      id: 1,
      via: "chunk-diff",
      files: ["src/lib/store.ts"],
      routes: ["/api/orders", "/api/products"],
      routesVia: "chunks",
    });
    expect(items[0]).not.toHaveProperty("chunkScope");
  });
});

/* ---------------------------------------------------------------- probe re-arm */

describe("distMtimeProbe re-arms after rm -rf .next", () => {
  test("a wiped and recreated server dir is watched again and onArm fires", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-wp9c-rearm-"));
    tmpDirs.push(root);
    const server = path.join(root, ".next", "dev", "server");
    fs.mkdirSync(path.join(server, "chunks"), { recursive: true });
    const armed: string[] = [];
    const probe = distMtimeProbe(root, ".next", Date.now, 0, { onArm: (d) => armed.push(d) });
    probe();
    expect(armed).toEqual([server]);
    await wait(50);
    write(path.join(server, "chunks", "a._.js"), "1");
    await until(() => probe() > 0);
    const first = probe.drainPaths!();
    expect(first.paths).toContain(path.join(server, "chunks", "a._.js"));

    fs.rmSync(path.join(root, ".next"), { recursive: true, force: true });
    await wait(50);
    probe(); // notices the dir is gone
    fs.mkdirSync(path.join(server, "chunks"), { recursive: true });
    probe(); // a new dir: new watcher
    expect(armed).toEqual([server, server]);
    await wait(50);
    const before = probe();
    await wait(5);
    write(path.join(server, "chunks", "b._.js"), "2");
    await until(() => probe() > before);
    expect(probe.drainPaths!().paths).toContain(path.join(server, "chunks", "b._.js"));
  });

  test("a write burst is never silently lost: every name arrives, or the drain says overflow", async () => {
    // On Windows, ~50 synchronous writes overflow the watcher's buffer: one event with no file name.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-wp9c-burst-"));
    tmpDirs.push(root);
    const server = path.join(root, ".next", "dev", "server");
    fs.mkdirSync(path.join(server, "chunks"), { recursive: true });
    const probe = distMtimeProbe(root, ".next", Date.now, 0);
    probe();
    await wait(50);
    const n = 300;
    const body = "x".repeat(4000);
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(server, "chunks", `c${i}._.js`), body);
    await until(() => probe() > 0);
    await wait(300);
    const d = probe.drainPaths!();
    const got = new Set(d.paths);
    const all = Array.from({ length: n }, (_, i) => path.join(server, "chunks", `c${i}._.js`)).every((p) => got.has(p));
    expect(all || d.overflow, `${got.size}/${n} names, overflow ${d.overflow}`).toBe(true);
    probe.close?.();
  });
});

describe("createEpochTracker in production", () => {
  test("NODE_ENV=production builds no chunk index (the output is never rewritten, so no prime)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-wp9c-prod-"));
    tmpDirs.push(root);
    write(path.join(root, ".next", "server", "app", "page.js"), "module.exports = 1;\n");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let prod: EpochTracker | undefined;
    let dev: EpochTracker | undefined;
    try {
      prod = createEpochTracker(root, ".next", { sources: false });
      expect((prod as unknown as { chunks?: unknown }).chunks).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prev;
      prod?.close();
    }
    try {
      dev = createEpochTracker(root, ".next", { sources: false });
      expect((dev as unknown as { chunks?: unknown }).chunks).toBeDefined();
    } finally {
      dev?.close();
    }
  });
});
