// The request path's control-flow model (src/cfg.ts): structure, labels and the offsets the truth
// model joins V8's block ranges at (every arm start is its first token).
import { describe, expect, test } from "vitest";
import {
  type CfgExpr,
  type CfgFunction,
  type CfgIf,
  type CfgLoop,
  type CfgNode,
  type CfgStmt,
  type CfgSwitch,
  type CfgTry,
  MAX_TEXT,
  buildCfg,
  clipLabel,
  walkCfg,
} from "../src/cfg";
import { loadTypeScript } from "../src/ts";

const ts = loadTypeScript(process.cwd());
// A generous parse budget: the production 250ms is wall time, and under a loaded parallel run a
// fixture blew it and folded, so the decision a test reads was missing (a TypeError, not a bug).
// The budget test below passes its own maxMs and clock.
const cfg = (text: string, file = "x.js", opts = {}) => buildCfg(ts, text, file, { maxMs: 10_000, ...opts })!;
const fn = (text: string, name: string, file = "x.js") => {
  const f = cfg(text, file).functions.find((x) => x.name === name);
  if (!f) throw new Error(`no ${name}`);
  return f;
};
/** The text an offset points at. */
const at = (text: string, o: number, n = 12) => text.slice(o, o + n);
const body = (f: CfgFunction) => f.body.body;

describe("functions", () => {
  test("every function-like with a body, its kind, name and V8 start candidates", () => {
    const text = [
      "export async function findProduct(id) { return id; }",
      "const arrow = (a) => a + 1;",
      "class K { static s(a) { return a; } get g() { return 1; } constructor(x) { this.x = x; } m() {} }",
      "const obj = { om() {}, p: function () {} };",
      "function* gen() { yield 1; }",
      "declare function nope(): void;",
    ].join("\n");
    const c = cfg(text, "x.ts");
    expect(c.functions.map((f) => [f.name, f.kind, f.async, f.generator])).toEqual([
      ["findProduct", "function", true, false],
      ["arrow", "arrow", false, false],
      ["s", "method", false, false],
      ["get g", "getter", false, false],
      ["K", "constructor", false, false],
      ["m", "method", false, false],
      ["om", "method", false, false],
      ["p", "function", false, false],
      ["gen", "function", false, true],
    ]);
    const find = c.functions[0]!;
    // `export` is not JS V8 counts from: the function's range starts at `async`.
    expect(find.starts.map((o) => at(text, o, 6))).toEqual(["export", "async "]);
    const s = c.functions[2]!;
    expect(s.starts.map((o) => at(text, o, 6))).toEqual(["static", "s(a) {"]);
    expect(c.functions[1]!.starts).toEqual([text.indexOf("(a) =>")]);
    expect(find.line).toBe(1);
    expect(find.endLine).toBe(1);
  });

  test("a concise arrow is one return of its expression; nested functions are their own, linked by id", () => {
    const text = `function outer(xs) {
  const ys = xs.map((x) => (x > 1 ? x : 0));
  function helper() { return 1; }
  return ys.filter(Boolean);
}`;
    const c = cfg(text);
    const outer = c.functions.find((f) => f.name === "outer")!;
    const arrow = c.functions.find((f) => f.kind === "arrow")!;
    const helper = c.functions.find((f) => f.name === "helper")!;
    expect(arrow.parent).toBe(outer.id);
    expect(outer.nested).toEqual([helper.id]);
    const [decl, ret] = body(outer) as [CfgStmt, CfgNode];
    expect(decl.fns).toEqual([arrow.id]);
    expect(decl.calls).toEqual(["xs.map"]);
    // The ternary belongs to the arrow, not to the statement that creates it.
    expect(decl.exprs).toEqual([]);
    const only = body(arrow)[0]!;
    expect(only).toMatchObject({ k: "exit", kind: "return" });
    expect((only as any).exprs.map((e: CfgExpr) => e.label)).toEqual(["x > 1"]);
    expect(ret).toMatchObject({ k: "exit", kind: "return", calls: ["ys.filter"] });
    // Function declarations are hoisted: not statements.
    expect(body(outer).length).toBe(2);
  });
});

describe("decisions and their arm offsets", () => {
  const text = `async function checkout(order, user) {
  if (!user) {
    return { ok: false };
  } else if (user.banned) throw new Error("banned");
  else {
    await audit(user);
  }
  if (order.rush) notify();
  switch (order.status) {
    case "new":
      total = 1;
    case "paid":
    case "held":
      break;
    default:
      total = 0;
  }
  const d = user.vip ? 0.2 : 0;
  const label = order.coupon && order.coupon.toUpperCase();
  const pure = order.coupon && order.coupon.length;
  try {
    await save(order);
  } catch (err) {
    return { ok: false };
  } finally {
    done();
  }
  return order.note ?? null;
}`;
  const f = fn(text, "checkout");

  test("if / else-if / else flatten into one decision; arms start at their first token", () => {
    const first = body(f)[0] as CfgIf;
    expect(first).toMatchObject({ k: "if", label: "!user", hasElse: true, line: 2 });
    expect(first.arms.map((a) => [a.label, a.line, at(text, a.start, 8)])).toEqual([
      ["then", 2, "{\n    re"],
      ["else if user.banned", 4, "throw ne"],
      ["else", 5, "{\n    aw"],
    ]);
    expect(first.awaits).toBe(0);
    const rush = body(f)[1] as CfgIf;
    expect(rush).toMatchObject({ hasElse: false, label: "order.rush" });
    expect(rush.arms.map((a) => at(text, a.start, 8))).toEqual(["notify()"]);
  });

  test("switch keeps every clause in order (empty ones too), starting at `case`", () => {
    const sw = body(f)[2] as CfgSwitch;
    expect(sw.cases.map((c) => [c.label, c.isDefault, c.body.length, at(text, c.start, 4)])).toEqual([
      ['case "new"', false, 1, "case"],
      ['case "paid"', false, 0, "case"],
      ['case "held"', false, 1, "case"],
      ["default", true, 1, "defa"],
    ]);
  });

  test("ternary always; && only when its right side has a side effect or is returned", () => {
    const [d, label, pure] = body(f).slice(3, 6) as CfgStmt[];
    expect(d!.exprs.map((e) => [e.k, e.op, e.label, e.shown, e.arms.map((a) => at(text, a.start, 3))])).toEqual([
      ["cond", "?:", "user.vip", true, ["0.2", "0;\n"]],
    ]);
    expect(label!.exprs.map((e) => [e.op, e.shown, at(text, e.arms[0]!.start, 12)])).toEqual([
      ["&&", true, "order.coupon"],
    ]);
    expect(pure!.exprs.map((e) => [e.op, e.shown])).toEqual([["&&", false]]);
    const ret = body(f)[7] as any;
    expect(ret.exprs.map((e: CfgExpr) => [e.op, e.shown, e.label])).toEqual([["??", true, "order.note ??"]]);
  });

  test("try / catch / finally with their starts; awaits counted on statements", () => {
    const tr = body(f)[6] as CfgTry;
    expect(tr.k).toBe("try");
    expect(at(text, tr.catch!.start, 5)).toBe("catch");
    expect(at(text, tr.finally!.start, 1)).toBe("{");
    expect((tr.block.body[0] as CfgStmt).awaits).toBe(1);
    expect(tr.catch!.body.body[0]).toMatchObject({ k: "exit", kind: "return" });
  });
});

describe("loops and exits", () => {
  test("every loop kind, its body start, labels and break / continue targets", () => {
    const text = `async function loops(xs, o, it) {
  outer: for (let i = 0; i < 3; i++) {
    for (const x of xs) {
      if (x) continue outer;
      if (!x) break outer;
    }
  }
  for (const k in o) k;
  for await (const v of it) v;
  while (xs.length) xs.pop();
  do { xs.push(1); } while (xs.length < 2);
  block: { break block; }
}`;
    const f = fn(text, "loops");
    const loops: CfgLoop[] = [];
    walkCfg(f, (n) => {
      if ("k" in n && n.k === "loop") loops.push(n);
    });
    expect(loops.map((l) => [l.loop, l.label, l.labels ?? [], at(text, l.bodyStart, 1)])).toEqual([
      ["for", "for (let i = 0; i < 3; i++)", ["outer"], "{"],
      ["for-of", "for (const x of xs)", [], "{"],
      ["for-in", "for (const k in o)", [], "k"],
      ["for-await", "for await (const v of it)", [], "v"],
      ["while", "while (xs.length)", [], "x"],
      ["do", "do ... while (xs.length < 2)", [], "{"],
    ]);
    const exits: string[] = [];
    walkCfg(f, (n) => {
      if ("k" in n && n.k === "exit") exits.push(`${n.kind}:${n.target ?? ""}`);
    });
    expect(exits).toEqual(["continue:outer", "break:outer", "break:block"]);
    const labeled = body(f)[body(f).length - 1]!;
    expect(labeled).toMatchObject({ k: "block", labels: ["block"] });
  });

  test("early vs final return, throw", () => {
    const text = "function f(a) {\n  if (a) return 1;\n  if (!a) throw new Error('x');\n  return 2;\n}";
    const f = fn(text, "f");
    const kinds: string[] = [];
    walkCfg(f, (n) => {
      if ("k" in n && n.k === "exit") kinds.push(`${n.kind}@${n.line}`);
    });
    expect(kinds).toEqual(["return@2", "throw@3", "return@4"]);
  });
});

describe("TypeScript", () => {
  test("type-only statements are not steps; `public` / `static` starts", () => {
    const text = `interface I { a: number }
type T = string;
declare const x: number;
export class C {
  public static run(a: number): number {
    const b: T = "x" as T;
    return a;
  }
}`;
    const c = cfg(text, "c.ts");
    const run = c.functions.find((f) => f.name === "run")!;
    expect(run.starts.map((o) => at(text, o, 4))).toEqual(["publ", "run("]);
    expect(body(run).map((n) => n.k)).toEqual(["stmt", "exit"]);
  });
});

describe("code its statement may skip, and code V8 counts elsewhere", () => {
  /** Every expression decision of `f`, as `op label guarded shown`. */
  const decisions = (f: CfgFunction) => {
    const out: string[] = [];
    walkCfg(f, (n) => {
      if (n.k === "cond" || n.k === "logical") out.push(`${n.op} ${n.label} ${!!n.guarded} ${n.shown}`);
    });
    return out;
  };

  test("an optional chain's tail after `?.` is guarded; its head and what follows a plain call are not", () => {
    const text =
      "function f(o, c) { o?.f(c ? 1 : 2); (c ? o : o)?.g(c && h()); a?.b(x).c(y ? 1 : 2); o?.[c ? 'a' : 'b']; }";
    expect(decisions(fn(text, "f"))).toEqual([
      "?: c true true",
      "?: c false true",
      "&& c && true true",
      "?: y true true",
      "?: c true true",
    ]);
  });

  test("destructuring defaults (binding, assignment, array, for-of) are guarded; the value is not", () => {
    const text = [
      "function f(o, c, xs) {",
      "  const { a = c ? 1 : 2, b: [d = c && g()] } = c ? o : {};",
      "  ({ e = c ? 3 : 4 } = o);",
      "  [x = c ? 5 : 6] = xs;",
      "  for (const { k = c ? 7 : 8 } of (c ? xs : [])) {}",
      "}",
    ].join("\n");
    expect(decisions(fn(text, "f"))).toEqual([
      "?: c false true",
      "?: c true true",
      "&& c && true true",
      "?: c true true",
      "?: c true true",
      "?: c false true",
      "?: c true true",
    ]);
  });

  test("logical assignment is never shown (no counter for its right side); its right side is guarded", () => {
    const text = "function f(x, c) { x ||= g(); x &&= c ? 1 : 2; x ??= h(); return x; }";
    expect(decisions(fn(text, "f"))).toEqual([
      "||= x ||= false false",
      "&&= x &&= false false",
      "?: c true true",
      "??= x ??= false false",
    ]);
  });

  test("parameter defaults: flagged, their functions are the function's own, their decisions left out", () => {
    const text = "const p = (a = () => 1, { b = 2 } = {}) => a(); function q(x) { return x; }";
    const c = cfg(text);
    const pf = c.functions.find((x) => x.name === "p")!;
    expect(pf.paramInit).toBe(true);
    const a = c.functions.find((x) => x.start === text.indexOf("() => 1"))!;
    expect(a).toMatchObject({ kind: "arrow", parent: pf.id });
    expect(pf.nested).toContain(a.id);
    expect(c.functions.find((x) => x.name === "q")!.paramInit).toBeUndefined();
  });

  test("class static blocks and field initializers inside a function: functions kept, decisions not", () => {
    const text = "function f(c) { class K { static { K.h = () => 1; } x = c ? 1 : 2; y = () => 2; } return K; }";
    const c = cfg(text);
    const f = c.functions.find((x) => x.name === "f")!;
    const starts = c.functions.filter((x) => x.parent === f.id).map((x) => text.slice(x.start, x.start + 7));
    expect(starts.sort()).toEqual(["() => 1", "() => 2"]);
    expect(decisions(f)).toEqual([]);
  });

  test("`with (o) body` walks its body like a block", () => {
    const text = "function f(o, x) { with (o) { if (x > 1) return v; } g(); return 2; }";
    const f = fn(text, "f");
    expect(body(f).map((n) => n.k)).toEqual(["block", "stmt", "exit"]);
    expect((body(f)[0] as any).body.map((n: CfgNode) => n.k)).toEqual(["if"]);
  });
});

describe("caps", () => {
  test("a 5000-term chain folds the statement instead of overflowing the stack", () => {
    const expr = Array.from({ length: 5000 }, (_, i) => `a.f${i}()`).join(" && ");
    const t0 = performance.now();
    const c = cfg(`function g(a) { const v = 1; return ${expr}; }`, "chain5000.js");
    const g = c.functions.find((x) => x.name === "g")!;
    expect(c.truncated).toBe(true);
    expect(g.truncated).toBe(true);
    expect(body(g).map((n) => n.k)).toEqual(["stmt", "fold"]);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("nesting deep enough to overflow the stack (TypeScript's parser here) is a truncated file, not a throw", () => {
    const c = cfg(`function h(a) { return ${"a ? (".repeat(3000)}1${") : 0".repeat(3000)}; }`, "nest.js");
    expect(c).toMatchObject({ truncated: true, functions: [] });
  });

  test("a 2000-term chain stays within the node cap and its labels read a bounded slice", () => {
    const expr = Array.from({ length: 2000 }, (_, i) => `a.f${i}()`).join(" && ");
    const c = cfg(`function g(a) { return ${expr}; }`, "chain2000.js");
    const g = c.functions[0]!;
    expect(g.nodeCount).toBeLessThanOrEqual(2001);
    expect(c.truncated).toBe(true);
  });

  test("past maxNodes the rest of a block folds into one node; the function is truncated", () => {
    const stmts = Array.from({ length: 30 }, (_, i) => `  x += ${i};`).join("\n");
    const text = `function big(x) {\n${stmts}\n  return x;\n}`;
    const f = buildCfg(ts, text, "big.js", { maxNodes: 10 })!.functions[0]!;
    expect(f.truncated).toBe(true);
    const last = body(f)[body(f).length - 1]!;
    expect(last).toMatchObject({ k: "fold" });
    expect((last as any).count + body(f).length - 1).toBe(31);
  });

  test("past the time budget every remaining block folds", () => {
    let t = 0;
    const text = `function a() { ${"x++; ".repeat(200)} }\nfunction b() { y++; }`;
    const c = buildCfg(ts, text, "slow.js", { maxMs: 5, now: () => (t += 10) })!;
    expect(c.truncated).toBe(true);
    expect(c.functions.some((f) => f.truncated)).toBe(true);
  });

  test("a file over MAX_TEXT is not parsed", () => {
    const c = cfg(`// ${"x".repeat(MAX_TEXT)}`, "huge.js");
    expect(c).toMatchObject({ truncated: true, functions: [] });
  });

  test("the model of an unchanged text is cached", () => {
    // The production call (no options): passing maxMs/maxNodes bypasses the cache on purpose.
    const text = "function f(a) { return a ? 1 : 2; }";
    const prod = (t: string) => buildCfg(ts, t, "cache.js")!;
    expect(prod(text)).toBe(prod(text));
    expect(prod(`${text} `)).not.toBe(prod(text));
  });

  test("labels are clipped; syntax errors flagged; no TypeScript, no model", () => {
    expect(clipLabel(`a  &&\n  ${"b".repeat(80)}`)).toHaveLength(60);
    expect(clipLabel("a\n  && b")).toBe("a && b");
    expect(cfg("function f( {", "bad.js").syntaxErrors).toBe(true);
    expect(buildCfg(null, "function f() {}", "x.js")).toBeUndefined();
  });
});
