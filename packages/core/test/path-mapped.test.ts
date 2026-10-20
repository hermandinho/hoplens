// Request path P5 with real V8 block coverage: TypeScript run as a loader's output.
//
// ORACLE: the same raw .ts file run two ways in this process, both under precise coverage:
//   - identity: Node's own type stripping (module.stripTypeScriptTypes: types become spaces, so V8's
//     offsets are the file's) -> P2's identity analysis on the raw file. Ground truth.
//   - mapped: esbuild output with an inline source map (offsets shift; tsx-like minified and keepNames,
//     and plain) -> the generated text's own model, carried over by mapped.ts.
// Every function's analysis (decisions, arms, loops, exits, the flowchart) must come out equal; a
// shape the compiler changes must come back UNKNOWN 'unmapped', never counted.
import fs from "node:fs";
import { createRequire } from "node:module";
import nodeModule from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analyzePayload } from "../src/path/analyze";
import { type PathPayload, attachMapped, buildPayload } from "../src/path/capture";
import type { ScriptCoverage } from "../src/path/coverage";
import type { GeneratedLookup } from "../src/path/generated";
import { mapFunction } from "../src/path/mapped";
import { buildIndex } from "../src/path/srcmap";
import { type FnAnalysis, joinCfg, pathTruth } from "../src/path/truth";
import { makeTrace, span } from "./helpers";
import { FIXTURES, type FnCoverage, capture, cfgOf, load, startCoverage } from "./path-cov";

const REPO = path.resolve(__dirname, "..", "..", "..");
const esbuild = createRequire(require.resolve("tsx/package.json", { paths: [REPO] }))("esbuild") as {
  transformSync(code: string, opts: object): { code: string };
};
const strip = (nodeModule as any).stripTypeScriptTypes as ((code: string, o?: object) => string) | undefined;

const TS_DIR = path.join(FIXTURES, "ts");
const BRANCHY = path.join(TS_DIR, "branchy.ts");
const ENUMS = path.join(TS_DIR, "enums.ts");
const INVERTED = path.join(TS_DIR, "inverted.ts");
let tmp: string;
/** The identity run's analyses (the oracle), once its suite ran. */
let oracle: Record<string, FnAnalysis> | undefined;

beforeAll(() => {
  startCoverage();
  // realpath: on Windows os.tmpdir() can be an 8.3 short path (C:\Users\RUNNER~1 on GitHub runners)
  // while V8 reports the coverage script under the long one, so lookups by file URL would miss.
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-p5-")));
});
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

const VARIANTS = {
  "tsx-like": { minifyWhitespace: true, keepNames: true },
  plain: {},
  /** Not tsx: full minify rewrites expressions (inverts ternaries). Only for the shapes below. */
  minify: { minify: true },
} as const;

/** esbuild output of `raw` as CommonJS with an inline map whose source is the raw file. */
function compile(raw: string, variant: keyof typeof VARIANTS): string {
  return esbuild.transformSync(fs.readFileSync(raw, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "node20",
    sourcemap: "inline",
    sourcefile: raw,
    ...VARIANTS[variant],
  }).code;
}

/** Calls of the scenario, the same for both runs. */
async function scenario(m: any): Promise<void> {
  const items = [
    { id: 1, kind: "a" },
    { id: 0, kind: "c" },
    { id: -1, kind: "b" },
    { id: 5, kind: "d" },
  ];
  for (const it of items) m.classify(it, it.id > 2);
  m.scan(items, { limit: 10, pick: (x: { id: number }) => x.id >= 0 });
  m.scan(items, { limit: 0 });
  m.guarded(true);
  m.guarded(false);
  const t = new m.Tally();
  for (let i = 0; i < 4; i++) t.add("k");
  t.add("j", 5);
}

const NAMES = ["classify", "scan", "guarded", "add"] as const;

/**
 * The ranges of the function named `name`: the largest one (esbuild's CommonJS output also has an
 * export getter `rank: () => rank` V8 names after the export).
 */
function rangesOf(cov: FnCoverage[], name: string) {
  const f = cov
    .filter((x) => x.functionName === name && x.isBlockCoverage)
    .sort(
      (a, b) => b.ranges[0]!.endOffset - b.ranges[0]!.startOffset - (a.ranges[0]!.endOffset - a.ranges[0]!.startOffset),
    )[0];
  if (!f) throw new Error(`no block coverage for ${name}`);
  return f.ranges.map((r) => ({ start: r.startOffset, end: r.endOffset, count: r.count }));
}

/** Identity analysis of a script whose offsets are `cfgFile`'s. */
function identity(cov: Awaited<ReturnType<typeof capture>>, name: string, cfgFile: string, text: string): FnAnalysis {
  const cfg = cfgOf(cfgFile, text);
  const ranges = rangesOf(cov, name);
  const j = joinCfg({ cfg, ranges, capturedHash: "h", currentHash: "h" });
  if ("why" in j) throw new Error(`${name}: ${j.why}`);
  return pathTruth({ fn: j.fn, ranges, threw: 0, file: cfg });
}

/** The P5 path: the generated model, carried over to the raw file. */
function mapped(
  cov: Awaited<ReturnType<typeof capture>>,
  name: string,
  genFile: string,
  gen: string,
  rawFile: string,
): FnAnalysis | { why: string; detail: string } {
  const raw = fs.readFileSync(rawFile, "utf8");
  const genCfg = cfgOf(`${genFile}#generated.js`, gen);
  const rawCfg = cfgOf(rawFile, raw);
  const ranges = rangesOf(cov, name);
  const j = joinCfg({ cfg: genCfg, ranges, capturedHash: "g", currentHash: "g" });
  if ("why" in j) throw new Error(`${name}: generated join ${j.why}`);
  const index = buildIndex({ generated: gen, genFile, raw, rawFile });
  const hy = mapFunction(j.fn, rawCfg, index);
  if ("why" in hy) return hy;
  return pathTruth({ fn: hy.fn, ranges, threw: 0, file: rawCfg });
}

describe.skipIf(!strip)("P5 oracle: mapped == identity, on real coverage", () => {
  let truth: Record<string, FnAnalysis>;
  beforeAll(async () => {
    const stripped = strip!(fs.readFileSync(BRANCHY, "utf8"));
    // Same length, same offsets: the identity run is the raw file's own.
    expect(stripped.length).toBe(fs.readFileSync(BRANCHY, "utf8").length);
    const file = path.join(tmp, "branchy-stripped.mjs");
    fs.writeFileSync(file, stripped);
    const m = load(file);
    const cov = await capture(file, () => scenario(m));
    truth = Object.fromEntries(NAMES.map((n) => [n, identity(cov, n, BRANCHY, fs.readFileSync(BRANCHY, "utf8"))]));
    oracle = truth;
    // The ground truth itself (a few hand-checked arms).
    const arms = (a: FnAnalysis) => a.decisions.map((d) => d.arms.map((x) => x.count));
    expect(arms(truth.classify!)).toEqual([
      [1, 1, 2],
      [1, 1],
      [1, 0, 1, 1],
    ]);
    expect(truth.scan!.exits.map((e) => [e.kind, e.line, e.count])).toEqual([
      ["return", 50, 1],
      ["return", 57, 1],
    ]);
  });

  for (const variant of ["tsx-like", "plain"] as const) {
    test(`${variant}: every function's analysis equals the identity run`, async () => {
      const gen = compile(BRANCHY, variant);
      // The compiled text really moved: no function sits where the raw one does.
      expect(gen).not.toContain(fs.readFileSync(BRANCHY, "utf8").slice(0, 200));
      const file = path.join(tmp, `branchy-${variant}.cjs`);
      fs.writeFileSync(file, gen);
      const m = load(file);
      const cov = await capture(file, () => scenario(m));
      for (const name of NAMES) {
        const got = mapped(cov, name, file, gen, BRANCHY);
        expect(got, `${variant} ${name}`).toEqual(truth[name]);
      }
    });
  }
});

describe.skipIf(!strip)("a file saved with a UTF-8 BOM (identity)", () => {
  const root = () => path.join(tmp, "bom");
  /** The BOM'd raw file, run as `ran` (with or without the BOM), payload built and analyzed. */
  async function run(keepBom: boolean, tamper?: (cov: FnCoverage[]) => FnCoverage[]) {
    const ts = path.join(root(), "ts", "branchy.ts");
    fs.mkdirSync(path.dirname(ts), { recursive: true });
    const text = fs.readFileSync(BRANCHY, "utf8");
    fs.writeFileSync(ts, `\uFEFF${text}`);
    // `require` keeps a BOM in the text V8 compiles; `import` drops it (Node 22.20, probed).
    const file = path.join(root(), `branchy-bom-${keepBom ? "kept" : "dropped"}.mjs`);
    fs.writeFileSync(file, `${keepBom ? "\uFEFF" : ""}${strip!(text)}`);
    const m = load(file);
    let cov = await capture(file, () => scenario(m));
    expect(cov.length).toBeGreaterThan(0);
    if (tamper) cov = tamper(cov);
    const r = span({ kind: "request", name: "GET /x", start: 0, end: 10 });
    const trace = makeTrace([
      r,
      ...[0, 1, 2, 3].map((i) =>
        span({
          kind: "function",
          name: "classify",
          parentId: r.id,
          start: 1 + i,
          end: 2 + i,
          location: { file: "ts/branchy.ts", line: 21 },
        }),
      ),
    ]);
    const scripts: ScriptCoverage[] = [{ scriptId: "7", url: pathToFileURL(ts).href, functions: cov }];
    const built = buildPayload(trace, scripts, root(), (abs) => fs.readFileSync(abs, "utf8"), {
      generated: () => undefined,
    });
    const p = {
      v: 2,
      traceId: "t",
      replayOf: "s",
      quality: "exact",
      contamination: [],
      warnings: built.warnings,
      window: {
        quietMs: 0,
        settleMs: 0,
        taint: [],
        retries: 0,
        attempts: [],
        takeMs: [0, 0],
        scripts: 1,
        totalScripts: 1,
      },
      lanes: built.lanes,
      functions: built.functions,
    } as PathPayload;
    analyzePayload(p, { analyzer: { cfg: (abs: string, t: string) => cfgOf(abs, t) }, root: root() });
    return p;
  }

  for (const keep of [true, false]) {
    test(`V8's text ${keep ? "kept" : "dropped"} the BOM: joined, analysis as without one`, async () => {
      const p = await run(keep);
      const c = p.functions["ts/branchy.ts:21:classify"]!;
      expect(c).toMatchObject({ mapping: "identity", truth: { t: "taken", n: 4 }, startLine: 21, endLine: 44 });
      expect(!!c.bom).toBe(!keep);
      expect(c.analysis!.status).toBe("ok");
      if (oracle) expect(c.analysis).toEqual(oracle.classify);
    });
  }

  test("coverage that says neither: UNKNOWN 'unmapped', never shifted by a guess", async () => {
    // A module function whose length fits neither text (the take has one when the module ran in it).
    const p = await run(false, (cov) => [
      ...cov,
      { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 7, count: 1 }] },
    ]);
    expect(p.functions["ts/branchy.ts:21:classify"]!.truth).toEqual({ t: "unknown", why: "unmapped" });
    expect(p.warnings.join("\n")).toMatch(/byte-order mark/);
    // And the module function, when it is there, decides on its own.
    const q = await run(false, (cov) => [
      ...cov,
      {
        functionName: "",
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: fs.readFileSync(BRANCHY, "utf8").length, count: 1 }],
      },
    ]);
    expect(q.functions["ts/branchy.ts:21:classify"]).toMatchObject({ bom: true, truth: { t: "taken", n: 4 } });
  });
});

describe("P5: shapes only a compiler runs", () => {
  test("an inlined enum keeps the shape (mapped, exact); a dropped statement does not (UNKNOWN 'unmapped')", async () => {
    const gen = compile(ENUMS, "tsx-like");
    expect(gen).toContain("===2"); // Level.High inlined
    expect(gen).not.toContain("void 0;");
    const file = path.join(tmp, "enums.cjs");
    fs.writeFileSync(file, gen);
    const m = load(file);
    const cov = await capture(file, () => {
      m.rank(2, 11);
      m.rank(2, 3);
      m.rank(1, 3);
      m.dropped(true);
    });
    const rank = mapped(cov, "rank", file, gen, ENUMS) as FnAnalysis;
    expect(rank.status).toBe("ok");
    expect(rank.decisions.map((d) => [d.kind, d.line, d.label, d.arms.map((a) => `${a.label}=${a.count}`)])).toEqual([
      ["if", 9, "level === Level.High", ["then=2", "else=1"]],
      ["ternary", 10, "n > 10", ["true=1", "false=1"]],
    ]);
    expect(rank.exits.map((e) => [e.kind, e.line, e.count])).toEqual([
      ["return", 10, 2],
      ["return", 12, 1],
    ]);
    const dropped = mapped(cov, "dropped", file, gen, ENUMS);
    expect(dropped).toMatchObject({ why: "unmapped" });
    expect((dropped as { detail: string }).detail).toMatch(/statement/);
  });
});

describe("P5: a minifier that swaps a ternary's arms", () => {
  test("the arms' counts are never carried over swapped (UNKNOWN 'unmapped')", async () => {
    const gen = compile(INVERTED, "minify");
    // The swap really happened: the generated test is `a>0`, its true arm the raw false arm.
    expect(gen).toMatch(/>0\?\w+\(\):\w+\(\)/);
    const file = path.join(tmp, "inverted.cjs");
    fs.writeFileSync(file, gen);
    const m = load(file);
    const cov = await capture(file, () => {
      m.inv(5);
      m.inv(6);
      m.inv(7);
    });
    // V8 names the function by its minified binding (`inv` is the export getter's name).
    const name = /function (\w+)\(\w+\)\{for/.exec(gen)![1]!;
    const got = mapped(cov, name, file, gen, INVERTED);
    expect(got).toMatchObject({ why: "unmapped" });
    expect((got as { detail: string }).detail).toMatch(/arm/);
  });
});

describe("P5 payload: buildPayload + analyzePayload on a script V8 ran as esbuild output", () => {
  const analyzer = { cfg: (abs: string, text: string) => cfgOf(abs, text) };
  let gen: string;
  let cov: FnCoverage[];
  beforeAll(async () => {
    gen = compile(BRANCHY, "tsx-like");
    const file = path.join(tmp, "branchy-payload.cjs");
    fs.writeFileSync(file, gen);
    const m = load(file);
    cov = await capture(file, () => scenario(m));
  });

  /** Coverage as tsx reports it: the .ts URL, offsets into the generated text (module function last). */
  const scripts = (moduleLength = gen.length): ScriptCoverage[] => [
    {
      scriptId: "9",
      url: pathToFileURL(BRANCHY).href,
      functions: [
        ...cov.filter((f) => !(f.functionName === "" && f.ranges[0]?.startOffset === 0)),
        { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: moduleLength, count: 1 }] },
      ],
    },
  ];
  /** request -> handler -> classify x4, scan x2, guarded x2 (the scenario's calls), at their raw lines. */
  const trace = () => {
    const root = span({ kind: "request", name: "GET /x", start: 0, end: 10 });
    const fn = (name: string, line: number, i: number) =>
      span({
        kind: "function",
        name,
        parentId: root.id,
        start: 1 + i,
        end: 2 + i,
        location: { file: "ts/branchy.ts", line },
      });
    return makeTrace([
      root,
      ...[0, 1, 2, 3].map((i) => fn("classify", 21, i)),
      fn("scan", 46, 4),
      fn("scan", 46, 5),
      fn("guarded", 60, 6),
      fn("guarded", 60, 7),
    ]);
  };
  const lookup =
    (code: string | undefined): GeneratedLookup =>
    () =>
      code === undefined ? { missing: "compiled, no text" } : { code, via: "hook" };
  const read = (abs: string) => fs.readFileSync(abs, "utf8");

  function payload(built: ReturnType<typeof buildPayload>): PathPayload {
    const p = {
      v: 2,
      traceId: "tr_new",
      replayOf: "tr_old",
      quality: "exact",
      contamination: [],
      warnings: built.warnings,
      window: {
        quietMs: 0,
        settleMs: 0,
        taint: [],
        retries: 0,
        attempts: [],
        takeMs: [0, 0],
        scripts: 1,
        totalScripts: 1,
      },
      lanes: built.lanes,
      functions: built.functions,
    } as PathPayload;
    attachMapped(p, built.mapped);
    return p;
  }

  test("mapping 'sourcemap': the hops join by raw line, every analysis is the identity run's", () => {
    const built = buildPayload(trace(), scripts(), FIXTURES, read, { generated: lookup(gen) });
    expect(Object.keys(built.excess)).toEqual([]);
    const fns = built.functions;
    const c = fns["ts/branchy.ts:21:classify"]!;
    expect(c).toMatchObject({ mapping: "sourcemap", truth: { t: "taken", n: 4 }, calls: { hops: 4, coverage: 4 } });
    expect(c.generated).toMatchObject({ via: "hook", length: gen.length });
    // Range lines are the raw file's (through the anchors), inside the function.
    for (const r of c.ranges) expect(r.line >= 21 && r.endLine <= 44).toBe(true);
    const p = payload(built);
    analyzePayload(p, { analyzer, root: FIXTURES });
    expect(p.analysis?.error).toBeUndefined();
    for (const [key, name] of [
      ["ts/branchy.ts:21:classify", "classify"],
      ["ts/branchy.ts:46:scan", "scan"],
      ["ts/branchy.ts:60:guarded", "guarded"],
    ] as const) {
      const a = p.functions[key]!.analysis!;
      expect(a.status, key).toBe("ok");
      if (oracle) expect(a, key).toEqual(oracle[name]);
    }
    expect(p.functions["ts/branchy.ts:21:classify"]).toMatchObject({ startLine: 21, endLine: 44 });
  });

  test("UNKNOWN, never guessed: no text, a text V8 did not run, an edited file, a payload without its texts", () => {
    const none = buildPayload(trace(), scripts(), FIXTURES, read, { generated: lookup(undefined) });
    expect(none.functions["ts/branchy.ts:21:classify"]!.truth).toEqual({ t: "unknown", why: "no-generated-text" });
    expect(none.warnings).toContain("ts/branchy.ts: compiled, no text");

    const other = buildPayload(trace(), scripts(gen.length + 1), FIXTURES, read, { generated: lookup(gen) });
    expect(other.functions["ts/branchy.ts:21:classify"]!.truth).toEqual({ t: "unknown", why: "unmapped" });
    expect(other.warnings.join("\n")).toMatch(/is not the one V8 ran/);

    const noMap = buildPayload(trace(), scripts(), FIXTURES, read, {
      generated: lookup(gen.replace(/\/\/# sourceMappingURL=.*$/m, "")),
    });
    expect(noMap.functions["ts/branchy.ts:21:classify"]!.truth).toEqual({ t: "unknown", why: "unmapped" });

    const built = buildPayload(trace(), scripts(), FIXTURES, read, { generated: lookup(gen) });
    const edited = payload(built);
    analyzePayload(edited, { analyzer, root: FIXTURES, readSource: (abs) => `${read(abs)}\n// edited\n` });
    expect(edited.functions["ts/branchy.ts:21:classify"]!.analysis).toMatchObject({
      status: "unknown",
      why: "source-moved",
    });

    const again = buildPayload(trace(), scripts(), FIXTURES, read, { generated: lookup(gen) });
    const bare = { ...payload(again) } as PathPayload; // a copy: its texts are not attached
    analyzePayload(bare, { analyzer, root: FIXTURES });
    expect(bare.functions["ts/branchy.ts:21:classify"]!.analysis).toMatchObject({
      status: "unknown",
      why: "no-generated-text",
    });
  });

  test("decoded once: a later capture of the same texts reuses the index and the generated model", () => {
    let genBuilds = 0;
    const counting = {
      cfg: (abs: string, text: string) => {
        if (abs.includes("#hoplens-generated")) genBuilds++;
        return cfgOf(abs, text);
      },
    };
    const one = buildPayload(trace(), scripts(), FIXTURES, read, { generated: lookup(gen) });
    const two = buildPayload(trace(), scripts(), FIXTURES, read, { generated: lookup(gen) });
    const [m1] = [...one.mapped.values()];
    const [m2] = [...two.mapped.values()];
    expect(m1!.index).toBe(m2!.index);
    const p1 = payload(one);
    const p2 = payload(two);
    analyzePayload(p1, { analyzer: counting, root: FIXTURES });
    analyzePayload(p2, { analyzer: counting, root: FIXTURES });
    expect(genBuilds).toBe(1);
    expect(p2.functions["ts/branchy.ts:21:classify"]!.analysis).toEqual(
      p1.functions["ts/branchy.ts:21:classify"]!.analysis,
    );
  });

  test("identity is unchanged when no loader text is at hand (lookup answers nothing)", () => {
    const built = buildPayload(trace(), scripts(), FIXTURES, read, { generated: () => undefined });
    // Generated offsets read as the raw file's: the join finds no function on those lines.
    const c = built.functions["ts/branchy.ts:21:classify"]!;
    expect(c.mapping).not.toBe("sourcemap");
  });
});
