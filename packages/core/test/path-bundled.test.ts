// Request path P6: Next dev's bundled scripts (path/bundled.ts) on real Turbopack and webpack output.
//
// Fixtures (test/fixtures/path/next) come from the P6 probe of examples/next16-app under `next dev`
// (Next 16.4, Node 22.20): a Turbopack chunk holding the products route, lib/schemas and lib/store
// with its sectioned sidecar map, the webpack eval literals of the same three modules, the three
// source files as compiled, and two real coverage takes per bundler (GET /api/products once; then
// once more plus ?limit=abc), trimmed to those scripts plus one script of each kind that must be
// dropped. The probe ran in D:/WorkZone/hoplens-agents/p6/app: each test copies the fixture into a
// temp root and rewrites that prefix (map sources, script URLs, the webpack maps' absolute paths).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { analyzePayload } from "../src/path/analyze";
import { type BundledFs, BundledScripts } from "../src/path/bundled";
import { type PathPayload, attachMapped, buildPayload } from "../src/path/capture";
import type { ScriptCoverage } from "../src/path/coverage";
import type { FnAnalysis } from "../src/path/truth";
import type { TraceRecord } from "../src/types";
import { makeTrace, span } from "./helpers";
import { FIXTURES, cfgOf } from "./path-cov";

const FX = path.join(FIXTURES, "next");
const MAX_MS = 30_000;
const PROBE_ROOT = "D:/WorkZone/hoplens-agents/p6/app";
const PROBE_URL = "file:///D:/WorkZone/hoplens-agents/p6/app";
const CHUNK = "[root-of-the-server]__1jb02stmberme._.js";
const SOURCES = ["src/app/api/products/route.ts", "src/lib/schemas.ts", "src/lib/store.ts"];

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  }
});

/** A temp project with the three sources; returns its root and file:// URL (no trailing slash). */
function project(): { root: string; url: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-p6-")));
  roots.push(root);
  for (const f of SOURCES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(FX, f), path.join(root, f));
  }
  return { root, url: pathToFileURL(root).href };
}

const past = (file: string, ago = 60_000) => {
  const t = new Date(Date.now() - ago);
  fs.utimesSync(file, t, t);
};

type Takes = Record<"01-products1" | "02-products2", ScriptCoverage[]>;

function takes(kind: "turbopack" | "webpack", url: string): Takes {
  const text = fs
    .readFileSync(path.join(FX, kind, "takes.json"), "utf8")
    .split(PROBE_URL)
    .join(url);
  return JSON.parse(text);
}

/** The Turbopack chunk and its map under <root>/.next/dev/server/chunks, sources moved to `root`. */
function turbopack(): { root: string; chunk: string; takes: Takes } {
  const { root, url } = project();
  const dir = path.join(root, ".next", "dev", "server", "chunks");
  fs.mkdirSync(dir, { recursive: true });
  const chunk = path.join(dir, CHUNK);
  fs.copyFileSync(path.join(FX, "turbopack", CHUNK), chunk);
  const map = fs
    .readFileSync(path.join(FX, "turbopack", `${CHUNK}.map`), "utf8")
    .split(PROBE_URL)
    .join(url);
  fs.writeFileSync(`${chunk}.map`, map);
  past(chunk);
  past(`${chunk}.map`);
  return { root, chunk, takes: takes("turbopack", url) };
}

/** A webpack eval literal with its inline map's absolute source paths moved to `root`. */
function moveEval(text: string, root: string): string {
  const re = /(sourceMappingURL=data:application\/json;charset=utf-8;base64,)([A-Za-z0-9+/=]+)/;
  const m = re.exec(text)!;
  const map = JSON.parse(Buffer.from(m[2]!, "base64").toString("utf8"));
  const from = path.win32.normalize(PROBE_ROOT);
  map.sources = map.sources.map((s: string) => path.join(root, path.win32.relative(from, s).split("\\").join("/")));
  return text.replace(re, `$1${Buffer.from(JSON.stringify(map)).toString("base64")}`);
}

/** A bundle under <root>/.next/dev/server/app/api/products/route.js with the three eval modules. */
function webpack(over: { extra?: Record<string, string> } = {}): {
  root: string;
  bundle: string;
  modules: Record<string, string>;
  takes: Takes;
} {
  const { root, url } = project();
  const raw: Record<string, string> = JSON.parse(fs.readFileSync(path.join(FX, "webpack", "modules.json"), "utf8"));
  const modules: Record<string, string> = {};
  for (const [u, t] of Object.entries(raw)) modules[u] = moveEval(t, root);
  Object.assign(modules, over.extra ?? {});
  const body = Object.entries(modules)
    .map(
      ([u, t]) =>
        `/***/ "${u.replace("webpack-internal:///", "")}":\n/***/ (() => {\n"use strict";\neval(${JSON.stringify(t)});\n/***/ }),\n`,
    )
    .join("\n");
  const bundle = path.join(root, ".next", "dev", "server", "app", "api", "products", "route.js");
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, `(() => {\nvar exports = {};\nexports.modules = {\n${body}\n};\n})();\n`);
  past(bundle);
  // The texts moved: V8's top-level length is the moved text's (the map comment is at the end).
  const t = takes("webpack", url);
  for (const list of Object.values(t))
    for (const s of list) {
      const text = modules[s.url];
      const top = s.functions.find((f) => f.functionName === "" && f.ranges[0]?.startOffset === 0);
      if (text && top) top.ranges[0]!.endOffset = text.length;
    }
  return { root, bundle, modules, takes: t };
}

/** Feed every take to keep() as the capture window does (reset takes see the scripts too). */
function kept(b: BundledScripts, list: ScriptCoverage[]): ScriptCoverage[] {
  b.startTake();
  return list.filter((s) => b.keep(s.url, s));
}

/** GET /api/products: the handler hop on GET (route.ts:5) and listProducts (store.ts:11). */
function trace(calls = 1): TraceRecord {
  const root = span({ kind: "request", name: "GET /api/products" });
  const spans = [root];
  for (let i = 0; i < calls; i++) {
    const h = span({
      kind: "handler",
      name: "GET /api/products",
      parentId: root.id,
      start: 10 * i,
      location: { file: "src/app/api/products/route.ts", line: 5 },
    });
    spans.push(h);
  }
  const fn = span({
    kind: "function",
    name: "listProducts",
    parentId: spans[1]!.id,
    start: 1,
    location: { file: "src/lib/store.ts", line: 11 },
  });
  spans.push(fn);
  return makeTrace(spans, { id: "tr_p6" });
}

// A generous parse budget: the 22 KB chunk's model past the default 250 ms (a loaded machine, cold
// TypeScript) folds its blocks, and the function reads 'unmapped' instead of its branches.
const analyzer = { cfg: (abs: string, text: string) => cfgOf(abs, text, { maxMs: MAX_MS }) };

function payloadOf(
  root: string,
  b: BundledScripts,
  scripts: ScriptCoverage[],
  t: TraceRecord,
  opts: { debuggerSource?: boolean } = {},
): { p: PathPayload; warnings: string[] } {
  const r = b.resolve(scripts, opts);
  const built = buildPayload(t, scripts, root, (abs) => fs.readFileSync(abs, "utf8"), {
    generated: r.lookup,
    scriptFor: r.scriptFor,
    mtime: (abs) => fs.statSync(abs).mtimeMs,
    processStart: Date.now() - 10 * 60_000,
  });
  const p: PathPayload = {
    v: 2,
    traceId: t.id,
    replayOf: "src",
    quality: "exact",
    contamination: [],
    warnings: [...r.warnings, ...built.warnings],
    window: {
      quietMs: 0,
      settleMs: 0,
      taint: [],
      retries: 0,
      attempts: [],
      takeMs: [0, 0],
      scripts: scripts.length,
      totalScripts: scripts.length,
      bundled: r.counts,
    },
    lanes: built.lanes,
    functions: built.functions,
  };
  attachMapped(p, built.mapped);
  analyzePayload(p, { analyzer, root });
  return { p, warnings: p.warnings };
}

const fnOf = (p: PathPayload, name: string) => Object.values(p.functions).find((f) => f.name.startsWith(name))!;

/** `if label: then=n` for the first decision of an analysis. */
function firstIf(a: FnAnalysis | undefined): string {
  const d = a?.decisions[0];
  if (!d) return `none (${a?.why ?? a?.status})`;
  return `${d.kind} ${d.label}: ${d.arms.map((x) => `${x.label}=${x.taken === "unknown" ? `?${x.why}` : x.count}`).join(" ")}`;
}

describe("script filter", () => {
  test("keeps project chunks and project webpack modules, drops React fakes, empty URLs and frameworks", () => {
    const { root } = project();
    const b = new BundledScripts({ root });
    const u = pathToFileURL(root).href;
    expect(b.classify(`${u}/.next/dev/server/chunks/${CHUNK}`).kind).toBe("chunk");
    expect(
      b.classify(`${u}/.next/dev/server/chunks/x._.js?id=%5Bproject%5D/src/a.ts+%5Bapp-route%5D+(ecmascript)`).kind,
    ).toBe("hmr");
    expect(
      b.classify(
        `${u}/.next/dev/server/chunks/x._.js?id=%5Bproject%5D/node_modules/zod/a.js+%5Bapp-route%5D+(ecmascript)`,
      ).kind,
    ).toBe("framework");
    expect(b.classify("webpack-internal:///(rsc)/./src/app/api/products/route.ts").kind).toBe("webpack");
    expect(b.classify("webpack-internal:///(middleware)/./src/proxy.ts").kind).toBe("webpack");
    expect(b.classify("webpack-internal:///(rsc)/../../../Tracepath/node_modules/next/dist/x.js").kind).toBe(
      "framework",
    );
    expect(b.classify("webpack-internal:///(rsc)/./node_modules/zod/index.js").kind).toBe("framework");
    expect(b.classify("about://React/Prerender/webpack-internal:///(rsc)/./src/app/page.tsx?3").kind).toBe("react");
    expect(b.classify("").kind).toBe("empty");
    expect(b.classify("node:internal/per_context/primordials").kind).toBe("node");
    expect(b.classify(`${u}/node_modules/next/dist/server/lib/start-server.js`).kind).toBe("framework");
    expect(b.classify(`${u}/.next/dev/static/chunks/a.js`).kind).toBe("framework");
    expect(b.classify(`${u}/src/server.js`).kind).toBe("file");
  });

  test("real takes: only the project scripts survive, and every kind is counted", () => {
    const tp = turbopack();
    const b = new BundledScripts({ root: tp.root });
    const all = tp.takes["01-products1"];
    const k = kept(b, all);
    expect(k.map((s) => s.scriptId)).toEqual(["951"]);
    const r = b.resolve(k);
    expect(r.counts.kinds).toEqual({ chunk: 1, empty: 1, node: 1, framework: 2 });
    expect(r.counts.files).toBe(3);
    expect(r.counts.holding).toBe(1);

    const wp = webpack();
    const w = new BundledScripts({ root: wp.root });
    const wk = kept(w, wp.takes["01-products1"]);
    expect(wk.map((s) => s.url).sort()).toEqual([
      "webpack-internal:///(middleware)/./src/proxy.ts",
      "webpack-internal:///(rsc)/./src/app/api/products/route.ts",
      "webpack-internal:///(rsc)/./src/lib/schemas.ts",
      "webpack-internal:///(rsc)/./src/lib/store.ts",
    ]);
  });

  test("keep() decides once per script id: a later take reuses the entry", () => {
    const tp = turbopack();
    const b = new BundledScripts({ root: tp.root });
    const spy = { n: 0 };
    const orig = b.classify.bind(b);
    b.classify = (u: string) => {
      spy.n++;
      return orig(u);
    };
    kept(b, tp.takes["01-products1"]);
    const first = spy.n;
    kept(b, tp.takes["02-products2"]);
    // products2 has the same script ids for the same URLs: no new classification for them.
    expect(spy.n - first).toBeLessThanOrEqual(1);
  });
});

describe.each(["turbopack", "webpack"] as const)("%s mapping", (kind) => {
  const setup = () => (kind === "turbopack" ? turbopack() : webpack());

  test("GET /api/products once: the 422 arm is not taken, listProducts ran", () => {
    const fx = setup();
    const b = new BundledScripts({ root: fx.root });
    const scripts = kept(b, fx.takes["01-products1"]);
    const { p, warnings } = payloadOf(fx.root, b, scripts, trace(1));
    const get = fnOf(p, "GET");
    expect(get.mapping, warnings.join("\n")).toBe("sourcemap");
    expect(get.generated?.via).toBe("bundle");
    expect(get.stale).toBeUndefined();
    expect(get.truth).toEqual({ t: "taken", n: 1 });
    expect(firstIf(get.analysis), warnings.join("\n")).toBe("if !parsed.success: then=0 else=1");
    expect(get.analysis?.exits.filter((e) => e.count).map((e) => [e.kind, e.line])).toEqual([["return", 11]]);
    const list = fnOf(p, "listProducts");
    expect(list.truth.t, `${JSON.stringify(list.truth)} line ${list.line} ${warnings.join("\n")}`).toBe("taken");
  });

  test("GET twice, once with ?limit=abc: then 1 of 2", () => {
    const fx = setup();
    const b = new BundledScripts({ root: fx.root });
    kept(b, fx.takes["01-products1"]);
    const scripts = kept(b, fx.takes["02-products2"]);
    const { p, warnings } = payloadOf(fx.root, b, scripts, trace(2));
    const get = fnOf(p, "GET");
    expect(get.truth, warnings.join("\n")).toEqual({ t: "taken", n: 2 });
    expect(firstIf(get.analysis)).toBe("if !parsed.success: then=1 else=1");
  });

  test("an edit after the process started is not staleness: the map's sourcesContent is the file", () => {
    const fx = setup();
    for (const f of SOURCES) fs.utimesSync(path.join(fx.root, f), new Date(), new Date());
    const b = new BundledScripts({ root: fx.root });
    const scripts = kept(b, fx.takes["01-products1"]);
    const { p } = payloadOf(fx.root, b, scripts, trace(1));
    expect(fnOf(p, "GET").stale).toBeUndefined();
    expect(firstIf(fnOf(p, "GET").analysis)).toBe("if !parsed.success: then=0 else=1");
  });

  test("the file changed since the bundle was built: source-moved, never counted", () => {
    const fx = setup();
    const route = path.join(fx.root, "src/app/api/products/route.ts");
    fs.writeFileSync(route, fs.readFileSync(route, "utf8").replace("status: 422", "status: 400"));
    const b = new BundledScripts({ root: fx.root });
    const scripts = kept(b, fx.takes["01-products1"]);
    const { p } = payloadOf(fx.root, b, scripts, trace(1));
    const get = fnOf(p, "GET");
    expect(get.truth).toEqual({ t: "unknown", why: "source-moved" });
    expect(get.analysis?.decisions ?? []).toEqual([]);
  });

  test("the bundle was rewritten after V8 loaded the script: stale-chunk with the Debugger hint", () => {
    const fx = setup();
    const b = new BundledScripts({ root: fx.root });
    // Seen first (a reset take), then the bundler rewrites the file.
    kept(b, fx.takes["01-products1"]);
    const file =
      kind === "turbopack" ? (fx as ReturnType<typeof turbopack>).chunk : (fx as ReturnType<typeof webpack>).bundle;
    fs.appendFileSync(file, "\n");
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const scripts = kept(b, fx.takes["01-products1"]);
    const { p, warnings } = payloadOf(fx.root, b, scripts, trace(1));
    const get = fnOf(p, "GET");
    expect(get.truth).toEqual({ t: "unknown", why: "stale-chunk" });
    expect(warnings.join("\n")).toMatch(/HOPLENS_PATH_DEBUGGER=1/);
  });

  test("V8's script length is not the file's: stale-chunk, even with an old mtime", () => {
    const fx = setup();
    const b = new BundledScripts({ root: fx.root });
    const all = structuredClone(fx.takes["01-products1"]);
    for (const s of all) {
      const top = s.functions.find((f) => f.functionName === "" && f.ranges[0]?.startOffset === 0);
      if (top) top.ranges[0]!.endOffset += 7;
      else if (kind === "turbopack" && s.scriptId === "951")
        s.functions.unshift({
          functionName: "",
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 22195, count: 1 }],
        });
    }
    const scripts = kept(b, all);
    const { p } = payloadOf(fx.root, b, scripts, trace(1));
    expect(fnOf(p, "GET").truth).toEqual({ t: "unknown", why: "stale-chunk" });
  });

  test("with the Debugger read, a rewritten bundle's text comes from V8 and maps again", () => {
    const fx = setup();
    const file =
      kind === "turbopack" ? (fx as ReturnType<typeof turbopack>).chunk : (fx as ReturnType<typeof webpack>).bundle;
    const original = fs.readFileSync(file, "utf8");
    const v8 = new Map<string, string>();
    if (kind === "turbopack") v8.set("951", original);
    else
      for (const [u, t] of Object.entries((fx as ReturnType<typeof webpack>).modules)) {
        const s = fx.takes["01-products1"].find((x) => x.url === u);
        if (s) v8.set(s.scriptId, t);
      }
    const b = new BundledScripts({
      root: fx.root,
      debuggerRead: (ids) => ({ sources: new Map(ids.filter((i) => v8.has(i)).map((i) => [i, v8.get(i)!])), ms: 1 }),
    });
    kept(b, fx.takes["01-products1"]);
    // Rewritten: Turbopack moves every module down (a new module first); webpack re-emits the bundle.
    if (kind === "turbopack") {
      fs.writeFileSync(
        file,
        original.replace("module.exports = [\n", "module.exports = [\n// a module added above\n\n"),
      );
      const map = JSON.parse(fs.readFileSync(`${file}.map`, "utf8"));
      for (const s of map.sections) s.offset.line += 2;
      fs.writeFileSync(`${file}.map`, JSON.stringify(map));
    } else fs.writeFileSync(file, original.replace(/eval\("/g, 'eval("/* re-emitted */'));
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const scripts = kept(b, fx.takes["01-products1"]);
    const { p, warnings } = payloadOf(fx.root, b, scripts, trace(1), { debuggerSource: true });
    const get = fnOf(p, "GET");
    expect(get.generated?.via, warnings.join("\n")).toBe("debugger");
    expect(firstIf(get.analysis)).toBe("if !parsed.success: then=0 else=1");
  });
});

describe("which script holds a file", () => {
  test("a Turbopack HMR update without the Debugger: stale-chunk for the edited file only", () => {
    const fx = turbopack();
    const b = new BundledScripts({ root: fx.root });
    const base = fx.takes["01-products1"].find((s) => s.scriptId === "951")!;
    const hmrUrl = `${base.url.replace(CHUNK, "[root-of-the-server]__1n2qqea9vtcni._.js")}?id=%5Bproject%5D/src/app/api/products/route.ts+%5Bapp-route%5D+(ecmascript)`;
    // The old chunk still runs store.ts; the route's GET now runs in the HMR script.
    const old: ScriptCoverage = {
      ...base,
      functions: base.functions.filter((f) => f.functionName !== "GET"),
    };
    const hmr: ScriptCoverage = {
      scriptId: "2000",
      url: hmrUrl,
      functions: [
        { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 900, count: 1 }] },
        { functionName: "GET", isBlockCoverage: true, ranges: [{ startOffset: 300, endOffset: 700, count: 1 }] },
      ],
    };
    const scripts = kept(b, [old, hmr]);
    const r = b.resolve(scripts);
    expect(r.scriptFor(path.join(fx.root, "src/app/api/products/route.ts"))).toBe(hmr);
    expect(r.scriptFor(path.join(fx.root, "src/lib/store.ts"))).toBe(old);
    const { p } = payloadOf(fx.root, b, scripts, trace(1));
    expect(fnOf(p, "GET").truth).toEqual({ t: "unknown", why: "stale-chunk" });
    expect(fnOf(p, "listProducts").truth.t).toBe("taken");
  });

  test("a file whose code ran in two webpack layers is ambiguous: nothing is joined", () => {
    const fx = webpack();
    const store = "webpack-internal:///(rsc)/./src/lib/store.ts";
    const mw = "webpack-internal:///(middleware)/./src/lib/store.ts";
    const fx2 = webpack({
      extra: { [mw]: fx.modules[store]!.replace("(rsc)/./src/lib/store.ts", "(middleware)/./src/lib/store.ts") },
    });
    const b = new BundledScripts({ root: fx2.root });
    const list = fx2.takes["01-products1"];
    const rsc = list.find((s) => s.url === store)!;
    const copy: ScriptCoverage = { ...structuredClone(rsc), scriptId: "9999", url: mw };
    const top = copy.functions.find((f) => f.functionName === "" && f.ranges[0]?.startOffset === 0);
    if (top) top.ranges[0]!.endOffset = fx2.modules[mw]!.length;
    const scripts = kept(b, [...list, copy]);
    const { p, warnings } = payloadOf(fx2.root, b, scripts, trace(1));
    expect(fnOf(p, "listProducts").truth).toEqual({ t: "unknown", why: "bundle-copies" });
    expect(warnings.join("\n")).toMatch(/ran in 2 bundled copies/);
    // The route itself is unaffected.
    expect(fnOf(p, "GET").truth).toEqual({ t: "taken", n: 1 });
  });

  test("[project] ids under a Turbopack root above the app root resolve to the one file that exists", () => {
    const { root } = project();
    const b = new BundledScripts({ root });
    const parent = path.basename(root);
    const id = `[project]/${parent}/src/lib/store.ts [app-route] (ecmascript)`;
    const url = `${pathToFileURL(root).href}/.next/dev/server/chunks/a._.js?id=${encodeURIComponent(id).replace(/%20/g, "+")}`;
    const s: ScriptCoverage = {
      scriptId: "7",
      url,
      functions: [{ functionName: "x", isBlockCoverage: true, ranges: [{ startOffset: 1, endOffset: 5, count: 1 }] }],
    };
    expect(b.keep(url, s)).toBe(true);
    const r = b.resolve([s]);
    expect(r.scriptFor(path.join(root, "src/lib/store.ts"))).toBe(s);
  });
});

/** A file system that counts reads (the BundledFs default, wrapped). */
function countingFs(): { fs: BundledFs; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fs: {
      readFile(f) {
        reads.push(f);
        try {
          return fs.readFileSync(f, "utf8");
        } catch {
          return undefined;
        }
      },
      stat(f) {
        try {
          const st = fs.statSync(f);
          return { mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          return undefined;
        }
      },
      exists: (f) => fs.existsSync(f),
      jsFiles: () => [],
    },
  };
}

describe("chunks that cannot be read say why", () => {
  test("a chunk under the server output with no project module is not kept (framework, webpack-runtime)", () => {
    const { root, url } = project();
    const dir = path.join(root, ".next", "dev", "server", "chunks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fw._.js"),
      'module.exports = [\n"[project]/node_modules/next/dist/x.js [app-route] (ecmascript)", ((__turbopack_context__) => {}),\n];\n',
    );
    fs.writeFileSync(path.join(root, ".next", "dev", "server", "webpack-runtime.js"), "(() => { var x = 1; })();\n");
    const b = new BundledScripts({ root });
    const s = (id: string, u: string): ScriptCoverage => ({ scriptId: id, url: u, functions: [] });
    b.startTake();
    expect(b.keep(`${url}/.next/dev/server/chunks/fw._.js`, s("1", `${url}/.next/dev/server/chunks/fw._.js`))).toBe(
      false,
    );
    expect(
      b.keep(`${url}/.next/dev/server/webpack-runtime.js`, s("2", `${url}/.next/dev/server/webpack-runtime.js`)),
    ).toBe(false);
    expect(b.resolve([]).counts.kinds).toEqual({ framework: 2 });
  });

  test('Next 15\'s object chunk format (`"[project]/...": (ctx) => {`) is read as holding project code', () => {
    const { root, url } = project();
    const dir = path.join(root, ".next", "server", "chunks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "a._.js"),
      'module.exports = {\n\n"[project]/src/lib/store.ts [app-route] (ecmascript)": ((__turbopack_context__) => {\n}),\n};\n',
    );
    const b = new BundledScripts({ root });
    const u = `${url}/.next/server/chunks/a._.js`;
    expect(b.keep(u, { scriptId: "1", url: u, functions: [] })).toBe(true);
  });

  test("a project chunk whose map is missing: UNKNOWN 'unmapped' naming the chunk, for each of its files", () => {
    const fx = turbopack();
    fs.rmSync(`${fx.chunk}.map`);
    // Module ids under the temp root's parent (as Turbopack names them), so they resolve to the files.
    const ids = fs.readFileSync(fx.chunk, "utf8").split("[project]/hoplens-agents/p6/app/");
    fs.writeFileSync(fx.chunk, ids.join(`[project]/${path.basename(fx.root)}/`));
    past(fx.chunk);
    const b = new BundledScripts({ root: fx.root });
    const scripts = kept(b, fx.takes["01-products1"]);
    expect(scripts.map((s) => s.scriptId)).toEqual(["951"]);
    const r = b.resolve(scripts);
    expect(r.scriptFor(path.join(fx.root, "src/lib/store.ts"))).toBe(scripts[0]);
    const { p, warnings } = payloadOf(fx.root, b, scripts, trace(1));
    expect(fnOf(p, "GET").truth).toEqual({ t: "unknown", why: "unmapped" });
    expect(fnOf(p, "listProducts").truth).toEqual({ t: "unknown", why: "unmapped" });
    expect(warnings.join("\n")).toContain(`${CHUNK}'s map ${CHUNK}.map could not be read`);
  });

  test("a failed map read is not cached: the map lands and the next capture maps", () => {
    const fx = turbopack();
    const mapText = fs.readFileSync(`${fx.chunk}.map`, "utf8");
    fs.rmSync(`${fx.chunk}.map`);
    const b = new BundledScripts({ root: fx.root });
    const scripts = kept(b, fx.takes["01-products1"]);
    const { p } = payloadOf(fx.root, b, scripts, trace(1));
    // The fixture's ids name the probe's path, so no file is known: any project file is 'unmapped'.
    expect(fnOf(p, "GET").truth).toEqual({ t: "unknown", why: "unmapped" });
    // The chunk is unchanged (same mtime and size); only its map is now on disk.
    fs.writeFileSync(`${fx.chunk}.map`, mapText);
    past(`${fx.chunk}.map`);
    const again = payloadOf(fx.root, b, kept(b, fx.takes["01-products1"]), trace(1));
    expect(fnOf(again.p, "GET").truth).toEqual({ t: "taken", n: 1 });
  });

  test("a chunk over 4 MB is not read: UNKNOWN 'unmapped' naming the size, not join-mismatch", () => {
    const fx = turbopack();
    fs.appendFileSync(fx.chunk, `\n//${"x".repeat(4 * 1024 * 1024)}\n`);
    past(fx.chunk);
    const c = countingFs();
    const b = new BundledScripts({ root: fx.root, fs: c.fs });
    const scripts = kept(b, fx.takes["01-products1"]);
    expect(scripts.map((s) => s.scriptId)).toEqual(["951"]);
    const { p, warnings } = payloadOf(fx.root, b, scripts, trace(1));
    expect(c.reads.filter((f) => f === fx.chunk)).toEqual([]);
    expect(fnOf(p, "GET").truth).toEqual({ t: "unknown", why: "unmapped" });
    expect(warnings.join("\n")).toMatch(/over 4 MB/);
  });

  test("a webpack module with no inline map is 'unmapped', not 'stale-chunk' (nothing was edited)", () => {
    const fx0 = webpack();
    const store = "webpack-internal:///(rsc)/./src/lib/store.ts";
    const bare = fx0.modules[store]!.replace(/\n\/\/# sourceMappingURL=[^\n]*/, "");
    const fx = webpack({ extra: { [store]: bare } });
    const b = new BundledScripts({ root: fx.root });
    const scripts = kept(b, fx.takes["01-products1"]);
    const { p } = payloadOf(fx.root, b, scripts, trace(1));
    expect(fnOf(p, "listProducts").truth).toEqual({ t: "unknown", why: "unmapped" });
    expect(fnOf(p, "GET").truth).toEqual({ t: "taken", n: 1 });
  });
});
