// The generated-text registry the request path reads (src/generated.ts, plan P5): its bounds, and what
// register()'s loaders keep in it, through real child processes on the built dist/ with real tsx:
//   - ESM hook in COMPILED mode (`--import tsx --import <ours>`): tsx's output, as V8 runs it;
//   - CommonJS layer under tsx's require hook (`-r tsx/cjs -r <ours>`): what module._compile got;
//   - nothing for plain JavaScript, Node's own type stripping, tsx registered after Hoplens (RAW: the
//     hook never sees the output), or retainGenerated off.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generatedKey } from "../../core/src/path/generated";
import { GeneratedRegistry, keyOf, retainable } from "../src/generated";

const DIST = path.resolve(__dirname, "..", "dist");
const REGISTER = path.join(DIST, "register.js");
const REPO = path.resolve(__dirname, "..", "..", "..");
const TSX_DIR = path.dirname(require.resolve("tsx/package.json", { paths: [REPO] }));
const TSX_ESM = pathToFileURL(path.join(TSX_DIR, "dist", "loader.mjs")).href;
const TSX_CJS = path.join(TSX_DIR, "dist", "cjs", "index.cjs");

describe("GeneratedRegistry", () => {
  test("LRU under a total cap; an entry over the per-entry cap is never kept; a re-set replaces", () => {
    const r = new GeneratedRegistry(10, 20);
    expect(r.set("a", "x".repeat(8))).toBe(true);
    expect(r.set("b", "y".repeat(8))).toBe(true);
    expect(r.set("c", "z".repeat(11))).toBe(false);
    expect(r.size).toBe(2);
    expect(r.set("c", "z".repeat(8))).toBe(true); // 24 > 20: the oldest (a) goes
    expect([r.get("a"), r.get("b")?.length, r.get("c")?.length]).toEqual([undefined, 8, 8]);
    expect(r.totalChars).toBe(16);
    r.set("b", "w");
    expect([r.get("b"), r.totalChars]).toEqual(["w", 9]);
  });

  test("a read refreshes an entry (true LRU); a dropped key remembers why", () => {
    const r = new GeneratedRegistry(10, 20);
    r.set("a", "x".repeat(8));
    r.set("b", "y".repeat(8));
    expect(r.get("a")).toBe("x".repeat(8)); // a capture read it: b is now the least recent
    r.set("c", "z".repeat(8));
    expect([r.get("a")?.length, r.get("b"), r.get("c")?.length]).toEqual([8, undefined, 8]);
    expect(r.dropped("b")).toBe("evicted");
    expect(r.set("d", "w".repeat(11))).toBe(false);
    expect(r.dropped("d")).toBe("oversize");
    expect(r.dropped("a")).toBeUndefined();
    r.set("b", "y");
    expect(r.dropped("b")).toBeUndefined();
  });

  test("retainable: a string with an inline source map only", () => {
    expect(retainable("f()\n//# sourceMappingURL=data:application/json;base64,e30=")).toBe(true);
    expect(retainable("f()\n//# sourceMappingURL=f.js.map")).toBe(false);
    expect(retainable("f()")).toBe(false);
    expect(retainable(Buffer.from("x"))).toBe(false);
  });

  test("the key is core's (both sides normalize the same way)", () => {
    for (const p of [path.join(REPO, "src", "a.ts"), path.join(REPO, "src", "..", "SRC", "B.mts")])
      expect(keyOf(p)).toBe(generatedKey(p));
  });
});

let root: string;

/** Main-thread preload registering ours with retainGenerated (ESM: after tsx's --import). */
const PRELOAD = (retain: boolean) => `
const { createRequire } = require("node:module");
const { register } = createRequire(${JSON.stringify(REGISTER)})(${JSON.stringify(REGISTER)});
globalThis.__hoplens = { wrap(fn) { return fn; } };
register({ root: process.env.FX_ROOT, include: ["src/**"], retainGenerated: ${retain}, cacheDir: process.env.FX_CACHE || undefined });
`;

/** Prints the registry once the hook's posts arrived (they are async). `req` is a require function. */
const PRINT = `
setTimeout(() => {
  const path = req("node:path");
  const fs = req("node:fs");
  const r = globalThis[Symbol.for("hoplens.generated")];
  const out = {};
  for (const k of ["a.ts", "plain.js", "c.ts", "v.tsx"]) {
    const abs = path.join(process.env.FX_ROOT, "src", k);
    const n = path.normalize(abs);
    const code = r && r.get(process.platform === "win32" ? n.toLowerCase() : n);
    out[k] = code === undefined ? null : { map: /sourceMappingURL=data:/.test(code), raw: code === fs.readFileSync(abs, "utf8") };
  }
  out.registry = !!r;
  console.log(JSON.stringify(out));
}, 300);
`;

function node(
  args: string[],
  cwd: string,
  extra: Record<string, string> = {},
): { out: any; stderr: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, FX_ROOT: cwd, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete env[k];
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30000 });
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("{"));
  return { out: line ? JSON.parse(line) : undefined, stderr: r.stderr, status: r.status };
}

function write(dir: string, rel: string, content: string) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const A_TS = "export function a(x: number): number {\n  return x > 1 ? x : -x;\n}\n";
let esm: string;
let cjs: string;

beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, "hooks.mjs"))) throw new Error("build @hoplens/transform first (pnpm build)");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-generated-")));
  esm = path.join(root, "esm");
  cjs = path.join(root, "cjs");
  write(esm, "package.json", JSON.stringify({ type: "module" }));
  write(esm, "src/a.ts", A_TS);
  write(esm, "src/plain.js", "export function p() {\n  return 1;\n}\n");
  // A .tsx route module: no hop targets for the transform, but its compiled output is kept all the same.
  write(esm, "src/v.tsx", "export function v(x: number): number {\n  return x ? 1 : 0;\n}\n");
  write(
    esm,
    "src/main.ts",
    `import { createRequire } from "node:module";\nimport { a } from "./a.ts";\nimport { p } from "./plain.js";\nconst req = createRequire(import.meta.url);\na(2); p();\n// Node's own type stripping cannot run .tsx: only the tsx runs load it.\nawait import("./v.tsx").then((m) => m.v(1), () => {});\n${PRINT}`,
  );
  write(esm, "on.cjs", PRELOAD(true));
  write(esm, "off.cjs", PRELOAD(false));
  write(esm, "on.mjs", `import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./on.cjs");\n`);
  write(esm, "off.mjs", `import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./off.cjs");\n`);
  write(cjs, "package.json", JSON.stringify({ type: "commonjs" }));
  write(cjs, "src/c.ts", "export function c(x: number): number {\n  return x ? 1 : 0;\n}\n");
  write(cjs, "src/plain.js", "exports.p = function p() {\n  return 1;\n};\n");
  write(
    cjs,
    "src/main.ts",
    `const { c } = require("./c.ts");\nrequire("./plain.js").p();\nconst req = require;\nc(1);\n${PRINT}`,
  );
  write(cjs, "on.cjs", PRELOAD(true));
  write(cjs, "off.cjs", PRELOAD(false));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe("what register()'s loaders keep", () => {
  test("with the transform cache: a warm start keeps the same text (the loader's output, not the cache)", () => {
    for (const [dir, args] of [
      [esm, ["--import", TSX_ESM, "--import", "./on.mjs", "src/main.ts"]],
      [cjs, ["-r", TSX_CJS, "-r", "./on.cjs", "src/main.ts"]],
    ] as const) {
      const cache = path.join(dir, ".cache-t");
      fs.rmSync(cache, { recursive: true, force: true });
      const env = { FX_CACHE: cache, HOPLENS_DEBUG: "transform" };
      const cold = node([...args], dir, env);
      const warm = node([...args], dir, env);
      expect(cold.status, cold.stderr).toBe(0);
      expect(cold.stderr).toContain("cache=miss");
      expect(warm.stderr).toContain("cache=hit");
      expect(warm.stderr).not.toContain("cache=miss");
      expect(warm.out).toEqual(cold.out);
      expect(Object.values(warm.out).filter((v: any) => v?.map)).toHaveLength(dir === esm ? 2 : 1);
    }
  });

  test("ESM hook, COMPILED mode (tsx first): tsx's output with its inline map; plain JS is not kept", () => {
    const r = node(["--import", TSX_ESM, "--import", "./on.mjs", "src/main.ts"], esm);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({
      "a.ts": { map: true, raw: false },
      "plain.js": null,
      "c.ts": null,
      "v.tsx": { map: true, raw: false },
      registry: true,
    });
  });

  test("tsx registered after Hoplens (RAW: the hook sees the file, tsx compiles later): nothing kept", () => {
    const r = node(["--import", "./on.mjs", "--import", TSX_ESM, "src/main.ts"], esm);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ "a.ts": null, "plain.js": null, "c.ts": null, "v.tsx": null, registry: true });
  });

  test("Node's own type stripping: offsets are the file's, nothing kept", () => {
    const r = node(["--import", "./on.mjs", "src/main.ts"], esm);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ "a.ts": null, "plain.js": null, "c.ts": null, "v.tsx": null, registry: true });
  });

  test("CommonJS layer under tsx's require hook: what module._compile got; plain JS is not kept", () => {
    const r = node(["-r", TSX_CJS, "-r", "./on.cjs", "src/main.ts"], cjs);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({
      "a.ts": null,
      "plain.js": null,
      "c.ts": { map: true, raw: false },
      "v.tsx": null,
      registry: true,
    });
  });

  test("retainGenerated off (the request path is off): nothing kept, ESM or CommonJS, and no registry", () => {
    expect(node(["--import", TSX_ESM, "--import", "./off.mjs", "src/main.ts"], esm).out).toEqual({
      "a.ts": null,
      "plain.js": null,
      "c.ts": null,
      "v.tsx": null,
      registry: false,
    });
    expect(node(["-r", TSX_CJS, "-r", "./off.cjs", "src/main.ts"], cjs).out).toEqual({
      "a.ts": null,
      "plain.js": null,
      "c.ts": null,
      "v.tsx": null,
      registry: false,
    });
  });
});
