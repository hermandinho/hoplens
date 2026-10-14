import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isProjectFile,
  mapFrame,
  mapStack,
  normalizeSource,
  parseStack,
  resetEvalMaps,
  setDistDir,
} from "../src/sourcemap";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-smap-"));
  resetEvalMaps();
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function writeFile(rel: string, content: string) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** VLQ "AAAA" maps generated[0:0] → source 0, original[0:0]. */
const IDENTITY_MAPPINGS = "AAAA";

describe("parseStack", () => {
  test("parses standard V8 frames with function names", () => {
    const stack = "Error: boom\n    at myFn (/abs/path/file.ts:10:5)\n    at Object.<anonymous> (/other.ts:1:1)";
    const frames = parseStack(stack);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ fn: "myFn", file: "/abs/path/file.ts", line: 10, column: 5 });
    expect(frames[1]!.file).toBe("/other.ts");
  });

  test("parses anonymous frames", () => {
    const stack = "Error\n    at /abs/anon.ts:3:7";
    const frames = parseStack(stack);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ fn: undefined, file: "/abs/anon.ts", line: 3, column: 7 });
  });

  test("skips header lines and malformed lines", () => {
    const stack = `TypeError: oops\n    at ok (/x.ts:1:1)\nsome weird line without "at"\n    at /y.ts:2:2`;
    const frames = parseStack(stack);
    expect(frames.map((f) => f.file)).toEqual(["/x.ts", "/y.ts"]);
  });
});

describe("normalizeSource", () => {
  test("file:// → absolute path", () => {
    const abs = process.platform === "win32" ? "C:\\x\\y.ts" : "/x/y.ts";
    const url = process.platform === "win32" ? "file:///C:/x/y.ts" : "file:///x/y.ts";
    expect(normalizeSource(url, "/root")).toBe(abs);
  });

  test("turbopack:///[project]/… → joined with root", () => {
    const out = normalizeSource("turbopack:///[project]/src/x.ts", tmp);
    expect(out).toBe(path.join(tmp, "src/x.ts"));
  });

  test("webpack-internal:///(rsc)/./src/x.ts → joined with root", () => {
    const out = normalizeSource("webpack-internal:///(rsc)/./src/x.ts", tmp);
    expect(out).toBe(path.join(tmp, "src/x.ts"));
  });

  test("already absolute path returned as-is", () => {
    const abs = process.platform === "win32" ? "C:\\abs\\file.ts" : "/abs/file.ts";
    expect(normalizeSource(abs, "/other")).toBe(abs);
  });

  test("relative path resolved against mapDir", () => {
    const out = normalizeSource("../src/x.ts", tmp, path.join(tmp, "dist"));
    expect(out).toBe(path.join(tmp, "src/x.ts"));
  });
});

describe("isProjectFile", () => {
  test("file inside the project root is a project file", () => {
    const inside = path.join(tmp, "src", "x.ts");
    expect(isProjectFile(inside, tmp)).toBe(true);
  });

  test("node_modules under the project root is NOT a project file", () => {
    const nm = path.join(tmp, "node_modules", "some", "lib.js");
    expect(isProjectFile(nm, tmp)).toBe(false);
  });

  test(".next output under the project root is NOT a project file", () => {
    const nextOut = path.join(tmp, ".next", "server", "chunks", "x.js");
    expect(isProjectFile(nextOut, tmp)).toBe(false);
  });

  test("explicit foreign flag always wins", () => {
    const inside = path.join(tmp, "src", "x.ts");
    expect(isProjectFile(inside, tmp, true)).toBe(false);
  });

  test("file outside the project root is not a project file", () => {
    expect(isProjectFile("/elsewhere/x.ts", tmp)).toBe(false);
  });
});

describe("mapFrame — real .map files (Turbopack-style sibling .map)", () => {
  test("resolves generated line to original source", () => {
    const genFile = writeFile("dist/foo.js", `console.log("ok");\n`);
    writeFile(
      "dist/foo.js.map",
      JSON.stringify({
        version: 3,
        sources: ["../src/foo.ts"],
        mappings: IDENTITY_MAPPINGS,
        names: [],
      }),
    );
    writeFile("src/foo.ts", "console.log('ok');\n");

    const mapped = mapFrame({ file: genFile, line: 1, column: 1 }, tmp);
    expect(mapped.file).toBe(path.join(tmp, "src/foo.ts"));
    expect(mapped.line).toBe(1);
    expect(mapped.column).toBe(1);
    expect(mapped.foreign).toBe(false);
  });

  test("no .map file → frame returned as-is, project-local foreign flag", () => {
    const genFile = writeFile("src/plain.ts", "export const x = 1;\n");
    const mapped = mapFrame({ file: genFile, line: 1, column: 1 }, tmp);
    expect(mapped.file).toBe(genFile);
    expect(mapped.foreign).toBe(false);
  });

  test("corrupt .map file is tolerated and frame falls through", () => {
    const genFile = writeFile("dist/bad.js", "console.log('x');\n");
    writeFile("dist/bad.js.map", "{not valid json");
    const mapped = mapFrame({ file: genFile, line: 1, column: 1 }, tmp);
    expect(mapped.file).toBe(genFile);
  });

  test("map pointing at a non-existent file is treated as foreign when inside node_modules", () => {
    const genFile = writeFile("node_modules/some-lib/dist/ix.js", "x();\n");
    writeFile(
      "node_modules/some-lib/dist/ix.js.map",
      JSON.stringify({ version: 3, sources: ["../src/does-not-exist.ts"], mappings: IDENTITY_MAPPINGS, names: [] }),
    );
    const mapped = mapFrame({ file: genFile, line: 1, column: 1 }, tmp);
    expect(mapped.foreign).toBe(true);
    // The on-disk shipped file is kept, not the fake original path.
    expect(mapped.file).toBe(genFile);
  });
});

describe("mapFrame — webpack-internal fallback (no matching bundle)", () => {
  test("unknown webpack-internal URL → normalised to project path", () => {
    setDistDir(tmp, ".next");
    const mapped = mapFrame({ file: "webpack-internal:///(rsc)/./src/orphan.ts", line: 1, column: 1 }, tmp);
    expect(mapped.file).toBe(path.join(tmp, "src", "orphan.ts"));
  });

  // End-to-end verification of the eval-source-map scan path is covered by the live example-app
  // smoke in Phase 1 (next dev with webpack bundler emits real eval-source-maps that mapStack
  // resolves correctly). The scan + regex machinery is intentionally not unit-tested here because
  // scanBundles() carries throttled module-level state that doesn't suit isolated unit tests.
});

describe("mapStack formatting", () => {
  test("header line preserved, user frames first, >3 framework frames collapsed", () => {
    // Build a stack with one project frame + many framework frames.
    const projectFile = writeFile("src/me.ts", "export const x = 1;\n");
    const stack = [
      "Error: boom",
      `    at ok (${projectFile}:1:1)`,
      `    at fw1 (${path.join(tmp, "node_modules", "a", "a.js")}:1:1)`,
      `    at fw2 (${path.join(tmp, "node_modules", "b", "b.js")}:1:1)`,
      `    at fw3 (${path.join(tmp, "node_modules", "c", "c.js")}:1:1)`,
      `    at fw4 (${path.join(tmp, "node_modules", "d", "d.js")}:1:1)`,
      `    at fw5 (${path.join(tmp, "node_modules", "e", "e.js")}:1:1)`,
    ].join("\n");

    const out = mapStack(stack, tmp);
    expect(out.stack.split("\n")[0]).toBe("Error: boom");
    expect(out.location).toEqual({ file: "src/me.ts", line: 1, column: 1 });
    // Framework frames beyond 3 are collapsed.
    expect(out.stack).toContain("… 2 more framework frames");
    // User frame comes without the [framework] tag.
    expect(out.stack).toMatch(/at ok \(src\/me\.ts:1:1\)(?!.*\[framework\])/);
  });

  test("no project frames → location is undefined", () => {
    const stack = ["Error", `    at only (${path.join(tmp, "node_modules", "x", "x.js")}:1:1)`].join("\n");
    const out = mapStack(stack, tmp);
    expect(out.location).toBeUndefined();
  });

  test("empty stack produces an empty readable output", () => {
    const out = mapStack("", tmp);
    expect(out.location).toBeUndefined();
  });
});
