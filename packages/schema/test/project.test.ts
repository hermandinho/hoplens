// SchemaProject: the resolver, the per-mtime source cache and findSchemas hoisted from the Next
// adapter (Next's own fixture suites still cover its routes). Temp files only; nothing is executed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PARSE_METHODS, SchemaProject, fieldsOf, objectMember, scriptKind } from "../src/index";

const FILES: Record<string, string> = {
  "lib/a.ts": `import { z } from "zod";
export const Base = z.object({ email: z.email(), age: z.number().int().min(18) });
export default z.object({ tag: z.string() });
`,
  "lib/index.ts": `export { Base as Renamed } from "./a";
export * from "./b";
`,
  "lib/b.ts": `import { z } from "zod";
export const Star = z.object({ n: z.number() });
`,
  "lib/fn.ts": `export default function handler(req: any) { return req; }
`,
  "lib/schemas.cjs": `const { z } = require("zod");
const Signup = z.object({ name: z.string() });
module.exports = { Signup };
exports.Ping = z.object({ at: z.string() });
`,
  "lib/single.cjs": `const { z } = require("zod");
module.exports = z.object({ only: z.boolean() });
`,
  "route.ts": `import { z } from "zod";
import Tagged from "./lib/a";
import { Renamed, Star } from "./lib";
import * as ns from "./lib/a";
export async function POST(req: Request, { params }: any) {
  const body = Renamed.parse(await req.json());
  const q = Star.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  const p = ns.Base.parse(await params);
  const again = Tagged.parse(await req.json());
  return Response.json({ body, q, p, again });
}
export async function PUT(req: Request) {
  const form = await req.formData();
  return Response.json(Tagged.parse(Object.fromEntries(form)));
}
export function GET(req: any) {
  return Unknown.parse(req.body);
}
export function PATCH(r: any) {
  return z.object({ x: z.string() }).parse(r.payload);
}
`,
  "app.cjs": `const { Signup } = require("./lib/schemas.cjs");
const all = require("./lib/schemas.cjs");
const Single = require("./lib/single.cjs");
`,
  "esm.ts": `import handler from "./lib/fn";
`,
  "scope.ts": `import { z } from "zod";
import { Base as schema, Base as S, Base as Body } from "./lib/a";
export function crud(r: any, p: string, schema: any) {
  r.post(p, (req: any, res: any) => res.json(schema.parse(req.body)));
}
export function local(req: any) {
  const S = z.object({ a: z.string() });
  return S.parse(req.body);
}
export function inner(req: any) {
  const Inner = z.object({ x: z.number() });
  if (req) {
    const Body = Inner.extend({ y: z.string() });
    return Body.safeParse(req.body);
  }
}
export function member(req: any, schema: any) {
  return schema.body.parse(req.body);
}
export function top(req: any) {
  return S.parse(req.body);
}
`,
  "lib/barrel.cjs": `module.exports = require("./schemas.cjs");
`,
  "lib/spread.cjs": `module.exports = { ...require("./schemas.cjs"), extra: 1 };
`,
  "barrels.cjs": `const { Signup } = require("./lib/barrel.cjs");
const S2 = require("./lib/spread.cjs");
function viaBarrel(req) { return Signup.parse(req.body); }
function viaSpread(req) { return S2.Ping.parse(req.body); }
`,
};

let root: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-schema-project-")));
  for (const [rel, src] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src);
  }
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

function fn(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  return sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)!;
}

describe("SchemaProject.findSchemas", () => {
  test("one schema per target, through a barrel alias, export *, a namespace import and a default import", () => {
    const project = new SchemaProject(root);
    const sf = project.sourceFile(ts, path.join(root, "route.ts"))!;
    const deps = new Set<string>();
    const found = project.findSchemas(ts, fn(sf, "POST"), sf, deps);
    expect(found.map((f) => [f.target, f.name, f.file, f.line])).toEqual([
      ["body", "Renamed", "lib/a.ts", 2],
      ["query", "Star", "lib/b.ts", 2],
      ["params", "ns.Base", "route.ts", 8],
    ]);
    const body = found[0]!;
    expect(body.fields).toEqual([
      { path: "email", type: "email", optional: false },
      { path: "age", type: "int · ≥ 18", optional: false },
    ]);
    expect(body.example).toMatchObject({ email: expect.stringContaining("@"), age: expect.any(Number) });
    expect((body.example as any).age).toBeGreaterThanOrEqual(18);
    expect([...deps].map((d) => path.relative(root, d).split(path.sep).join("/")).sort()).toEqual([
      "lib/a.ts",
      "lib/b.ts",
      "lib/index.ts",
    ]);
  });

  test("formData is the form target; a default import resolves to the default export", () => {
    const project = new SchemaProject(root);
    const sf = project.sourceFile(ts, path.join(root, "route.ts"))!;
    const [form] = project.findSchemas(ts, fn(sf, "PUT"), sf, new Set());
    expect(form).toMatchObject({ target: "form", name: "Tagged", file: "lib/a.ts", line: 3 });
    expect(form!.fields.map((f) => f.path)).toEqual(["tag"]);
  });

  test("a parsed name that resolves to nothing is still a schema (empty object); an unknown input is not", () => {
    const project = new SchemaProject(root);
    const sf = project.sourceFile(ts, path.join(root, "route.ts"))!;
    const [unknown] = project.findSchemas(ts, fn(sf, "GET"), sf, new Set());
    expect(unknown).toMatchObject({ target: "body", name: "Unknown", shape: { t: "object", props: {} } });
    // `r.payload` names no request part: nothing, unless bodyPattern says it is the body.
    expect(project.findSchemas(ts, fn(sf, "PATCH"), sf, new Set())).toEqual([]);
    const wide = new SchemaProject(root, { bodyPattern: /\.payload\b/ });
    expect(wide.findSchemas(ts, fn(sf, "PATCH"), sf, new Set()).map((f) => [f.target, f.name])).toEqual([
      ["body", undefined],
    ]);
  });

  test("schemaInfo: strict mode wants a recognised Zod shape", () => {
    const project = new SchemaProject(root);
    const sf = project.sourceFile(ts, path.join(root, "route.ts"))!;
    const r = project.resolver(ts, new Set());
    const renamed = (sf as ts.SourceFile).statements
      .filter(ts.isImportDeclaration)
      .flatMap((st) => {
        const nb = st.importClause?.namedBindings;
        return nb && ts.isNamedImports(nb) ? [...nb.elements] : [];
      })
      .find((el) => el.name.text === "Renamed")!.name;
    expect(project.schemaInfo(renamed, sf, "body", r)?.file).toBe("lib/a.ts");
    const unknownExpr = fn(sf, "GET").body!.statements[0] as ts.ReturnStatement;
    const call = unknownExpr.expression as ts.CallExpression;
    const schemaExpr = (call.expression as ts.PropertyAccessExpression).expression;
    expect(project.schemaInfo(schemaExpr, sf, "body", r)).toBeNull();
    expect(project.schemaInfo(schemaExpr, sf, "body", r, true)?.name).toBe("Unknown");
  });

  test("never throws on a pathological function body", () => {
    const project = new SchemaProject(root);
    // A left-deep binary chain: TypeScript parses it in a loop, the recursive visitors overflow on it.
    const src = `function h(req) { return S.parse(req.body)${" + 1".repeat(60000)}; }`;
    const sf = ts.createSourceFile("deep.js", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    expect(() => project.findSchemas(ts, sf.statements[0], sf, new Set())).not.toThrow();
  });
});

describe("SchemaProject scopes", () => {
  const find = (name: string) => {
    const project = new SchemaProject(root);
    const sf = project.sourceFile(ts, path.join(root, "scope.ts"))!;
    return project
      .findSchemas(ts, fn(sf, name), sf, new Set())
      .map((f) => [f.target, f.name, f.file, f.line, f.example]);
  };

  test("a parameter shadowing an imported schema gives no schema, not the import's", () => {
    expect(find("crud")).toEqual([]);
    expect(find("member")).toEqual([]);
  });

  test("a local const is read from its initializer, in the file it is declared in", () => {
    expect(find("local")).toEqual([["body", "S", "scope.ts", 7, { a: expect.any(String) }]]);
    const [inner] = find("inner");
    expect(inner?.slice(0, 4)).toEqual(["body", "Body", "scope.ts", 13]);
    expect(inner?.[4]).toEqual({ x: expect.any(Number), y: expect.any(String) });
  });

  test("an unshadowed name still resolves through the import", () => {
    expect(find("top").map((f) => f.slice(0, 3))).toEqual([["body", "S", "lib/a.ts"]]);
  });
});

describe("SchemaProject.resolver options", () => {
  test("CommonJS is followed only with `commonjs`", () => {
    const file = path.join(root, "app.cjs");
    const off = new SchemaProject(root);
    const sfOff = off.sourceFile(ts, file)!;
    // Without the option `Signup` (a destructured require) resolves to nothing.
    expect(off.resolver(ts, new Set()).resolve("Signup", sfOff)).toBeNull();
    expect(off.resolver(ts, new Set()).resolveMember("all", "Ping", sfOff)).toBeNull();

    const on = new SchemaProject(root, { commonjs: true });
    const sf = on.sourceFile(ts, file)!;
    const r = on.resolver(ts, new Set());
    const line = (h: any) => h.sf.getLineAndCharacterOfPosition(h.node.getStart(h.sf)).line + 1;
    const signup = r.resolve("Signup", sf)!;
    expect(path.basename(signup.sf.fileName)).toBe("schemas.cjs");
    expect(line(signup)).toBe(2);
    const ping = r.resolveMember("all", "Ping", sf)!;
    expect(line(ping)).toBe(4);
    const single = r.resolve("Single", sf)!;
    expect(path.basename(single.sf.fileName)).toBe("single.cjs");
    expect(single.node.getText(single.sf)).toContain("only");
  });

  test("CommonJS re-export barrels: module.exports = require(...) and { ...require(...) }", () => {
    const project = new SchemaProject(root, { commonjs: true });
    const sf = project.sourceFile(ts, path.join(root, "barrels.cjs"))!;
    const one = (name: string) =>
      project.findSchemas(ts, fn(sf, name), sf, new Set()).map((f) => [f.target, f.name, f.file, f.example]);
    expect(one("viaBarrel")).toEqual([["body", "Signup", "lib/schemas.cjs", { name: expect.any(String) }]]);
    // A member expression keeps its call site as the location (as `ns.Base` does above).
    expect(one("viaSpread")).toEqual([["body", "S2.Ping", "barrels.cjs", { at: expect.any(String) }]]);
  });

  test("a default import reaches `export default function` only with `defaultDeclarations`", () => {
    const file = path.join(root, "esm.ts");
    const off = new SchemaProject(root);
    expect(off.resolver(ts, new Set()).resolve("handler", off.sourceFile(ts, file)!)).toBeNull();
    const on = new SchemaProject(root, { defaultDeclarations: true });
    const hit = on.resolver(ts, new Set()).resolve("handler", on.sourceFile(ts, file)!)!;
    expect(ts.isFunctionDeclaration(hit.node)).toBe(true);
    expect(path.basename(hit.sf.fileName)).toBe("fn.ts");
  });

  test("resolveExport finds named, aliased and star re-exports of a module", () => {
    const project = new SchemaProject(root);
    const r = project.resolver(ts, new Set());
    const barrel = project.sourceFile(ts, path.join(root, "lib/index.ts"))!;
    expect(path.basename(r.resolveExport("Renamed", barrel)!.sf.fileName)).toBe("a.ts");
    expect(path.basename(r.resolveExport("Star", barrel)!.sf.fileName)).toBe("b.ts");
    expect(r.resolveExport("Missing", barrel)).toBeNull();
  });

  test("zod and node_modules are never loaded", () => {
    const project = new SchemaProject(root);
    const deps = new Set<string>();
    expect(project.loadModule(ts, "zod", path.join(root, "route.ts"), deps)).toBeNull();
    expect(project.loadModule(ts, "zod/v4", path.join(root, "route.ts"), deps)).toBeNull();
    expect(deps.size).toBe(0);
  });
});

describe("SchemaProject.sourceFile", () => {
  test("cached until the file's mtime moves; null for a missing file", () => {
    const project = new SchemaProject(root);
    const file = path.join(root, "lib/b.ts");
    const a = project.sourceFile(ts, file);
    expect(project.sourceFile(ts, file)).toBe(a);
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
    const b = project.sourceFile(ts, file);
    expect(b).not.toBe(a);
    expect(project.sourceFile(ts, path.join(root, "nope.ts"))).toBeNull();
  });
});

describe("helpers", () => {
  test("fieldsOf flattens nested objects and array items", () => {
    expect(
      fieldsOf({
        t: "object",
        props: {
          a: { t: "string" },
          o: { t: "object", props: { b: { t: "number", optional: true } } },
          l: { t: "array", item: { t: "object", props: { c: { t: "boolean", hasDefault: true, default: false } } } },
        },
      }).map((f) => [f.path, f.optional]),
    ).toEqual([
      ["a", false],
      ["o", false],
      ["o.b", true],
      ["l", false],
      ["l[].c", true],
    ]);
  });

  test("objectMember, scriptKind, PARSE_METHODS", () => {
    const sf = ts.createSourceFile("x.ts", "const o = { a: 1, b, c() {} };", ts.ScriptTarget.Latest, true);
    const obj = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer!;
    expect(objectMember(ts, obj, "a").getText(sf)).toBe("1");
    expect(ts.isIdentifier(objectMember(ts, obj, "b"))).toBe(true);
    expect(ts.isMethodDeclaration(objectMember(ts, obj, "c"))).toBe(true);
    expect(objectMember(ts, obj, "d")).toBeNull();
    expect(scriptKind(ts, "a.tsx")).toBe(ts.ScriptKind.TSX);
    expect(scriptKind(ts, "a.cjs")).toBe(ts.ScriptKind.JS);
    expect(scriptKind(ts, "a.mts")).toBe(ts.ScriptKind.TS);
    expect(PARSE_METHODS.has("safeParseAsync")).toBe(true);
  });
});
