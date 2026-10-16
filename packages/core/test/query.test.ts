import { describe, expect, test } from "vitest";
import {
  type QueryTarget,
  compileGlob,
  compileQuery,
  inSinceScope,
  matchQuery,
  parseQuery,
  parseSinceParam,
  summaryTarget,
} from "../src/query";

const base: QueryTarget = {
  method: "GET",
  path: "/api/orders/42",
  route: "/api/orders/[id]",
  kind: "route",
  status: 200,
  duration: 120,
  cold: false,
  rules: [],
  error: false,
  text: ["/api/orders/42?x=1"],
};
const t = (over: Partial<QueryTarget> = {}): QueryTarget => ({ ...base, ...over });
const m = (q: string, target: QueryTarget) => matchQuery(parseQuery(q), target);

describe("parseQuery", () => {
  test("empty query has no terms and matches everything", () => {
    expect(parseQuery("")).toEqual({ terms: [], errors: [] });
    expect(parseQuery("   ").terms).toEqual([]);
    expect(m("", t())).toBe(true);
  });

  test("status forms", () => {
    expect(parseQuery("status:5xx").terms[0]).toMatchObject({ key: "status", ranges: [[500, 599]] });
    expect(parseQuery("status:404").terms[0]).toMatchObject({ ranges: [[404, 404]] });
    expect(parseQuery("status:>=400").terms[0]).toMatchObject({ ranges: [[400, Number.POSITIVE_INFINITY]] });
    expect(parseQuery("status:>400").terms[0]).toMatchObject({ ranges: [[401, Number.POSITIVE_INFINITY]] });
    expect(parseQuery("status:<300").terms[0]).toMatchObject({ ranges: [[Number.NEGATIVE_INFINITY, 299]] });
    expect(parseQuery("status:499..400").terms[0]).toMatchObject({ ranges: [[400, 499]] });
    expect(parseQuery("status:404,5XX").terms[0]).toMatchObject({
      ranges: [
        [404, 404],
        [500, 599],
      ],
    });
  });

  test("dur forms and units", () => {
    expect(parseQuery("dur:>200").terms[0]).toMatchObject({ key: "dur", min: 200, minExcl: true });
    expect(parseQuery("dur:>1.5s").terms[0]).toMatchObject({ min: 1500, minExcl: true });
    expect(parseQuery("dur:<=50ms").terms[0]).toMatchObject({ min: 0, max: 50, maxExcl: false });
    expect(parseQuery("dur:200").terms[0]).toMatchObject({ min: 200, max: Number.POSITIVE_INFINITY });
    expect(parseQuery("dur:500..100").terms[0]).toMatchObject({ min: 100, max: 500 });
  });

  test("lists, aliases and case", () => {
    expect(parseQuery("method:get,Post").terms[0]).toMatchObject({ values: ["GET", "POST"] });
    expect(parseQuery("kind:Route,PAGE").terms[0]).toMatchObject({ values: ["route", "page"] });
    expect(parseQuery("has:n+1").terms[0]).toMatchObject({ values: ["n-plus-1"] });
    expect(parseQuery("has:N-Plus-1,errors").terms[0]).toMatchObject({ values: ["n-plus-1", "error"] });
    expect(parseQuery("STATUS:5xx").terms[0]).toMatchObject({ key: "status" });
  });

  test("free text: bare words, quotes, escapes, text: key", () => {
    const q = parseQuery(`Timeout "connection refused" text:"upstream \\"503\\"" -health`);
    expect(q.terms).toEqual([
      { key: "text", neg: false, value: "timeout" },
      { key: "text", neg: false, value: "connection refused" },
      { key: "text", neg: false, value: 'upstream "503"' },
      { key: "text", neg: true, value: "health" },
    ]);
    expect(q.errors).toEqual([]);
  });

  test("unknown keys fall back to free text (urls stay searchable)", () => {
    expect(parseQuery("http://x.test/a").terms).toEqual([{ key: "text", neg: false, value: "http://x.test/a" }]);
    expect(parseQuery("foo:bar").terms[0]).toMatchObject({ key: "text", value: "foo:bar" });
  });

  test("bad values are reported and dropped, the rest still applies", () => {
    const q = parseQuery("status:abc dur:fast cold:maybe method:POST route:");
    expect(q.terms).toEqual([{ key: "method", neg: false, values: ["POST"] }]);
    expect(q.errors).toHaveLength(4);
    expect(q.errors[0]).toMatch(/status:abc/);
  });

  test("malformed input never throws", () => {
    const nasty = [
      '"',
      '"unterminated',
      "-",
      "--",
      "status:",
      "dur:>",
      "dur:>>5",
      "status:9999",
      "route:[(",
      "route:**/**",
      "has:,,,",
      ":::",
      "\\",
      "\u0000\u0001",
      "a".repeat(10_000),
      `status:${"5".repeat(400)}`,
      "dur:1e309",
      "dur:.5s",
      null as unknown as string,
      undefined as unknown as string,
      42 as unknown as string,
    ];
    for (const input of nasty) {
      expect(() => parseQuery(input)).not.toThrow();
      const q = parseQuery(input);
      expect(() => matchQuery(q, t())).not.toThrow();
    }
    expect(parseQuery('"open').errors[0]).toMatch(/Unterminated/);
    expect(parseQuery('"open').terms[0]).toMatchObject({ key: "text", value: "open" });
  });
});

describe("matchQuery", () => {
  test("status", () => {
    expect(m("status:2xx", t())).toBe(true);
    expect(m("status:5xx", t({ status: 503 }))).toBe(true);
    expect(m("status:>=400", t({ status: 404 }))).toBe(true);
    expect(m("status:>=400", t({ status: 399 }))).toBe(false);
    expect(m("status:404", t({ status: undefined }))).toBe(false);
  });

  test("dur, exclusive and inclusive bounds; in-flight never matches", () => {
    expect(m("dur:>120", t())).toBe(false);
    expect(m("dur:>=120", t())).toBe(true);
    expect(m("dur:<120", t())).toBe(false);
    expect(m("dur:100..200", t())).toBe(true);
    expect(m("dur:>0.1s", t())).toBe(true);
    expect(m("dur:>1", t({ duration: undefined }))).toBe(false);
  });

  test("route glob against template or path", () => {
    expect(m("route:/api/*", t())).toBe(true);
    expect(m("route:/api/orders/[id]", t())).toBe(true);
    expect(m("route:/api", t())).toBe(true); // path prefix
    expect(m("route:/ap", t())).toBe(false); // not a segment prefix
    expect(m("route:/api/orders/4?", t())).toBe(true);
    expect(m("route:*/orders/*", t())).toBe(true);
    expect(m("route:/pages/*", t())).toBe(false);
  });

  test("compileGlob treats regex specials literally", () => {
    expect(compileGlob("/a.b").test("/axb")).toBe(false);
    expect(compileGlob("/a.b").test("/a.b")).toBe(true);
    expect(compileGlob("/x/(group)/*").test("/x/(group)/y")).toBe(true);
  });

  test("compileGlob: stars, ?, case, trailing slash prefix", () => {
    expect(compileGlob("/API/*").test("/api/x/y")).toBe(true);
    expect(compileGlob("*/orders/*").test("/api/orders/1")).toBe(true);
    expect(compileGlob("/a**b").test("/axxb")).toBe(true);
    expect(compileGlob("/a*b").test("/axxc")).toBe(false);
    expect(compileGlob("/a?c").test("/abc")).toBe(true);
    expect(compileGlob("/a?c").test("/ac")).toBe(false);
    expect(compileGlob("/api/").test("/api/x")).toBe(true);
    expect(compileGlob("*").test("")).toBe(true);
  });

  test("compileGlob stays linear on many stars (no catastrophic backtracking)", () => {
    const pat = compileGlob(`/${"*a".repeat(25)}*z`);
    const s = `/${"a".repeat(5000)}`;
    const t0 = performance.now();
    expect(pat.test(s)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("a lone `-` is ignored, not a text term", () => {
    expect(parseQuery("-")).toEqual({ terms: [], errors: [] });
    expect(parseQuery("foo -").terms).toEqual([{ key: "text", neg: false, value: "foo" }]);
  });

  test("method, kind, cold, has", () => {
    expect(m("method:post,get", t())).toBe(true);
    expect(m("method:POST", t())).toBe(false);
    expect(m("kind:page", t())).toBe(false);
    expect(m("cold:true", t({ cold: true }))).toBe(true);
    expect(m("cold:false", t({ cold: undefined }))).toBe(true);
    expect(m("has:n-plus-1", t({ rules: ["n-plus-1"] }))).toBe(true);
    expect(m("has:duplicate", t({ rules: ["n-plus-1"] }))).toBe(false);
    expect(m("has:findings", t({ rules: ["slow-fn"] }))).toBe(true);
    expect(m("has:findings", t())).toBe(false);
    expect(m("has:error", t({ error: true }))).toBe(true);
  });

  test("free text is case-insensitive, AND-ed, and lazy sources run once at most", () => {
    let calls = 0;
    const target = t({
      text: [
        "/api/orders/42",
        () => {
          calls++;
          return "Upstream TIMEOUT after 3s";
        },
      ],
    });
    expect(m("timeout", target)).toBe(true);
    expect(m("orders timeout", target)).toBe(true);
    expect(m("orders nope", target)).toBe(false);
    calls = 0;
    expect(m("orders", target)).toBe(true);
    expect(calls).toBe(0); // found in the cheap source, the thunk never ran
    calls = 0;
    expect(m("upstream after", target)).toBe(true);
    expect(calls).toBe(1);
    const throwing = t({
      text: [
        () => {
          throw new Error("boom");
        },
      ],
    });
    expect(m("x", throwing)).toBe(false);
  });

  test("negation applies to any term", () => {
    expect(m("-status:2xx", t())).toBe(false);
    expect(m("-status:5xx", t())).toBe(true);
    expect(m("-orders", t())).toBe(false);
    expect(m("-has:n-plus-1", t())).toBe(true);
  });

  test("combined query from the plan", () => {
    const q = compileQuery('status:5xx dur:>200 route:/api/* has:n+1 "timeout"');
    expect(q.query.errors).toEqual([]);
    expect(
      q.test(t({ status: 502, duration: 900, rules: ["n-plus-1"], text: ["/api/orders/42", "fetch timeout"] })),
    ).toBe(true);
    expect(q.test(t({ status: 502, duration: 150, rules: ["n-plus-1"], text: ["timeout"] }))).toBe(false);
  });

  test("summaryTarget maps a TraceSummary", () => {
    const target = summaryTarget({
      method: "POST",
      path: "/api/pay",
      url: "/api/pay?retry=1",
      route: "/api/pay",
      kind: "route",
      status: 500,
      duration: 40,
      error: "Card declined",
      facts: { cold: true },
      findings: [{ rule: "swallowed-error" }],
    });
    expect(matchQuery(parseQuery("method:post status:5xx cold:true has:swallowed declined retry"), target)).toBe(true);
  });
});

describe("?since=<epoch>", () => {
  test("parseSinceParam takes 7 or e7; anything else is ignored", () => {
    expect(parseSinceParam("7")).toBe(7);
    expect(parseSinceParam("e7")).toBe(7);
    expect(parseSinceParam(" E0 ")).toBe(0);
    for (const bad of [null, undefined, "", "e", "-1", "1.5", "e7x", "abc"])
      expect(parseSinceParam(bad)).toBeUndefined();
  });

  test("inSinceScope: epoch >= since; no epoch yet is out; no since keeps everything", () => {
    expect(inSinceScope({ facts: { epoch: 3 } }, 3)).toBe(true);
    expect(inSinceScope({ facts: { epoch: 4 } }, 3)).toBe(true);
    expect(inSinceScope({ facts: { epoch: 2 } }, 3)).toBe(false);
    expect(inSinceScope({}, 0)).toBe(false);
    expect(inSinceScope({}, undefined)).toBe(true);
  });
});
