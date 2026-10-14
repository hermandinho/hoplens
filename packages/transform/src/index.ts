// Rewrites each exported function so it runs through the Hoplens wrapper, without ever moving
// a byte of original source — `const` → `let  ` (same length) + wrapper code appended at EOF.
// Source maps stay valid, so stack traces still land on the user's lines.

import path from "node:path";
import { loadTypeScript } from "./ts";

export interface TransformOptions {
  root: string;
  include?: string[];
  exclude?: string[];
}

/** Paths never auto-traced: framework entry files, routes, pages and tests. */
const ALWAYS_EXCLUDE = [
  "**/node_modules/**",
  "**/.next/**",
  "app/**",
  "src/app/**",
  "pages/**",
  "src/pages/**",
  "**/*.d.ts",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "instrumentation*",
  "src/instrumentation*",
  "middleware*",
  "src/middleware*",
  "proxy*",
  "src/proxy*",
  "next.config.*",
  "*.config.*",
];

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBody(glob)}$`);
}

function globBody(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) {
        re += escapeRe(c);
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map(globBody)
        .join("|")})`;
      i = end;
    } else re += escapeRe(c as string);
  }
  return re;
}
const escapeRe = (s: string) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

export function shouldTrace(file: string, source: string, opts: TransformOptions): boolean {
  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  if (rel.startsWith("..")) return false;
  if (!/\.(c|m)?(t|j)s$/.test(rel)) return false;
  if ([...ALWAYS_EXCLUDE, ...(opts.exclude ?? [])].some((g) => globToRegExp(g).test(rel))) return false;
  if (opts.include?.length && !opts.include.some((g) => globToRegExp(g).test(rel))) return false;
  // Directives must stay first and server actions / client modules have their own rules.
  const head = source.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  if (/^["']use (client|server)["']/.test(head)) return false;
  return true;
}

interface Target {
  name: string;
  line: number;
}

export function transformSource(source: string, file: string, opts: TransformOptions): string | null {
  const ts = loadTypeScript(opts.root);
  if (!ts) return null;
  const kind = /\.(c|m)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const targets: Target[] = [];
  const constStarts: number[] = [];
  const isExported = (n: any) => n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n: any) => n.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword);
  const lineOf = (n: any) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const unwrap = (e: any): any => {
    while (
      e &&
      (ts.isParenthesizedExpression(e) ||
        ts.isAsExpression(e) ||
        ts.isSatisfiesExpression?.(e) ||
        ts.isTypeAssertionExpression?.(e))
    ) {
      e = e.expression;
    }
    return e;
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && isExported(st) && !isDefault(st) && st.name && st.body && !st.asteriskToken) {
      targets.push({ name: st.name.text, line: lineOf(st) });
    } else if (ts.isVariableStatement(st) && isExported(st)) {
      const list = st.declarationList;
      const fnDecls = list.declarations.filter((d: any) => {
        const init = unwrap(d.initializer);
        return (
          ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || (ts.isFunctionExpression(init) && !init.asteriskToken))
        );
      });
      if (!fnDecls.length) continue;
      if (list.flags & ts.NodeFlags.Const) {
        const start = list.getStart(sf);
        if (source.slice(start, start + 5) !== "const") continue;
        constStarts.push(start);
      } else if (list.flags & (ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) continue;
      for (const d of fnDecls) targets.push({ name: (d.name as any).text, line: lineOf(d) });
    }
  }
  if (!targets.length) return null;

  let out = source;
  for (const start of constStarts.sort((a, b) => b - a)) out = `${out.slice(0, start)}let  ${out.slice(start + 5)}`;

  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  const calls = targets
    .map((t) => `${t.name} = __tpw(${t.name}, ${JSON.stringify({ name: t.name, file: rel, line: t.line })});`)
    .join(" ");
  out += `\n;(function () { var __tpw = globalThis["__hoplens"] && globalThis["__hoplens"].wrap; if (typeof __tpw !== "function") return; ${calls} })();\n`;
  return out;
}

export { loadTypeScript } from "./ts";
