// Request path P5 reverse index (srcmap.ts) and the node-for-node carry-over (mapped.ts), on
// hand-written maps: VLQ decoding, the containment rule, monotonicity, multi-source maps,
// sourcesContent present / missing / different, line terminators, sectioned maps.
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CfgFile, CfgFunction } from "../src/path/cfg-model";
import { mapFunction } from "../src/path/mapped";
import {
  MapError,
  type RawMap,
  buildIndex,
  decodeMappings,
  inlineMap,
  lineStarts,
  resolveSource,
} from "../src/path/srcmap";
import { cfgOf } from "./path-cov";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let d = v & 31;
    v >>>= 5;
    if (v > 0) d |= 32;
    out += B64[d];
  } while (v > 0);
  return out;
}

/** Encode segments [genLine, genCol, source, srcLine, srcCol] (0-based) as a v3 mappings string. */
function encode(segs: Array<[number, number, number, number, number]>): string {
  const lines: string[][] = [];
  let ps = 0;
  let pl = 0;
  let pc = 0;
  let line = -1;
  let col = 0;
  for (const [gl, gc, s, sl, sc] of segs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    while (line < gl) {
      line++;
      lines[line] = [];
      col = 0;
    }
    lines[line]!.push(vlq(gc - col) + vlq(s - ps) + vlq(sl - pl) + vlq(sc - pc));
    col = gc;
    ps = s;
    pl = sl;
    pc = sc;
  }
  return lines.map((l) => (l ?? []).join(",")).join(";");
}

const ROOT = path.resolve("/proj");
const RAW_FILE = path.join(ROOT, "src", "a.ts");
const GEN_FILE = RAW_FILE;

const inline = (code: string, map: RawMap) =>
  `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;

/** Anchors at the given (gen offset, raw offset) pairs of single-line texts. */
function index(gen: string, raw: string, pairs: Array<[number, number, number?]>, extra: Partial<RawMap> = {}) {
  const map: RawMap = {
    version: 3,
    sources: ["a.ts", "other.ts"],
    mappings: encode(pairs.map(([g, r, s]) => [0, g, s ?? 0, 0, r])),
    ...extra,
  };
  return buildIndex({ generated: inline(gen, map), genFile: GEN_FILE, raw, rawFile: RAW_FILE });
}

describe("VLQ and the inline map", () => {
  test("decodeMappings: deltas, negative values, 1-field segments skipped, lines reset the column", () => {
    const m = encode([
      [0, 4, 0, 2, 10],
      [0, 9, 0, 1, 3],
      [2, 1, 1, 0, 0],
    ]);
    expect(decodeMappings(m)).toEqual([
      { line: 0, col: 4, source: 0, srcLine: 2, srcCol: 10 },
      { line: 0, col: 9, source: 0, srcLine: 1, srcCol: 3 },
      { line: 2, col: 1, source: 1, srcLine: 0, srcCol: 0 },
    ]);
    expect(decodeMappings("C,AAAA")).toEqual([{ line: 0, col: 1, source: 0, srcLine: 0, srcCol: 0 }]);
    expect(() => decodeMappings("A!AA")).toThrow(/base64/);
    expect(() => decodeMappings("AA")).toThrow(/fields/);
    expect(() => decodeMappings("g")).toThrow(/truncated/);
  });

  test("inlineMap: the last sourceMappingURL wins (Node's rule); a file URL is not inline", () => {
    const a = { version: 3, sources: ["x"], mappings: "" };
    const b = { version: 3, sources: ["y"], mappings: "" };
    const text = `${inline("f()", a)}g()\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(b)).toString("base64")}`;
    expect(inlineMap(text)?.sources).toEqual(["y"]);
    expect(inlineMap("f()\n//# sourceMappingURL=f.js.map\n")).toBeUndefined();
    expect(inlineMap("f()")).toBeUndefined();
    expect(inlineMap("//# sourceMappingURL=data:application/json;base64,!!!")).toBeUndefined();
    expect(
      inlineMap(`//# sourceMappingURL=data:application/json,${encodeURIComponent(JSON.stringify(a))}`)?.sources,
    ).toEqual(["x"]);
  });

  test("resolveSource: relative to the generated file, sourceRoot, file URLs, absolute paths; other schemes never", () => {
    expect(resolveSource("a.ts", undefined, GEN_FILE)).toBe(RAW_FILE);
    expect(resolveSource("a.ts", "../src", path.join(ROOT, "dist", "a.js"))).toBe(RAW_FILE);
    expect(resolveSource(RAW_FILE, undefined, "/elsewhere/x.js")).toBe(RAW_FILE);
    expect(resolveSource("webpack:///src/a.ts", undefined, GEN_FILE)).toBeUndefined();
  });

  test("lineStarts: \\n and \\r\\n; a lone \\r, U+2028 or U+2029 refuses", () => {
    expect(lineStarts("a\nb\r\nc")).toEqual([0, 2, 5]);
    expect(lineStarts("a\rb")).toBeUndefined();
    expect(lineStarts("a b")).toBeUndefined();
    expect(lineStarts("a b")).toBeUndefined();
  });
});

describe("buildIndex refusals", () => {
  const why = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof MapError ? `${err.why}: ${err.message}` : `other: ${err}`;
    }
    return "built";
  };

  test("no inline map, no source naming the file, a broken map: unmapped", () => {
    expect(why(() => buildIndex({ generated: "f()", genFile: GEN_FILE, raw: "f()", rawFile: RAW_FILE }))).toMatch(
      /^unmapped: .*no inline source map/,
    );
    const elsewhere = { version: 3, sources: ["b.ts"], mappings: encode([[0, 0, 0, 0, 0]]) };
    expect(
      why(() => buildIndex({ generated: inline("f()", elsewhere), genFile: GEN_FILE, raw: "f()", rawFile: RAW_FILE })),
    ).toMatch(/^unmapped: .*no position in this file/);
    const broken = { version: 3, sources: ["a.ts"], mappings: "A!" };
    expect(
      why(() => buildIndex({ generated: inline("f()", broken), genFile: GEN_FILE, raw: "f()", rawFile: RAW_FILE })),
    ).toMatch(/^unmapped: .*does not decode/);
    expect(why(() => index("f()\rg()", "f()", [[0, 0]]))).toMatch(/^unmapped: .*line terminator/);
  });

  test("sourcesContent: equal or a prefix (Hoplens' trailer) builds; different is source-moved; missing (tsx's null) builds", () => {
    const raw = "export function f(a: number) { return a; }\n";
    const gen = "function f(a) { return a; }";
    const pairs: Array<[number, number]> = [[0, 7]];
    expect(why(() => index(gen, raw, pairs, { sourcesContent: [raw, null] }))).toBe("built");
    expect(why(() => index(gen, raw, pairs, { sourcesContent: [`${raw};__tpw(f)\n`, null] }))).toBe("built");
    expect(why(() => index(gen, raw, pairs, { sourcesContent: [null, null] }))).toBe("built");
    expect(why(() => index(gen, raw, pairs))).toBe("built");
    expect(why(() => index(gen, raw, pairs, { sourcesContent: [raw.replace("a;", "a + 1;"), null] }))).toMatch(
      /^source-moved/,
    );
  });

  test("a mapping past the raw file's end (Hoplens' trailer in the original) is foreign, not this file's", () => {
    const ix = index("abcdef", "abc", [
      [0, 0],
      [3, 3],
    ]);
    expect(ix.mapSpan(0, 3)).toMatchObject({ first: 0, last: 0 });
    expect(ix.mapSpan(0, 6)).toEqual({ why: "foreign" });
  });

  test("sectioned maps: each section's anchors move by its offset", () => {
    const raw = "aaaa\nbbbb\n";
    const sub = (line: number): RawMap => ({ version: 3, sources: ["a.ts"], mappings: encode([[0, 0, 0, line, 0]]) });
    const map: RawMap = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: sub(1) },
        { offset: { line: 1, column: 2 }, map: sub(0) },
      ],
    };
    const ix = buildIndex({ generated: inline("xxxx\nyyyy", map), genFile: GEN_FILE, raw, rawFile: RAW_FILE });
    expect(ix.mapSpan(0, 1)).toMatchObject({ first: 5 }); // line 0 col 0 -> raw line 1
    expect(ix.mapSpan(7, 8)).toMatchObject({ first: 0 }); // line 1 col 2 -> raw line 0
  });
});

describe("mapSpan: the containment rule", () => {
  const gen = "0123456789";
  const raw = "abcdefghijklmnopqrstuvwxyz";

  test("no anchor in the span", () => {
    const ix = index(gen, raw, [[5, 10]]);
    expect(ix.mapSpan(0, 5)).toEqual({ why: "no-anchor" });
    expect(ix.mapSpan(5, 6)).toEqual({ first: 10, last: 10, min: 10, max: 10, anchors: 1 });
    expect(ix.mapSpan(6, 9)).toEqual({ why: "no-anchor" });
  });

  test("monotonic: anchors going backwards refuse, unless the caller orders spans itself", () => {
    const ix = index(gen, raw, [
      [1, 4],
      [3, 12],
      [6, 8],
    ]);
    expect(ix.mapSpan(0, 10)).toEqual({ why: "backwards" });
    expect(ix.mapSpan(0, 10, { monotonic: false })).toEqual({ first: 4, last: 8, min: 4, max: 12, anchors: 3 });
    expect(ix.mapSpan(0, 4)).toMatchObject({ first: 4, last: 12 });
  });

  test("multi-source map: a span holding another source's anchor does not map", () => {
    const ix = index(gen, raw, [
      [1, 4],
      [4, 0, 1],
      [6, 8],
    ]);
    expect(ix.mapSpan(0, 3)).toMatchObject({ first: 4 });
    expect(ix.mapSpan(0, 5)).toEqual({ why: "foreign" });
    expect(ix.mapSpan(5, 10)).toMatchObject({ first: 8 });
    expect(ix.rawLine(4, 10)).toBe(1); // display lines skip foreign anchors
  });

  test("leadingTrivia: back over spaces and tabs on the line, never past a newline", () => {
    const text = "a;\n  \t b;";
    const ix = index(text, "a; b;", [[0, 0]]);
    expect(ix.leadingTrivia(text.indexOf("b"))).toBe(3);
    expect(ix.leadingTrivia(0)).toBe(0);
  });
});

describe("mapFunction: node for node, or UNKNOWN 'unmapped'", () => {
  const RAW = `export function f(a: number, b?: string): number {
  if (a > 1) {
    return a;
  }
  const x: number = b ? 1 : 2;
  return x;
}
`;
  /** Generated text + the anchors a compiler would emit for it (every token start of `tokens`). */
  function compiled(gen: string, tokens: Array<[string, string, number?]>) {
    let g = 0;
    let r = 0;
    const pairs: Array<[number, number]> = [];
    for (const [gt, rt, nth] of tokens) {
      g = gen.indexOf(gt, g);
      r = RAW.indexOf(rt, nth ?? r);
      if (g < 0 || r < 0) throw new Error(`token ${gt} / ${rt}`);
      pairs.push([g, r]);
    }
    const ix = index(gen, RAW, pairs);
    const genCfg = cfgOf(`${GEN_FILE}#g.js`, gen);
    const rawCfg = cfgOf(RAW_FILE, RAW);
    return { ix, genFn: genCfg!.functions[0] as CfgFunction, rawCfg: rawCfg as CfgFile };
  }
  const GEN = "function f(a,b){if(a>1){return a}const x=b?1:2;return x}";
  const ALL: Array<[string, string]> = [
    ["function", "function"],
    ["if(", "if ("],
    ["a>1", "a > 1"],
    ["return a", "return a"],
    ["const x", "const x"],
    ["b?1", "b ? 1"],
    ["1:", "1 :"],
    ["2;", "2;"],
    ["return x", "return x"],
  ];

  test("same shape, every node anchored inside its raw node: the hybrid has generated offsets and raw lines", () => {
    const { ix, genFn, rawCfg } = compiled(GEN, ALL);
    const m = mapFunction(genFn, rawCfg, ix);
    if ("why" in m) throw new Error(m.detail);
    expect(m.raw.name).toBe("f");
    expect(m.fn.start).toBe(genFn.start);
    expect(m.fn.end).toBe(genFn.end);
    expect(m.fn.line).toBe(1);
    const [iff, decl, ret] = m.fn.body.body as any[];
    expect([iff.k, iff.line, iff.label, iff.start]).toEqual(["if", 2, "a > 1", GEN.indexOf("if(")]);
    expect([decl.k, decl.line, decl.exprs[0].label]).toEqual(["stmt", 5, "b"]);
    expect(decl.exprs[0].arms.map((a: any) => a.start)).toEqual([GEN.indexOf("1:"), GEN.indexOf("2;")]);
    expect([ret.k, ret.line]).toEqual(["exit", 6]);
  });

  test("a statement the compiler dropped, or added: the shape breaks", () => {
    const dropped = compiled(
      "function f(a,b){if(a>1){return a}return x}",
      ALL.filter(([g]) => !["const x", "b?1", "1:", "2;"].includes(g)),
    );
    expect(mapFunction(dropped.genFn, dropped.rawCfg, dropped.ix)).toMatchObject({
      why: "unmapped",
      detail: expect.stringMatching(/3 statement\(s\) in the file, 2 in the generated code/),
    });
    const kinds = compiled("function f(a,b){if(a>1){return a}const x=b&&1;return x}", [
      ...ALL.slice(0, 5),
      ["b&&", "b ? 1"],
      ["return x", "return x"],
    ]);
    expect(mapFunction(kinds.genFn, kinds.rawCfg, kinds.ix)).toMatchObject({ why: "unmapped" });
  });

  test("an anchor landing outside its raw node, a node with no anchor, a foreign anchor: unmapped", () => {
    // `return a`'s anchor lands on the second return.
    const outside = compiled(GEN, [
      ...ALL.slice(0, 3),
      ["return a", "return x"],
      ...ALL.slice(4, 8).map(([g, r]): [string, string, number] => [g, r, 0]),
    ]);
    expect(mapFunction(outside.genFn, outside.rawCfg, outside.ix)).toMatchObject({
      why: "unmapped",
      detail: expect.stringMatching(/land outside/),
    });
    const bare = compiled(
      GEN,
      ALL.filter(([g]) => g !== "const x" && g !== "b?1" && g !== "1:" && g !== "2;"),
    );
    expect(mapFunction(bare.genFn, bare.rawCfg, bare.ix)).toMatchObject({
      why: "unmapped",
      detail: expect.stringMatching(/stmt at line 5 .*no source-map anchor/),
    });
    const { genFn, rawCfg } = compiled(GEN, ALL);
    const foreign = index(GEN, RAW, [
      [0, 7],
      [GEN.indexOf("const x"), 0, 1],
    ]);
    expect(mapFunction(genFn, rawCfg, foreign)).toMatchObject({
      why: "unmapped",
      detail: expect.stringMatching(/another source/),
    });
  });
});
