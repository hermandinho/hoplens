import { describe, expect, test } from "vitest";
import { interpret } from "./harness";

describe("string modifiers", () => {
  test("min/max/length", () => {
    expect(interpret("const S = z.string().min(2).max(10);")).toMatchObject({ t: "string", min: 2, max: 10 });
    expect(interpret("const S = z.string().length(5);")).toMatchObject({ t: "string", len: 5 });
    expect(interpret("const S = z.string().nonempty();")).toMatchObject({ t: "string", min: 1 });
  });
  test("startsWith / endsWith / includes", () => {
    expect(interpret("const S = z.string().startsWith('pre');")).toMatchObject({ t: "string", startsWith: "pre" });
    expect(interpret("const S = z.string().endsWith('post');")).toMatchObject({ t: "string", endsWith: "post" });
    expect(interpret("const S = z.string().includes('mid');")).toMatchObject({ t: "string", includes: "mid" });
  });
  test("regex captured as source literal", () => {
    const s = interpret("const S = z.string().regex(/^abc$/);");
    expect(s).toMatchObject({ t: "string" });
    expect((s as any).regex).toBe("/^abc$/");
  });
});

describe("number modifiers", () => {
  test("min/max/gt/lt", () => {
    expect(interpret("const S = z.number().min(1).max(10);")).toMatchObject({ t: "number", min: 1, max: 10 });
    expect(interpret("const S = z.number().gt(0).lt(100);")).toMatchObject({ t: "number", gt: 0, lt: 100 });
  });
  test("positive / nonnegative / negative / nonpositive", () => {
    expect(interpret("const S = z.number().positive();")).toMatchObject({ gt: 0 });
    expect(interpret("const S = z.number().nonnegative();")).toMatchObject({ min: 0 });
    expect(interpret("const S = z.number().negative();")).toMatchObject({ lt: 0 });
    expect(interpret("const S = z.number().nonpositive();")).toMatchObject({ max: 0 });
  });
  test("int + multipleOf", () => {
    expect(interpret("const S = z.number().int();")).toMatchObject({ t: "number", int: true });
    expect(interpret("const S = z.number().multipleOf(5);")).toMatchObject({ multipleOf: 5 });
    expect(interpret("const S = z.number().step(0.1);")).toMatchObject({ multipleOf: 0.1 });
  });
});

describe("schema-level wrappers", () => {
  test("optional / nullable / nullish", () => {
    expect(interpret("const S = z.string().optional();")).toMatchObject({ t: "string", optional: true });
    expect(interpret("const S = z.string().nullable();")).toMatchObject({ t: "string", nullable: true });
    expect(interpret("const S = z.string().nullish();")).toMatchObject({ t: "string", optional: true, nullable: true });
  });
  test("default / prefault captures literal", () => {
    expect(interpret("const S = z.string().default('x');")).toMatchObject({ default: "x", hasDefault: true });
    expect(interpret("const S = z.number().default(42);")).toMatchObject({ default: 42, hasDefault: true });
    expect(interpret("const S = z.string().prefault('y');")).toMatchObject({ default: "y", hasDefault: true });
  });
  test("describe adds description", () => {
    expect(interpret("const S = z.string().describe('a name');")).toMatchObject({ description: "a name" });
  });
  test("unwrap removes optional/nullable", () => {
    expect(interpret("const S = z.string().optional().unwrap();")).toMatchObject({ optional: false, nullable: false });
  });
});

describe("pass-through modifiers do not disturb the shape", () => {
  test.each([
    ["pipe", "z.string().pipe(z.string())"],
    ["transform", "z.string().transform(x => x)"],
    ["refine", "z.string().refine(x => true)"],
    ["superRefine", "z.string().superRefine(() => {})"],
    ["check", "z.string().check(() => true)"],
    ["brand", "z.string().brand<'tag'>()"],
    ["readonly", "z.string().readonly()"],
    ["catch", "z.string().catch('x')"],
    ["trim", "z.string().trim()"],
    ["toLowerCase", "z.string().toLowerCase()"],
    ["meta", "z.string().meta({})"],
    ["openapi", "z.string().openapi({})"],
  ])("%s stays a string", (_name, src) => {
    expect(interpret(`const S = ${src};`)).toMatchObject({ t: "string" });
  });
});

describe("object", () => {
  test("plain object with primitives", () => {
    expect(interpret("const S = z.object({ name: z.string(), age: z.number() });")).toEqual({
      t: "object",
      props: { name: { t: "string" }, age: { t: "number" } },
    });
  });
  test("strictObject / looseObject behave like object for us", () => {
    expect(interpret("const S = z.strictObject({ a: z.string() });")).toMatchObject({
      t: "object",
      props: { a: { t: "string" } },
    });
    expect(interpret("const S = z.looseObject({ b: z.number() });")).toMatchObject({
      t: "object",
      props: { b: { t: "number" } },
    });
  });
  test("nested object", () => {
    const s = interpret("const S = z.object({ outer: z.object({ inner: z.boolean() }) });");
    expect(s).toMatchObject({
      props: { outer: { t: "object", props: { inner: { t: "boolean" } } } },
    });
  });
  test(".shape spread merges keys", () => {
    const s = interpret(`
      const A = z.object({ a: z.string() });
      const B = z.object({ ...A.shape, b: z.number() });
      const S = B;
    `);
    expect((s as any).props).toMatchObject({ a: { t: "string" }, b: { t: "number" } });
  });
  test("extend adds keys", () => {
    const s = interpret(`
      const A = z.object({ a: z.string() });
      const S = A.extend({ b: z.number() });
    `);
    expect((s as any).props).toMatchObject({ a: { t: "string" }, b: { t: "number" } });
  });
  test("merge combines", () => {
    const s = interpret(`
      const A = z.object({ a: z.string() });
      const B = z.object({ b: z.number() });
      const S = A.merge(B);
    `);
    expect((s as any).props).toMatchObject({ a: { t: "string" }, b: { t: "number" } });
  });
  test("pick keeps subset", () => {
    const s = interpret(`
      const A = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
      const S = A.pick({ a: true, c: true });
    `);
    expect(Object.keys((s as any).props).sort()).toEqual(["a", "c"]);
  });
  test("omit removes subset", () => {
    const s = interpret(`
      const A = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
      const S = A.omit({ b: true });
    `);
    expect(Object.keys((s as any).props).sort()).toEqual(["a", "c"]);
  });
  test("partial flips every key to optional", () => {
    const s = interpret("const S = z.object({ a: z.string(), b: z.number() }).partial();");
    expect(Object.values((s as any).props).every((v: any) => v.optional)).toBe(true);
  });
  test("keyof returns enum of keys", () => {
    const s = interpret("const S = z.object({ a: z.string(), b: z.number() }).keyof();");
    expect(s).toMatchObject({ t: "enum", values: ["a", "b"] });
  });
});

describe("array / tuple / record / set / map", () => {
  test("array element type", () => {
    expect(interpret("const S = z.array(z.string());")).toEqual({ t: "array", item: { t: "string" } });
  });
  test("set treated as array", () => {
    expect(interpret("const S = z.set(z.number());")).toMatchObject({ t: "array", item: { t: "number" } });
  });
  test("array().min/max/length", () => {
    expect(interpret("const S = z.array(z.string()).min(2).max(5);")).toMatchObject({ min: 2, max: 5 });
    expect(interpret("const S = z.array(z.string()).length(3);")).toMatchObject({ len: 3 });
  });
  test("tuple elements", () => {
    expect(interpret("const S = z.tuple([z.string(), z.number()]);")).toEqual({
      t: "tuple",
      items: [{ t: "string" }, { t: "number" }],
    });
  });
  test("record / map value type", () => {
    expect(interpret("const S = z.record(z.string());")).toEqual({ t: "record", value: { t: "string" } });
    expect(interpret("const S = z.record(z.string(), z.number());")).toEqual({ t: "record", value: { t: "number" } });
    expect(interpret("const S = z.map(z.string(), z.number());")).toMatchObject({ t: "record" });
  });
  test(".element on array returns item", () => {
    expect(interpret("const S = z.array(z.string()).element;").t).toBe("any");
    expect(interpret("const S = z.array(z.string()).element();")).toEqual({ t: "string" });
  });
});

describe("union / discriminatedUnion / intersection / or / and", () => {
  test("union", () => {
    expect(interpret("const S = z.union([z.string(), z.number()]);")).toMatchObject({
      t: "union",
      options: [{ t: "string" }, { t: "number" }],
    });
  });
  test("discriminatedUnion", () => {
    const s = interpret(`
      const S = z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), x: z.string() }),
        z.object({ kind: z.literal('b'), y: z.number() }),
      ]);
    `);
    expect((s as any).options).toHaveLength(2);
  });
  test("intersection of two objects merges props", () => {
    const s = interpret(`
      const S = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }));
    `);
    expect((s as any).props).toMatchObject({ a: { t: "string" }, b: { t: "number" } });
  });
  test(".or() produces a union", () => {
    expect(interpret("const S = z.string().or(z.number());")).toMatchObject({ t: "union" });
  });
  test(".and() merges object shapes", () => {
    const s = interpret("const S = z.object({ a: z.string() }).and(z.object({ b: z.number() }));");
    expect((s as any).props).toMatchObject({ a: { t: "string" }, b: { t: "number" } });
  });
});

describe("lazy / preprocess / promise", () => {
  test("lazy returns the inner shape", () => {
    const s = interpret("const S = z.lazy(() => z.string());");
    expect(s).toMatchObject({ t: "string" });
  });
  test("preprocess ignores the preprocessor and returns the second arg", () => {
    const s = interpret("const S = z.preprocess((x) => x, z.number());");
    expect(s).toMatchObject({ t: "number" });
  });
  test("promise unwraps", () => {
    const s = interpret("const S = z.promise(z.string());");
    expect(s).toMatchObject({ t: "string" });
  });
});
