import fc from "fast-check";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { type Resolver, type Shape, exampleOf, interpretSchema } from "../src/index";

const emptyResolver: Resolver = { ts, resolve: () => null, resolveMember: () => null };

/** Interpret arbitrary text as the initializer of `const S = …`. If parsing fails, use `undefined`. */
function tryInterpret(src: string): Shape {
  try {
    const sf = ts.createSourceFile("fuzz.ts", `const S = ${src};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const vs = sf.statements[0] as ts.VariableStatement | undefined;
    const decl = vs?.declarationList.declarations[0];
    return interpretSchema(decl?.initializer, sf, emptyResolver);
  } catch (err) {
    throw new Error(`interpretSchema threw on input: ${src}\n${(err as Error).stack ?? err}`);
  }
}

describe("interpretSchema never throws", () => {
  test("on garbage text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        expect(() => tryInterpret(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  test("on random z.*() call chains", () => {
    const method = fc.constantFrom(
      "string",
      "number",
      "int",
      "boolean",
      "date",
      "email",
      "uuid",
      "url",
      "object",
      "array",
      "optional",
      "nullable",
      "default",
      "min",
      "max",
      "length",
      "pipe",
      "transform",
      "refine",
      "extend",
      "pick",
      "omit",
      "partial",
      "describe",
      "catch",
      "or",
      "and",
    );
    const chain = fc.array(method, { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(chain, (methods) => {
        const src = methods.map((m) => `${m}()`).join(".");
        expect(() => tryInterpret(`z.${src}`)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  test("on arbitrarily-nested object/array constructs", () => {
    const prim = fc.constantFrom("z.string()", "z.number()", "z.boolean()", "z.any()");
    const expr: fc.Arbitrary<string> = fc.letrec((tie) => ({
      e: fc.oneof(
        prim,
        fc
          .record({ k: fc.constantFrom("a", "b", "c", "x", "y", "key"), v: tie("e") })
          .map((o) => `z.object({ ${o.k}: ${o.v as string} })`),
        tie("e").map((inner) => `z.array(${inner as string})`),
        tie("e").map((inner) => `z.union([${inner as string}, z.string()])`),
      ),
    })).e;
    fc.assert(
      fc.property(expr, (src) => {
        expect(() => tryInterpret(src)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  test("exampleOf never throws for any produced shape", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (s) => {
        const shape = tryInterpret(s);
        expect(() => exampleOf(shape)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
