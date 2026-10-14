import { describe, expect, test } from "vitest";
import { interpret } from "./harness";

describe("Zod v3 and v4 reach the same shape", () => {
  test("string email: z.string().email() ≡ z.email()", () => {
    expect(interpret("const S = z.string().email();")).toEqual(interpret("const S = z.email();"));
  });
  test("string uuid: z.string().uuid() ≡ z.uuid()", () => {
    expect(interpret("const S = z.string().uuid();")).toEqual(interpret("const S = z.uuid();"));
  });
  test("int: z.number().int() ≡ z.int()", () => {
    expect(interpret("const S = z.number().int();")).toEqual(interpret("const S = z.int();"));
  });
  test("datetime: z.string().datetime() ≡ z.iso.datetime()", () => {
    expect(interpret("const S = z.string().datetime();")).toEqual(interpret("const S = z.iso.datetime();"));
  });
});

describe("v4-specific entries pass through", () => {
  test("safeExtend behaves like extend", () => {
    const base = interpret(`
      const A = z.object({ a: z.string() });
      const S = A.safeExtend({ b: z.number() });
    `);
    const normal = interpret(`
      const A = z.object({ a: z.string() });
      const S = A.extend({ b: z.number() });
    `);
    expect(base).toEqual(normal);
  });
  test("z.stringbool collapses to string", () => {
    expect(interpret("const S = z.stringbool();")).toEqual({ t: "string" });
  });
  test("z.templateLiteral collapses to string", () => {
    expect(interpret("const S = z.templateLiteral();")).toEqual({ t: "string" });
  });
});

describe("default-then-nullable composition", () => {
  test("default outside nullable keeps the default and the nullable flag", () => {
    const s = interpret("const S = z.string().nullable().default('x');");
    expect(s).toMatchObject({ nullable: true, default: "x", hasDefault: true });
  });
  test("nullable outside default keeps both", () => {
    const s = interpret("const S = z.string().default('x').nullable();");
    expect(s).toMatchObject({ nullable: true, default: "x", hasDefault: true });
  });
});

describe("unknown constructs degrade to any without crashing", () => {
  test("z.somethingWeAtEntireNewMethod()", () => {
    expect(interpret("const S = z.somethingTotallyNew();")).toEqual({ t: "any" });
  });
  test("chain terminating in unknown stays on the base type", () => {
    expect(interpret("const S = z.string().thisDoesNotExist();")).toMatchObject({ t: "string" });
  });
  test("very deep call chain does not throw", () => {
    const chain = `z.string()${".min(1).trim().toLowerCase().optional().nullable().default('x').describe('z').meta({})".repeat(1)}`;
    expect(() => interpret(`const S = ${chain};`)).not.toThrow();
  });
});
