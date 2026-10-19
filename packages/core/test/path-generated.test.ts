// Request path P5, generated.ts: which scripts count as compiled, and the reason given when the text
// V8 ran is not at hand (each one names what this process can tell, never a fix that does not apply).
import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { compiledByMap, defaultLookup, generatedKey, missingReason } from "../src/path/generated";

const KEY = Symbol.for("hoplens.generated");
const g = globalThis as any;
const saved = g[KEY];
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete g[KEY];
  else g[KEY] = saved;
});

const ABS = path.resolve(__dirname, "fixtures", "path", "ts", "branchy.ts");

/** findSourceMap answering only for `key`, exactly (Node's cache is exact-match). */
function mapOnlyAt(key: string) {
  vi.spyOn(nodeModule as any, "findSourceMap").mockImplementation((p: unknown) =>
    p === key ? { payload: { version: 3, sources: [ABS], mappings: "" } } : undefined,
  );
}

describe("compiledByMap", () => {
  test("looks the map up by the script's own URL first (the drive letter's case is V8's, not the cwd's)", () => {
    const url = pathToFileURL(ABS).href;
    mapOnlyAt(url);
    // The hop's path with a lowercased drive letter (a `c:` cwd): Node's cache has no such key.
    const lower = process.platform === "win32" ? ABS[0]!.toLowerCase() + ABS.slice(1) : ABS;
    expect(compiledByMap(lower, url)).toBe(true);
    g[KEY] = { get: () => undefined, dropped: () => undefined };
    expect(defaultLookup()(url, lower, "1")).toHaveProperty("missing");
  });

  test("falls back to the path; no map is identity", () => {
    mapOnlyAt(ABS);
    expect(compiledByMap(ABS)).toBe(true);
    expect(compiledByMap(ABS, "file:///elsewhere.ts")).toBe(true);
    mapOnlyAt("nothing");
    expect(compiledByMap(ABS, pathToFileURL(ABS).href)).toBe(false);
    expect(defaultLookup()(pathToFileURL(ABS).href, ABS, "1")).toBeUndefined();
  });
});

describe("missingReason", () => {
  const reg = (dropped?: string) => ({
    get: () => undefined,
    dropped: (k: string) => (k === generatedKey(ABS) ? dropped : undefined),
  });

  test("no registry: Hoplens' loaders are off (function hops off), not the loader order", () => {
    delete g[KEY];
    const r = missingReason(ABS, { typescript: "strip" });
    expect(r).toMatch(/autoTrace/);
    expect(r).not.toMatch(/register Hoplens after/);
  });

  test("a size cap: says so", () => {
    g[KEY] = reg("oversize");
    expect(missingReason(ABS)).toMatch(/1MB per-file cap/);
    g[KEY] = reg("evicted");
    expect(missingReason(ABS)).toMatch(/least recently used/);
  });

  test("Node's --experimental-transform-types: names Node's transform, not tsx's order", () => {
    g[KEY] = reg();
    const r = missingReason(ABS, { typescript: "transform" });
    expect(r).toMatch(/experimental-transform-types/);
    expect(r).not.toMatch(/register Hoplens after/);
    expect(missingReason(ABS.replace(/\.ts$/, ".js"), { typescript: "transform" })).toMatch(/register Hoplens after/);
  });

  test("otherwise: the loader order (or the scope), and the Debugger opt-in", () => {
    g[KEY] = reg();
    const r = missingReason(ABS, { typescript: "strip" });
    expect(r).toMatch(/register Hoplens after it/);
    expect(r).toMatch(/HOPLENS_PATH_DEBUGGER=1/);
  });
});
