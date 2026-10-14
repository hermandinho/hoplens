import fs from "node:fs";
import path from "node:path";

export type Shape =
  | (Base & {
      t: "string";
      format?: string;
      min?: number;
      max?: number;
      len?: number;
      startsWith?: string;
      endsWith?: string;
      includes?: string;
      regex?: string;
    })
  | (Base & { t: "number"; int?: boolean; min?: number; max?: number; gt?: number; lt?: number; multipleOf?: number })
  | (Base & { t: "bigint" })
  | (Base & { t: "boolean" })
  | (Base & { t: "date" })
  | (Base & { t: "literal"; value: unknown })
  | (Base & { t: "enum"; values: unknown[] })
  | (Base & { t: "object"; props: Record<string, Shape> })
  | (Base & { t: "array"; item: Shape; min?: number; max?: number; len?: number })
  | (Base & { t: "tuple"; items: Shape[] })
  | (Base & { t: "record"; value: Shape })
  | (Base & { t: "union"; options: Shape[] })
  | (Base & { t: "null" })
  | (Base & { t: "any" });

interface Base {
  optional?: boolean;
  nullable?: boolean;
  default?: unknown;
  hasDefault?: boolean;
  description?: string;
  ref?: string; // name of the schema this came from
}

export interface Resolver {
  /** Find the initializer expression of an identifier as seen from `sf`. */
  resolve(name: string, sf: any): { node: any; sf: any; name: string } | null;
  /** Resolve `ns.Name` where ns is an `import * as ns`. */
  resolveMember(ns: string, member: string, sf: any): { node: any; sf: any; name: string } | null;
  ts: any;
}

const CONSTRUCTORS = new Set([
  "string", "number", "bigint", "boolean", "date", "object", "strictObject", "looseObject", "array", "enum",
  "nativeEnum", "literal", "union", "discriminatedUnion", "intersection", "record", "tuple", "optional", "nullable",
  "any", "unknown", "null", "undefined", "void", "never", "email", "uuid", "uuidv4", "url", "cuid", "cuid2", "ulid", "nanoid",
  "int", "int32", "float32", "float64", "lazy", "preprocess", "custom", "instanceof", "set", "map", "promise", "file",
  "datetime", "ipv4", "ipv6", "base64", "jwt", "e164", "stringbool", "templateLiteral", "guid", "hostname", "emoji",
]);

export function interpretSchema(node: any, sf: any, r: Resolver, depth = 0, seen = new Set<any>()): Shape {
  const ts = r.ts;
  if (!node || depth > 24) return { t: "any" };
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }

  if (ts.isIdentifier(node)) {
    if (seen.has(node.text + "@" + sf.fileName)) return { t: "any", ref: node.text };
    const hit = r.resolve(node.text, sf);
    if (!hit) return { t: "any", ref: node.text };
    const next = new Set(seen).add(node.text + "@" + sf.fileName);
    return { ...interpretSchema(hit.node, hit.sf, r, depth + 1, next), ref: node.text };
  }

  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && !isZ(node.expression.text)) {
    const hit = r.resolveMember(node.expression.text, node.name.text, sf);
    if (hit) return { ...interpretSchema(hit.node, hit.sf, r, depth + 1, seen), ref: node.name.text };
    return { t: "any" };
  }

  if (!ts.isCallExpression(node)) return { t: "any" };
  const callee = node.expression;
  const args = node.arguments;

  // Bare constructor call: object({...}) imported by name from zod.
  if (ts.isIdentifier(callee)) {
    return CONSTRUCTORS.has(callee.text) ? construct(callee.text, args, sf, r, depth, seen) : { t: "any" };
  }
  if (!ts.isPropertyAccessExpression(callee)) return { t: "any" };
  const method = callee.name.text;
  const target = callee.expression;

  // z.string(), z.coerce.number(), z.iso.datetime(), z.string().email() ...
  const rootName = zodRoot(target, ts);
  if (rootName !== null) return construct(method, args, sf, r, depth, seen, rootName);

  const base = interpretSchema(target, sf, r, depth + 1, seen);
  return modify(base, method, args, sf, r, depth, seen);
}

function isZ(name: string) {
  return name === "z" || name === "zod" || name === "Z";
}

/** If `expr` is `z`, `z.coerce`, `z.iso`, returns the namespace segment ("" for plain z); otherwise null. */
function zodRoot(expr: any, ts: any): string | null {
  if (ts.isIdentifier(expr) && isZ(expr.text)) return "";
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && isZ(expr.expression.text)) {
    const ns = expr.name.text;
    if (ns === "coerce" || ns === "iso" || ns === "string" || ns === "number") return ns;
  }
  return null;
}

function construct(name: string, args: any[], sf: any, r: Resolver, depth: number, seen: Set<any>, ns = ""): Shape {
  const ts = r.ts;
  const sub = (n: any) => interpretSchema(n, sf, r, depth + 1, seen);
  if (ns === "iso") return { t: "string", format: name === "date" ? "date" : name === "time" ? "time" : "datetime" };
  switch (name) {
    case "string":
    case "stringbool":
    case "templateLiteral":
      return { t: "string" };
    case "email":
    case "uuid":
    case "uuidv4":
    case "guid":
    case "url":
    case "cuid":
    case "cuid2":
    case "ulid":
    case "nanoid":
    case "datetime":
    case "ipv4":
    case "ipv6":
    case "base64":
    case "jwt":
    case "e164":
    case "hostname":
    case "emoji":
      return { t: "string", format: name === "uuidv4" || name === "guid" ? "uuid" : name };
    case "number":
    case "float32":
    case "float64":
      return { t: "number" };
    case "int":
    case "int32":
      return { t: "number", int: true };
    case "bigint":
      return { t: "bigint" };
    case "boolean":
      return { t: "boolean" };
    case "date":
      return { t: "date" };
    case "null":
      return { t: "null" };
    case "undefined":
    case "void":
      return { t: "any", optional: true };
    case "literal":
      return { t: "literal", value: literal(args[0], sf, r) };
    case "enum": {
      const v = literal(args[0], sf, r);
      if (Array.isArray(v)) return { t: "enum", values: v };
      if (v && typeof v === "object") return { t: "enum", values: Object.values(v) };
      return { t: "enum", values: [] };
    }
    case "nativeEnum":
      return { t: "enum", values: enumValues(args[0], sf, r) };
    case "object":
    case "strictObject":
    case "looseObject":
      return { t: "object", props: objectProps(args[0], sf, r, depth, seen) };
    case "array":
    case "set":
      return { t: "array", item: args[0] ? sub(args[0]) : { t: "any" } };
    case "tuple":
      return { t: "tuple", items: args[0] && ts.isArrayLiteralExpression(args[0]) ? args[0].elements.map(sub) : [] };
    case "record":
    case "map":
      return { t: "record", value: args.length > 1 ? sub(args[1]) : args[0] ? sub(args[0]) : { t: "any" } };
    case "union":
      return { t: "union", options: args[0] && ts.isArrayLiteralExpression(args[0]) ? args[0].elements.map(sub) : [] };
    case "discriminatedUnion": {
      const list = args.find((a: any) => ts.isArrayLiteralExpression(a));
      return { t: "union", options: list ? list.elements.map(sub) : [] };
    }
    case "intersection":
      return intersect(sub(args[0]), sub(args[1]));
    case "optional":
      return { ...sub(args[0]), optional: true };
    case "nullable":
      return { ...sub(args[0]), nullable: true };
    case "preprocess":
      return args[1] ? sub(args[1]) : { t: "any" };
    case "lazy": {
      const fn = args[0];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const body = ts.isBlock(fn.body) ? fn.body.statements.find((s: any) => ts.isReturnStatement(s))?.expression : fn.body;
        if (body && depth < 6) return sub(body);
      }
      return { t: "any" };
    }
    case "promise":
      return args[0] ? sub(args[0]) : { t: "any" };
    default:
      return { t: "any" };
  }
}

function modify(base: Shape, method: string, args: any[], sf: any, r: Resolver, depth: number, seen: Set<any>): Shape {
  const ts = r.ts;
  const num = (i = 0) => {
    const v = literal(args[i], sf, r);
    return typeof v === "number" ? v : undefined;
  };
  const s: any = { ...base };
  switch (method) {
    case "optional":
      return { ...s, optional: true };
    case "nullable":
      return { ...s, nullable: true };
    case "nullish":
      return { ...s, nullable: true, optional: true };
    case "default":
    case "prefault": {
      const v = literal(args[0], sf, r);
      return { ...s, default: v, hasDefault: v !== undefined };
    }
    case "describe":
      return { ...s, description: literal(args[0], sf, r) as string };
    case "min":
    case "gte":
    case "nonempty":
      if (s.t === "number") return { ...s, min: num() };
      if (s.t === "string" || s.t === "array") return { ...s, min: method === "nonempty" ? 1 : num() };
      return s;
    case "max":
    case "lte":
      if (s.t === "number" || s.t === "string" || s.t === "array") return { ...s, max: num() };
      return s;
    case "gt":
      return s.t === "number" ? { ...s, gt: num() } : s;
    case "lt":
      return s.t === "number" ? { ...s, lt: num() } : s;
    case "length":
      return s.t === "string" || s.t === "array" ? { ...s, len: num() } : s;
    case "int":
    case "safe":
      return { ...s, int: true };
    case "positive":
      return { ...s, gt: 0 };
    case "nonnegative":
      return { ...s, min: 0 };
    case "negative":
      return { ...s, lt: 0 };
    case "nonpositive":
      return { ...s, max: 0 };
    case "multipleOf":
    case "step":
      return { ...s, multipleOf: num() };
    case "email":
    case "url":
    case "uuid":
    case "cuid":
    case "cuid2":
    case "ulid":
    case "datetime":
    case "date":
    case "time":
    case "ip":
    case "emoji":
    case "base64":
    case "jwt":
      return s.t === "string" ? { ...s, format: method } : method === "date" ? { t: "date" } : s;
    case "regex": {
      const a = args[0];
      return { ...s, regex: a && ts.isRegularExpressionLiteral(a) ? a.text : undefined };
    }
    case "startsWith":
    case "endsWith":
    case "includes":
      return { ...s, [method]: literal(args[0], sf, r) };
    case "array":
      return { t: "array", item: base };
    case "or":
      return { t: "union", options: [base, interpretSchema(args[0], sf, r, depth + 1, seen)] };
    case "and":
      return intersect(base, interpretSchema(args[0], sf, r, depth + 1, seen));
    case "extend":
    case "safeExtend":
      if (s.t !== "object") return s;
      return { ...s, props: { ...s.props, ...objectProps(args[0], sf, r, depth, seen) } };
    case "merge": {
      const other = interpretSchema(args[0], sf, r, depth + 1, seen);
      return s.t === "object" && other.t === "object" ? { ...s, props: { ...s.props, ...other.props } } : s;
    }
    case "pick":
    case "omit": {
      if (s.t !== "object") return s;
      const keys = literal(args[0], sf, r);
      const set = new Set(keys && typeof keys === "object" ? Object.keys(keys) : []);
      const props: Record<string, Shape> = {};
      for (const [k, v] of Object.entries(s.props as Record<string, Shape>)) if (set.has(k) === (method === "pick")) props[k] = v;
      return { ...s, props };
    }
    case "partial":
    case "deepPartial":
      if (s.t !== "object") return { ...s, optional: true };
      return { ...s, props: Object.fromEntries(Object.entries(s.props as Record<string, Shape>).map(([k, v]) => [k, { ...v, optional: true }])) };
    case "required":
      if (s.t !== "object") return { ...s, optional: false };
      return { ...s, props: Object.fromEntries(Object.entries(s.props as Record<string, Shape>).map(([k, v]) => [k, { ...v, optional: false }])) };
    case "element":
      return s.t === "array" ? s.item : s;
    case "unwrap":
      return { ...s, optional: false, nullable: false };
    case "keyof":
      return s.t === "object" ? { t: "enum", values: Object.keys(s.props) } : s;
    case "pipe":
    case "transform":
    case "refine":
    case "superRefine":
    case "check":
    case "brand":
    case "readonly":
    case "catch":
    case "strict":
    case "passthrough":
    case "strip":
    case "trim":
    case "toLowerCase":
    case "toUpperCase":
    case "normalize":
    case "overwrite":
    case "meta":
    case "openapi":
      return s;
    default:
      return s;
  }
}

function intersect(a: Shape, b: Shape): Shape {
  if (a.t === "object" && b.t === "object") return { t: "object", props: { ...a.props, ...b.props } };
  return a.t === "any" ? b : a;
}

function objectProps(node: any, sf: any, r: Resolver, depth: number, seen: Set<any>): Record<string, Shape> {
  const ts = r.ts;
  if (node && ts.isIdentifier(node)) {
    const hit = r.resolve(node.text, sf);
    if (hit) return objectProps(hit.node, hit.sf, r, depth + 1, seen);
  }
  const out: Record<string, Shape> = {};
  if (!node || !ts.isObjectLiteralExpression(node)) return out;
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p)) {
      const key = propName(p.name, ts);
      if (key !== undefined) out[key] = interpretSchema(p.initializer, sf, r, depth + 1, seen);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      out[p.name.text] = interpretSchema(p.name, sf, r, depth + 1, seen);
    } else if (ts.isSpreadAssignment(p)) {
      // ...Other.shape
      const e = p.expression;
      if (ts.isPropertyAccessExpression(e) && e.name.text === "shape") {
        const other = interpretSchema(e.expression, sf, r, depth + 1, seen);
        if (other.t === "object") Object.assign(out, other.props);
      }
    }
  }
  return out;
}

function propName(n: any, ts: any): string | undefined {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier?.(n)) return n.text;
  return undefined;
}

/** Evaluate simple literal expressions: strings, numbers, booleans, null, arrays, objects, `as const`, identifiers to those. */
export function literal(node: any, sf: any, r: Resolver, depth = 0): unknown {
  const ts = r.ts;
  if (!node || depth > 6) return undefined;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const v = literal(node.operand, sf, r, depth + 1);
    return typeof v === "number" ? -v : undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e: any) => literal(e, sf, r, depth + 1));
  if (ts.isObjectLiteralExpression(node)) {
    const o: Record<string, unknown> = {};
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p)) {
        const k = propName(p.name, ts);
        if (k !== undefined) o[k] = literal(p.initializer, sf, r, depth + 1);
      }
    }
    return o;
  }
  if (ts.isIdentifier(node)) {
    const hit = r.resolve(node.text, sf);
    return hit ? literal(hit.node, hit.sf, r, depth + 1) : undefined;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const obj = literal(node.expression, sf, r, depth + 1) as any;
    return obj && typeof obj === "object" ? obj[node.name.text] : undefined;
  }
  return undefined;
}

function enumValues(node: any, sf: any, r: Resolver): unknown[] {
  const ts = r.ts;
  if (!node || !ts.isIdentifier(node)) return [];
  // TS enum declaration in the same file
  for (const st of sf.statements) {
    if (ts.isEnumDeclaration(st) && st.name.text === node.text) {
      let i = 0;
      return st.members.map((m: any) => {
        const v = m.initializer ? literal(m.initializer, sf, r) : i;
        if (typeof v === "number") i = v + 1;
        return v;
      });
    }
  }
  const v = literal(node, sf, r);
  return v && typeof v === "object" ? Object.values(v) : [];
}

/* --------------------------------------------------------------- examples */

const FIXED_UUID = "3f2b8c1e-7a4d-4c2b-9e1f-5d6a7b8c9d0e";

export function exampleOf(shape: Shape, key = "", depth = 0): unknown {
  if (shape.hasDefault && shape.default !== undefined) return shape.default;
  if (depth > 10) return null;
  const k = key.toLowerCase();
  switch (shape.t) {
    case "string":
      return fitString(stringFor(shape.format, k, shape), shape);
    case "number":
      return numberFor(shape, k);
    case "bigint":
      return 1;
    case "boolean":
      return true;
    case "date":
      return isoNow();
    case "literal":
      return shape.value;
    case "enum":
      return shape.values[0] ?? "";
    case "null":
      return null;
    case "object": {
      const o: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(shape.props)) o[pk] = exampleOf(pv, pk, depth + 1);
      return o;
    }
    case "array": {
      const n = Math.max(shape.len ?? 0, shape.min ?? 0, 1);
      const item = singular(k);
      return Array.from({ length: Math.min(n, 5) }, () => exampleOf(shape.item, item, depth + 1));
    }
    case "tuple":
      return shape.items.map((s, i) => exampleOf(s, `${key}${i}`, depth + 1));
    case "record":
      return { key: exampleOf(shape.value, "value", depth + 1) };
    case "union": {
      const opt = shape.options.find((o) => o.t !== "null" && o.t !== "any") ?? shape.options[0];
      return opt ? exampleOf(opt, key, depth + 1) : null;
    }
    default:
      return shape.nullable ? null : "";
  }
}

function singular(k: string) {
  if (k.endsWith("ies")) return `${k.slice(0, -3)}y`;
  if (k.endsWith("s")) return k.slice(0, -1);
  return k;
}

function isoNow() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function stringFor(format: string | undefined, k: string, s: any): string {
  switch (format) {
    case "email":
      return "amina@example.com";
    case "uuid":
      return FIXED_UUID;
    case "url":
      return "https://example.com";
    case "datetime":
      return isoNow();
    case "date":
      return isoNow().slice(0, 10);
    case "time":
      return "09:30:00";
    case "cuid":
    case "cuid2":
      return "cjld2cjxh0000qzrmn831i7rn";
    case "ulid":
      return "01HZX3Y8Q2T5V7W9K1M3N5P7R9";
    case "nanoid":
      return "V1StGXR8_Z5jdHi6B-myT";
    case "ip":
    case "ipv4":
      return "192.168.1.10";
    case "ipv6":
      return "2001:db8::1";
    case "e164":
      return "+15145550123";
    case "hostname":
      return "example.com";
    case "base64":
      return "aGVsbG8gd29ybGQ=";
    case "jwt":
      return "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
    case "emoji":
      return "*";
  }
  if (/(^|_)?e?mail$/.test(k) || k.endsWith("email")) return "amina@example.com";
  if (k === "id" || k.endsWith("id") || k.endsWith("_id")) {
    return s.len || s.min ? "id_" + "x".repeat(Math.max(0, (s.len ?? s.min) - 3)) : FIXED_UUID;
  }
  if (k === "firstname" || k === "first_name" || k === "givenname") return "Amina";
  if (k === "lastname" || k === "last_name" || k === "surname" || k === "familyname") return "Ngo";
  if (k.endsWith("name")) {
    return k === "username" ? "amina" : k.includes("company") ? "Acme Inc." : k.includes("product") ? "Canvas tote" : "Amina Ngo";
  }
  if (k.includes("phone") || k === "tel" || k === "mobile") return "+15145550123";
  if (k === "city") return "Montreal";
  if (k.includes("country")) return s.len === 3 ? "CAN" : s.len === 2 || (s.max ?? 99) <= 3 ? "CA" : "Canada";
  if (k.includes("currency")) return "CAD";
  if (k === "state" || k === "province" || k === "region") return "QC";
  if (k.includes("zip") || k.includes("postal")) return "H3B 1K9";
  if (k === "line2" || k === "address2") return "Suite 400";
  if (k.includes("line1") || k.includes("street") || k === "address") return "1200 Rue Sainte-Catherine";
  if (k.includes("password")) return "Str0ng!Passw0rd";
  if (k === "slug") return "sample-slug";
  if (k.includes("url") || k.includes("website") || k.includes("avatar") || k.includes("image") || k.includes("link")) {
    return "https://example.com";
  }
  if (k.includes("color") || k.includes("colour")) return "#2f6fed";
  if (k === "locale" || k === "lang" || k === "language") return "en";
  if (k.includes("timezone") || k === "tz") return "America/Toronto";
  if (k.includes("date") || k.endsWith("at")) return isoNow();
  if (k === "sku") return "SKU-0001";
  if (k.includes("code") || k.includes("coupon")) return "WELCOME10";
  if (k.includes("token")) return "tok_test_123";
  if (k === "title" || k === "subject") return "Sample title";
  if (/(description|note|comment|message|bio|body|content|text|reason)/.test(k)) return "Sample text";
  if (k.includes("tag")) return "featured";
  if (k.includes("role")) return "member";
  if (k.includes("status")) return "active";
  return "sample";
}

function fitString(v: string, s: any): string {
  if (s.startsWith && !v.startsWith(s.startsWith)) v = s.startsWith + v;
  if (s.endsWith && !v.endsWith(s.endsWith)) v = v + s.endsWith;
  if (s.includes && !v.includes(s.includes)) v = v + s.includes;
  const want = s.len ?? undefined;
  const min = want ?? s.min ?? 0;
  const max = want ?? s.max ?? Infinity;
  if (v.length < min) v = v + "x".repeat(min - v.length);
  if (v.length > max) v = v.slice(0, max);
  return v;
}

function numberFor(s: any, k: string): number {
  let v: number;
  if (k.includes("qty") || k.includes("quantity") || k.includes("count")) v = 1;
  else if (k.includes("price") || k.includes("amount") || k.includes("total") || k.includes("cost")) v = 19.99;
  else if (k === "age") v = 30;
  else if (k === "page") v = 1;
  else if (k.includes("limit") || k.includes("size") || k.includes("per")) v = 10;
  else if (k === "lat" || k === "latitude") v = 45.5017;
  else if (k === "lng" || k === "lon" || k === "longitude") v = -73.5673;
  else if (k.includes("year")) v = new Date().getFullYear();
  else v = 1;
  if (s.int) v = Math.round(v);
  const lo = s.min ?? (s.gt !== undefined ? s.gt + (s.int ? 1 : 0.01) : -Infinity);
  const hi = s.max ?? (s.lt !== undefined ? s.lt - (s.int ? 1 : 0.01) : Infinity);
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  if (s.multipleOf) v = Math.ceil(v / s.multipleOf) * s.multipleOf;
  return Number(v.toFixed(2));
}

/** Compact constraint labels for the UI, e.g. "int · 1–20". */
export function describeShape(shape: Shape): string {
  const parts: string[] = [];
  const s: any = shape;
  switch (shape.t) {
    case "string":
      parts.push(s.format ?? "string");
      if (s.len !== undefined) parts.push(`exactly ${s.len} chars`);
      else if (s.min !== undefined && s.max !== undefined) parts.push(`${s.min}–${s.max} chars`);
      else if (s.min !== undefined) parts.push(`min ${s.min} chars`);
      else if (s.max !== undefined) parts.push(`max ${s.max} chars`);
      if (s.regex) parts.push(`matches ${s.regex}`);
      break;
    case "number": {
      parts.push(s.int ? "int" : "number");
      if (s.min !== undefined && s.max !== undefined) parts.push(`${s.min}–${s.max}`);
      else {
        const lo = s.min !== undefined ? `≥ ${s.min}` : s.gt !== undefined ? `> ${s.gt}` : "";
        const hi = s.max !== undefined ? `≤ ${s.max}` : s.lt !== undefined ? `< ${s.lt}` : "";
        if (lo || hi) parts.push([lo, hi].filter(Boolean).join(", "));
      }
      break;
    }
    case "enum":
      parts.push(s.values.map((v: unknown) => JSON.stringify(v)).join(" | "));
      break;
    case "literal":
      parts.push(JSON.stringify(s.value));
      break;
    case "array":
      parts.push(`array of ${describeShape(s.item)}`);
      if (s.min !== undefined) parts.push(`min ${s.min}`);
      if (s.max !== undefined) parts.push(`max ${s.max}`);
      break;
    case "object":
      parts.push(s.ref ? s.ref : "object");
      break;
    default:
      parts.push(shape.t);
  }
  if (shape.nullable) parts.push("nullable");
  if (shape.hasDefault) parts.push(`default ${JSON.stringify(shape.default)}`);
  return parts.join(" · ");
}

export function fileExists(p: string) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export const _path = path;
