import { describe, expect, test } from "vitest";
import { makeRedactor, preview, redactHeaders } from "../src/serialize";

describe("key matching contract", () => {
  test("exact (case-insensitive) match", () => {
    const r = makeRedactor(["authorization"]);
    expect(r.hit("Authorization")).toBe(true);
    expect(r.hit("AUTHORIZATION")).toBe(true);
    expect(r.hit("authorization")).toBe(true);
  });

  test("non-matching keys stay untouched", () => {
    const r = makeRedactor(["password"]);
    expect(r.hit("username")).toBe(false);
    expect(r.hit("email")).toBe(false);
  });

  test("substring match applies when the configured key is >3 chars long", () => {
    const r = makeRedactor(["password"]);
    expect(r.hit("userPassword")).toBe(true);
    expect(r.hit("confirmPassword")).toBe(true);
    expect(r.hit("Password_Hash")).toBe(true);
  });

  test("short configured keys do NOT substring-match (avoid false positives)", () => {
    const r = makeRedactor(["pw"]);
    expect(r.hit("pw")).toBe(true); // exact
    expect(r.hit("userpw")).toBe(false); // substring suppressed because `pw` is <=3 chars
  });

  test("mask preserves a prefix for recognisability on long values", () => {
    const r = makeRedactor(["token"]);
    expect(r.mask("verylongsecrettoken")).toBe("very… [redacted]");
  });

  test("mask on short values hides the entire thing", () => {
    const r = makeRedactor(["token"]);
    expect(r.mask("abc")).toBe("[redacted]");
    expect(r.mask("12345678")).toBe("[redacted]");
  });

  test("mask on object serialises first, then truncates", () => {
    const r = makeRedactor(["token"]);
    expect(r.mask({ nested: "value" })).toContain("[redacted]");
  });
});

describe("preview nested redaction", () => {
  test("secret key hidden at depth 3", () => {
    const r = makeRedactor(["password"]);
    const data = { outer: { middle: { password: "s3cret-very-long" } } };
    const out = preview(data, r) as any;
    expect(out.outer.middle.password).toContain("[redacted]");
  });

  test("secret in array of objects", () => {
    const r = makeRedactor(["token"]);
    const data = {
      users: [
        { name: "a", token: "aaaaaa1234" },
        { name: "b", token: "bbbbbb5678" },
      ],
    };
    const out = preview(data, r) as any;
    expect(out.users[0].token).toContain("[redacted]");
    expect(out.users[1].token).toContain("[redacted]");
    expect(out.users[0].name).toBe("a");
  });

  test("multiple distinct keys redacted", () => {
    const r = makeRedactor(["password", "ssn", "card_number"]);
    const data = { password: "p1234567", ssn: "123-45-6789", card_number: "4111111111111111", email: "a@b.c" };
    const out = preview(data, r) as any;
    expect(out.password).toContain("[redacted]");
    expect(out.ssn).toContain("[redacted]");
    expect(out.card_number).toContain("[redacted]");
    expect(out.email).toBe("a@b.c");
  });

  test("non-string values at a redacted key are also masked", () => {
    const r = makeRedactor(["secret"]);
    const data = { secret: { embedded: "data" }, otherSecret: [1, 2, 3] };
    const out = preview(data, r) as any;
    expect(typeof out.secret).toBe("string");
    expect(out.secret).toContain("[redacted]");
    expect(out.otherSecret).toContain("[redacted]");
  });

  test("empty key list redacts nothing", () => {
    const r = makeRedactor([]);
    const data = { password: "exposed", token: "visible" };
    const out = preview(data, r) as any;
    expect(out.password).toBe("exposed");
    expect(out.token).toBe("visible");
  });
});

describe("redactHeaders", () => {
  test("masks matching headers, keeps others", () => {
    const r = makeRedactor(["authorization", "cookie"]);
    const headers = {
      authorization: "Bearer verylongtokenstring",
      cookie: "session=abc; csrf=def",
      "user-agent": "curl/8.0",
      "x-request-id": "req-123",
    };
    const out = redactHeaders(headers, r);
    expect(out.authorization).toContain("[redacted]");
    expect(out.cookie).toContain("[redacted]");
    expect(out["user-agent"]).toBe("curl/8.0");
    expect(out["x-request-id"]).toBe("req-123");
  });

  test("case-insensitive on header name", () => {
    const r = makeRedactor(["authorization"]);
    const headers = { Authorization: "Bearer x" };
    expect(redactHeaders(headers, r).Authorization).toContain("[redacted]");
  });

  test("array-valued headers (Node's set-cookie) are joined and masked", () => {
    const r = makeRedactor(["set-cookie"]);
    const headers = { "set-cookie": ["a=1", "b=2"] };
    const out = redactHeaders(headers, r);
    expect(out["set-cookie"]).toContain("[redacted]");
  });

  test("undefined header values are dropped (not stringified)", () => {
    const r = makeRedactor([]);
    const headers = { "x-dropped": undefined, "x-kept": "value" };
    const out = redactHeaders(headers, r);
    expect(out["x-dropped"]).toBeUndefined();
    expect(out["x-kept"]).toBe("value");
  });

  test("numeric and boolean values are stringified cleanly", () => {
    const r = makeRedactor([]);
    const headers = { "content-length": 42, "x-flag": true };
    const out = redactHeaders(headers, r);
    expect(out["content-length"]).toBe("42");
    expect(out["x-flag"]).toBe("true");
  });
});

describe("preview depth + width caps", () => {
  test("preview depth caps at 5 levels", () => {
    const r = makeRedactor([]);
    const build = (n: number): any => (n === 0 ? "leaf" : { x: build(n - 1) });
    const data = build(10);
    const out = preview(data, r) as any;
    // At depth 5, the object is summarised as a placeholder instead of recursed into.
    let cur: any = out;
    for (let i = 0; i < 5; i++) cur = cur?.x;
    expect(typeof cur).toBe("string");
    expect(cur).toContain("Object");
  });

  test("arrays beyond MAX_ITEMS are truncated with a counter entry", () => {
    const r = makeRedactor([]);
    const arr = Array.from({ length: 30 }, (_, i) => i);
    const out = preview(arr, r) as any[];
    expect(out.length).toBe(26); // 25 items + 1 "N more" sentinel
    expect(String(out[25])).toContain("more");
  });

  test("objects with more than MAX_KEYS keys expose a trailing counter", () => {
    const r = makeRedactor([]);
    const obj: Record<string, number> = {};
    for (let i = 0; i < 60; i++) obj[`k${i}`] = i;
    const out = preview(obj, r) as any;
    expect(out["…"]).toContain("more keys");
  });

  test("circular references are caught and marked [Circular]", () => {
    const r = makeRedactor([]);
    const a: any = { name: "a" };
    a.self = a;
    const out = preview(a, r) as any;
    expect(out.self).toBe("[Circular]");
  });
});
