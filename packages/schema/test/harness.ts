import ts from "typescript";
import { type Resolver, type Shape, interpretSchema } from "../src/index";

// In-file-only resolver — enough for inline-source tests. Cross-file resolution has its own fixture suite.
function makeResolver(sf: ts.SourceFile): Resolver {
  const findStmt = (name: string) => {
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
            return { node: d.initializer, sf, name };
          }
        }
      }
      if (ts.isEnumDeclaration(st) && st.name.text === name) return { node: st, sf, name };
    }
    return null;
  };
  return {
    ts,
    resolve: (name) => findStmt(name),
    resolveMember: () => null,
  };
}

/** Parse a snippet and interpret the initializer of `const S = …`. */
export function interpret(source: string): Shape {
  const sf = ts.createSourceFile("inline.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const target = sf.statements.find(
    (st): st is ts.VariableStatement =>
      ts.isVariableStatement(st) &&
      st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "S"),
  );
  if (!target) throw new Error("harness: no `const S = …` in snippet");
  const decl = target.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === "S")!;
  if (!decl.initializer) throw new Error("harness: `S` has no initializer");
  return interpretSchema(decl.initializer, sf, makeResolver(sf));
}
