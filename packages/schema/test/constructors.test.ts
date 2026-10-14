import { describe, expect, test } from "vitest";
import { exampleOf } from "../src/index";
import { interpret } from "./harness";

describe("primitives", () => {
  test.each([
    ["z.string()", { t: "string" }],
    ["z.number()", { t: "number" }],
    ["z.int()", { t: "number", int: true }],
    ["z.int32()", { t: "number", int: true }],
    ["z.float32()", { t: "number" }],
    ["z.float64()", { t: "number" }],
    ["z.bigint()", { t: "bigint" }],
    ["z.boolean()", { t: "boolean" }],
    ["z.date()", { t: "date" }],
    ["z.null()", { t: "null" }],
    ["z.undefined()", { t: "any", optional: true }],
    ["z.void()", { t: "any", optional: true }],
    ["z.any()", { t: "any" }],
    ["z.unknown()", { t: "any" }],
  ])("%s", (src, expected) => {
    expect(interpret(`const S = ${src};`)).toEqual(expected);
  });
});

describe("string formats", () => {
  test.each([
    ["z.email()", "email"],
    ["z.uuid()", "uuid"],
    ["z.uuidv4()", "uuid"],
    ["z.guid()", "uuid"],
    ["z.url()", "url"],
    ["z.cuid()", "cuid"],
    ["z.cuid2()", "cuid2"],
    ["z.ulid()", "ulid"],
    ["z.nanoid()", "nanoid"],
    ["z.datetime()", "datetime"],
    ["z.ipv4()", "ipv4"],
    ["z.ipv6()", "ipv6"],
    ["z.base64()", "base64"],
    ["z.jwt()", "jwt"],
    ["z.e164()", "e164"],
    ["z.hostname()", "hostname"],
    ["z.emoji()", "emoji"],
  ])("%s → format=%s", (src, format) => {
    expect(interpret(`const S = ${src};`)).toEqual({ t: "string", format });
  });

  test("chain: z.string().email()", () => {
    expect(interpret("const S = z.string().email();")).toEqual({ t: "string", format: "email" });
  });

  test("chain: z.string().uuid()", () => {
    expect(interpret("const S = z.string().uuid();")).toEqual({ t: "string", format: "uuid" });
  });

  test("chain: z.string().regex(/^x/)", () => {
    const s = interpret("const S = z.string().regex(/^x/);");
    expect(s.t).toBe("string");
    expect((s as any).regex).toBe("/^x/");
  });
});

describe("z.coerce.*", () => {
  test.each([
    ["z.coerce.number()", { t: "number" }],
    ["z.coerce.string()", { t: "string" }],
    ["z.coerce.boolean()", { t: "boolean" }],
    ["z.coerce.date()", { t: "date" }],
  ])("%s", (src, expected) => {
    expect(interpret(`const S = ${src};`)).toEqual(expected);
  });
});

describe("z.iso.*", () => {
  test("z.iso.datetime() → string format datetime", () => {
    expect(interpret("const S = z.iso.datetime();")).toEqual({ t: "string", format: "datetime" });
  });
  test("z.iso.date() → string format date", () => {
    expect(interpret("const S = z.iso.date();")).toEqual({ t: "string", format: "date" });
  });
  test("z.iso.time() → string format time", () => {
    expect(interpret("const S = z.iso.time();")).toEqual({ t: "string", format: "time" });
  });
});

describe("literal + enum", () => {
  test("z.literal('x')", () => {
    expect(interpret("const S = z.literal('x');")).toEqual({ t: "literal", value: "x" });
  });
  test("z.literal(42)", () => {
    expect(interpret("const S = z.literal(42);")).toEqual({ t: "literal", value: 42 });
  });
  test("z.literal(true)", () => {
    expect(interpret("const S = z.literal(true);")).toEqual({ t: "literal", value: true });
  });
  test("z.enum(['a','b','c'])", () => {
    expect(interpret("const S = z.enum(['a','b','c']);")).toEqual({ t: "enum", values: ["a", "b", "c"] });
  });
  test("z.nativeEnum(Color) resolves local enum declaration", () => {
    const s = interpret(`
      enum Color { Red = 1, Green = 2, Blue = 3 }
      const S = z.nativeEnum(Color);
    `);
    expect(s).toEqual({ t: "enum", values: [1, 2, 3] });
  });
});

describe("example values round-trip to valid shapes", () => {
  test("string example is a string", () => {
    expect(typeof exampleOf(interpret("const S = z.string();"))).toBe("string");
  });
  test("email example looks like an email", () => {
    expect(exampleOf(interpret("const S = z.email();"))).toMatch(/@/);
  });
  test("uuid example matches format", () => {
    expect(exampleOf(interpret("const S = z.uuid();"))).toMatch(/^[0-9a-f-]{36}$/);
  });
  test("int example is an integer within bounds", () => {
    const v = exampleOf(interpret("const S = z.int().min(1).max(20);")) as number;
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(1);
    expect(v).toBeLessThanOrEqual(20);
  });
});
