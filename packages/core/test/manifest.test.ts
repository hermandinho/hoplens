import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MANIFEST_FILE,
  type SourceManifest,
  buildManifest,
  checkRestart,
  diffManifests,
  isEdit,
  listSourceFiles,
  normalizeSource,
  parseIgnore,
  readManifest,
  sourceTokens,
  sweepTempFiles,
  writeManifest,
} from "../src/manifest";
import { FALLBACK_DIRS } from "../src/sourcewatch";

const norm = (src: string, file = "a.ts") => normalizeSource(src, file, ts);

describe("normalizeSource (token level)", () => {
  test("whitespace, line breaks and comments do not count", () => {
    const a = `import { db } from "./db";\nexport function list(req, res) {\n  return res.json(db.all());\n}\n`;
    const b = `// list the users\nimport {db} from './db'\n\n/** handler */\nexport function list (req,res){ return res.json( db.all() ) }`;
    expect(norm(a)).toBe(norm(b));
  });

  test("semicolons, trailing commas and quote style do not count", () => {
    expect(norm(`const a = [1, 2, 3,];\nf(a, b,);\nconst s = 'x';`)).toBe(
      norm(`const a = [1, 2, 3]\nf(a, b)\nconst s = "x"`),
    );
    expect(norm("const o = {\n  a: 1,\n  b: 2,\n};")).toBe(norm("const o = { a: 1, b: 2 }"));
  });

  test("a code change counts", () => {
    expect(norm("setTimeout(done, 5)")).not.toBe(norm("setTimeout(done, 50)"));
    expect(norm("a + b")).not.toBe(norm("a - b"));
    expect(norm(`const s = "a b"`)).not.toBe(norm(`const s = "a  b"`));
    expect(norm("const t = `x ${a}  y`")).not.toBe(norm("const t = `x ${a} y`"));
  });

  test("template literals: code in a substitution is normalized, text is not", () => {
    expect(norm("const t = `a${ x + 1 }b${y}c`")).toBe(norm("const t = `a${x+1}b${y}c`"));
    expect(norm("const t = `a${ {k: 1}.k }b`")).toBe(norm("const t = `a${{ k: 1 }.k}b`"));
  });

  test("a regex keeps its text: a // inside it is not a comment", () => {
    const a = `s.replace(/\\/\\//g, "a"); x = 1`;
    const b = `s.replace(/\\/\\//g, "a"); x = 2`;
    expect(norm(a)).not.toBe(norm(b));
    expect(norm("if (ok) return /a b/.test(s)")).not.toBe(norm("if (ok) return /a  b/.test(s)"));
    // Division stays division.
    expect(norm("const r = a / b / c")).toBe(norm("const r = a/b/c"));
  });

  test("a shebang and JSON comments are trivia", () => {
    expect(norm("#!/usr/bin/env node\nrun()", "bin.js")).toBe(norm("run()", "bin.js"));
    expect(norm(`{\n  // c\n  "a": 1,\n}`, "x.json")).toBe(norm(`{"a":1}`, "x.json"));
  });

  test("other source files collapse whitespace; without TypeScript JS is taken as is", () => {
    expect(normalizeSource("select *\n  from  t", "q.sql")).toBe(normalizeSource("select * from t", "q.sql"));
    expect(normalizeSource("a  b", "x.ts")).toBe("a  b");
  });

  test("a line break that ASI reads as a statement end counts; one inside an expression does not", () => {
    // return / throw / break / continue / yield end at a line break.
    expect(norm("function f() { return x }")).not.toBe(norm("function f() { return\nx }"));
    // A dropped semicolon before ( or [ joins the next line to this statement.
    expect(norm("const a = b;\n(c)()")).not.toBe(norm("const a = b\n(c)()"));
    expect(norm("const a = b;\n[1].map(f)")).not.toBe(norm("const a = b\n[1].map(f)"));
    // Formatter saves stay the same: semicolons ASI would insert, wrapped lines, a trailing ;.
    expect(norm("const a = b;\nfoo();\n")).toBe(norm("const a = b\nfoo()\n"));
    expect(norm("if (x) {\n  a();\n}\nb();")).toBe(norm("if (x) { a() }\nb()"));
    expect(norm("const v = a &&\n  b;\nx.y\n  .z();")).toBe(norm("const v = a && b; x.y.z();"));
    expect(norm("interface A {\n  a: number;\n  b: string;\n}")).toBe(
      norm("interface A {\n  a: number\n  b: string\n}"),
    );
    expect(norm("if (a) {\n} else {\n  b();\n}")).toBe(norm("if (a) {} else { b() }"));
    expect(norm("function f() {\n  return;\n}")).toBe(norm("function f() {\n  return\n}"));
  });

  test("JSX text after // is not a comment in .jsx / .tsx", () => {
    const a = "export const L = () => <a>see http://old.example</a>;\n";
    const b = "export const L = () => <a>see http://new.example</a>;\n";
    expect(norm(a, "L.tsx")).not.toBe(norm(b, "L.tsx"));
    expect(norm(a, "L.jsx")).not.toBe(norm(b, "L.jsx"));
    expect(norm("const x = 1; // a\n", "a.tsx")).toBe(norm("const x = 1  // a\n", "a.tsx"));
  });

  test("sourceTokens is stable across calls", () => {
    const src = "export const x = /re/g.test(`${a}`) ? 1 : 2;";
    expect(sourceTokens(src, ts)).toBe(sourceTokens(src, ts));
  });
});

describe("manifest diff", () => {
  const m = (files: Record<string, [string, string]>, n: "ts1" | "raw" = "ts1"): SourceManifest => ({
    v: 1,
    norm: n,
    at: 0,
    files,
  });

  test("changed, added and deleted by normalized hash", () => {
    const prev = m({ "a.ts": ["r1", "n1"], "b.ts": ["r2", "n2"], "c.ts": ["r3", "n3"] });
    const next = m({ "a.ts": ["r1x", "n1"], "b.ts": ["r2x", "n2x"], "d.ts": ["r4", "n4"] });
    const d = diffManifests(prev, next);
    expect(d).toEqual({ changed: ["b.ts"], added: ["d.ts"], deleted: ["c.ts"] });
    expect(isEdit(d)).toBe(true);
    expect(isEdit(diffManifests(prev, prev))).toBe(false);
  });

  test("manifests normalized differently compare by raw hash", () => {
    const prev = m({ "a.ts": ["r1", "r1"] }, "raw");
    expect(diffManifests(prev, m({ "a.ts": ["r1", "n1"] })).changed).toEqual([]);
    expect(diffManifests(prev, m({ "a.ts": ["r2", "n1"] })).changed).toEqual(["a.ts"]);
  });
});

describe("files on disk", () => {
  let root: string;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-manifest-")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("FALLBACK_DIRS covers the Express layout", () => {
    for (const d of ["routes", "controllers", "middleware", "services", "lib"]) expect(FALLBACK_DIRS).toContain(d);
  });

  test("listSourceFiles: top-level files and source dirs; node_modules, dot dirs, tests, the state dir and .gitignore left out", () => {
    write("app.js", "");
    write("server.ts", "");
    write("README.md", "");
    write("routes/users.js", "");
    write("routes/users.test.js", "");
    write("controllers/x.ts", "");
    write("middleware/auth.js", "");
    write("lib/db.js", "");
    write("lib/generated/client.js", "");
    write("lib/node_modules/p/index.js", "");
    write("lib/.cache/x.js", "");
    write("lib/state/sources.json", "");
    write("lib/debug.log.js", "");
    write("other/x.js", "");
    write(".gitignore", "# c\ngenerated/\n*.log.js\n!keep.js\n");
    expect(listSourceFiles(root, { exclude: ["lib/state"] })).toEqual([
      "app.js",
      "controllers/x.ts",
      "lib/db.js",
      "middleware/auth.js",
      "routes/users.js",
      "server.ts",
    ]);
    // With src/, only src (plus top-level files).
    write("src/index.ts", "");
    expect(listSourceFiles(root, { exclude: ["lib/state"] })).toEqual(["app.js", "server.ts", "src/index.ts"]);
  });

  test("parseIgnore keeps the simple rules only", () => {
    const ig = parseIgnore("/build\nlogs/\n*.tmp.js\nsrc/gen\n**/x\n!a\n");
    expect([...ig.names]).toEqual(["logs"]);
    expect(ig.prefixes).toEqual(["build", "src/gen"]);
    expect(ig.suffixes).toEqual([".tmp.js"]);
  });

  test("buildManifest reuses normalized hashes of unchanged files and loads TypeScript only for a change", () => {
    write("routes/a.js", "module.exports = 1;\n");
    write("routes/b.js", "module.exports = 2;\n");
    let loads = 0;
    const typescript = () => {
      loads++;
      return ts;
    };
    const first = buildManifest(root, ["routes/a.js", "routes/b.js"], undefined, { typescript });
    expect(loads).toBe(1);
    expect(first.norm).toBe("ts1");
    const same = buildManifest(root, ["routes/a.js", "routes/b.js"], first, { typescript });
    expect(loads).toBe(1);
    expect(same.files).toEqual(first.files);
    write("routes/a.js", "module.exports   =   1\n// comment\n");
    const fmt = buildManifest(root, ["routes/a.js", "routes/b.js"], first, { typescript });
    expect(loads).toBe(2);
    expect(fmt.files["routes/a.js"]![0]).not.toBe(first.files["routes/a.js"]![0]);
    expect(isEdit(diffManifests(first, fmt))).toBe(false);
  });

  test("without TypeScript every byte counts (norm raw)", () => {
    write("a.js", "x = 1");
    const m1 = buildManifest(root, ["a.js"], undefined, { typescript: () => null });
    expect(m1.norm).toBe("raw");
    write("a.js", "x  =  1");
    const m2 = buildManifest(root, ["a.js"], m1, { typescript: () => null });
    expect(diffManifests(m1, m2).changed).toEqual(["a.js"]);
  });

  test("checkRestart: first run has no diff; then whitespace-only, edit, add and delete", () => {
    const dir = path.join(root, "node_modules", ".cache", "hoplens");
    write("app.js", "const r = require('./routes/a');\n");
    write("routes/a.js", "module.exports = (req, res) => res.send('a');\n");
    const opts = { typescript: () => ts };
    const c0 = checkRestart(root, dir, opts);
    expect(c0.prev).toBeUndefined();
    expect(c0.diff).toBeUndefined();
    expect(writeManifest(path.join(dir, MANIFEST_FILE), c0.next)).toBe(true);

    write("routes/a.js", 'module.exports = (req, res) =>\n  res.send("a")\n');
    const c1 = checkRestart(root, dir, opts);
    expect(c1.diff).toEqual({ changed: [], added: [], deleted: [] });
    writeManifest(path.join(dir, MANIFEST_FILE), c1.next);

    write("routes/a.js", "module.exports = (req, res) => res.send('b');\n");
    write("routes/new.js", "module.exports = 1;\n");
    fs.rmSync(path.join(root, "app.js"));
    const c2 = checkRestart(root, dir, opts);
    expect(c2.diff).toEqual({ changed: ["routes/a.js"], added: ["routes/new.js"], deleted: ["app.js"] });
    expect(c2.newestMtime).toBeGreaterThan(0);
  });

  test("a file whose size and mtime match the manifest is not read again", () => {
    write("routes/a.js", "module.exports = 1;\n");
    const opts = { typescript: () => ts };
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(path.join(root, "routes/a.js"), old, old);
    const first = buildManifest(root, ["routes/a.js"], undefined, opts);
    const st = fs.statSync(path.join(root, "routes/a.js"));
    expect(first.files["routes/a.js"]!.slice(2)).toEqual([st.mtimeMs, st.size]);
    // A doctored hash with the same stat is kept: the file was not read.
    const fake: SourceManifest = { ...first, files: { "routes/a.js": ["R", "N", st.mtimeMs, st.size] } };
    expect(buildManifest(root, ["routes/a.js"], fake, opts).files["routes/a.js"]!.slice(0, 2)).toEqual(["R", "N"]);
    // A new stat: read and hashed again. Written just now, it keeps no stat (a rewrite in the same
    // tick would look unchanged), so it is read again next time too.
    write("routes/a.js", "module.exports = 2;\n");
    const now = buildManifest(root, ["routes/a.js"], fake, opts).files["routes/a.js"]!;
    expect(now[0]).not.toBe("R");
    expect(now.length).toBe(2);
  });

  test("a large file is hashed in pieces and still counts when it changes", () => {
    const big = "x".repeat(3 * 1024 * 1024);
    write("data/big.sql", big);
    const m1 = buildManifest(root, ["data/big.sql"], undefined, { typescript: () => ts });
    write("data/big.sql", `${big}y`);
    const m2 = buildManifest(root, ["data/big.sql"], m1, { typescript: () => ts });
    expect(diffManifests(m1, m2).changed).toEqual(["data/big.sql"]);
  });

  test("past the file cap: a file pushed out of the walk is not reported as deleted", () => {
    const dir = path.join(root, "node_modules", ".cache", "hoplens");
    for (const n of ["b", "c", "d", "e"]) write(`src/${n}.js`, `module.exports = "${n}";\n`);
    const opts = { typescript: () => ts, maxFiles: 3 };
    const c0 = checkRestart(root, dir, opts);
    expect(c0.truncated).toBe(true);
    writeManifest(path.join(dir, MANIFEST_FILE), c0.next);
    write("src/a.js", "module.exports = 'a';\n");
    const c1 = checkRestart(root, dir, opts);
    expect(c1.diff).toEqual({ changed: [], added: ["src/a.js"], deleted: [] });
    writeManifest(path.join(dir, MANIFEST_FILE), c1.next);
    fs.rmSync(path.join(root, "src/b.js"));
    expect(checkRestart(root, dir, opts).diff!.deleted).toEqual(["src/b.js"]);
  });

  test("a .json data file no module imports, written since the last start, is no edit", () => {
    const dir = path.join(root, "node_modules", ".cache", "hoplens");
    write("src/app.js", "const cfg = require('./config.json');\n");
    write("src/config.json", '{"a":1}');
    write("src/data/db.json", '{"rows":[]}');
    const opts = { typescript: () => ts };
    const c0 = checkRestart(root, dir, { ...opts, clock: () => Date.now() - 60_000 });
    writeManifest(path.join(dir, MANIFEST_FILE), c0.next);
    // The app wrote its store; nothing else changed.
    write("src/data/db.json", '{"rows":[1]}');
    write("src/data/new.json", "{}");
    expect(checkRestart(root, dir, opts).diff).toEqual({ changed: [], added: [], deleted: [] });
    // An imported JSON and a top-level one still count.
    write("src/config.json", '{"a":2}');
    write("package.json", '{"name":"x"}');
    expect(checkRestart(root, dir, opts).diff).toEqual({
      changed: ["src/config.json"],
      added: ["package.json"],
      deleted: [],
    });
  });

  test("the manifest file is not one a watcher restarts on (nodemon watches .json)", () => {
    expect(MANIFEST_FILE.endsWith(".json")).toBe(false);
  });

  test("a missing, corrupt or foreign manifest reads as none", () => {
    const file = path.join(root, MANIFEST_FILE);
    expect(readManifest(file)).toBeUndefined();
    fs.writeFileSync(file, '{"v":1,"norm":"ts1","at":0,"files":{"a.js":["x"');
    expect(readManifest(file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ v: 2, norm: "ts1", at: 0, files: {} }));
    expect(readManifest(file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ v: 1, norm: "ts1", at: 0, files: { "a.js": "x" } }));
    expect(readManifest(file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ v: 1, norm: "ts1", at: 0, files: { "a.js": ["x", "y"] } }));
    expect(readManifest(file)?.files["a.js"]).toEqual(["x", "y"]);
  });

  test("writeManifest is atomic: a temp file renamed over the old one, a torn temp file never read", () => {
    const file = path.join(root, "state", MANIFEST_FILE);
    const m1: SourceManifest = { v: 1, norm: "ts1", at: 1, files: { "a.js": ["1", "1"] } };
    expect(writeManifest(file, m1)).toBe(true);
    // A process killed mid-write leaves only its temp file; the manifest is the old one, whole.
    const torn = `${file}.99999.tmp`;
    fs.writeFileSync(torn, '{"v":1,"norm":"ts1","files":{"a.js":["2"');
    expect(readManifest(file)).toEqual(m1);
    sweepTempFiles(file);
    expect(fs.existsSync(torn)).toBe(false);
    const m2: SourceManifest = { ...m1, at: 2, files: { "a.js": ["2", "2"] } };
    expect(writeManifest(file, m2)).toBe(true);
    expect(readManifest(file)).toEqual(m2);
    expect(fs.readdirSync(path.dirname(file))).toEqual([MANIFEST_FILE]);
  });
});
