import zlib from "node:zlib";
import { describe, expect, test } from "vitest";
import { decodeBody, toCapture } from "../src/capture";
import type { Runtime } from "../src/runtime";
import { makeRedactor } from "../src/serialize";

const rt = { redactor: makeRedactor([]), root: process.cwd() } as unknown as Runtime;

function captureRaw(body: string, contentType = "", encoding = ""): ReturnType<typeof decodeBody> {
  const buf = Buffer.from(body, "utf8");
  return decodeBody(buf, buf.length, false, contentType, encoding, rt);
}

describe("decodeBody — compression", () => {
  test("gzip-encoded JSON decodes to parsed JSON", () => {
    const raw = JSON.stringify({ hello: "world" });
    const gz = zlib.gzipSync(Buffer.from(raw));
    const out = decodeBody(gz, gz.length, false, "application/json", "gzip", rt);
    expect(out).toMatchObject({ contentType: "application/json", json: { hello: "world" } });
  });

  test("br-encoded JSON decodes", () => {
    const raw = JSON.stringify([1, 2, 3]);
    const br = zlib.brotliCompressSync(Buffer.from(raw));
    const out = decodeBody(br, br.length, false, "application/json", "br", rt);
    expect(out).toMatchObject({ json: [1, 2, 3] });
  });

  test("deflate-encoded JSON decodes", () => {
    const raw = JSON.stringify({ ok: true });
    const def = zlib.deflateSync(Buffer.from(raw));
    const out = decodeBody(def, def.length, false, "application/json", "deflate", rt);
    expect(out).toMatchObject({ json: { ok: true } });
  });

  test("corrupt gzip stream falls back to the raw buffer without throwing", () => {
    const garbage = Buffer.from("not actually gzipped at all");
    const out = decodeBody(garbage, garbage.length, false, "text/plain", "gzip", rt);
    expect(out).toBeDefined();
    expect(out?.text).toContain("not actually gzipped");
  });

  test("compressed body with truncated=true is not decoded (bytes are incomplete)", () => {
    const raw = JSON.stringify({ huge: "x".repeat(1000) });
    const gz = zlib.gzipSync(Buffer.from(raw));
    const out = decodeBody(gz, gz.length, true, "application/json", "gzip", rt);
    expect(out?.truncated).toBe(true);
    // Raw gzip bytes stayed as-is (binary preview, not parsed JSON).
    expect(out?.json).toBeUndefined();
  });
});

describe("decodeBody — empty + size paths", () => {
  test("size === 0 returns undefined", () => {
    const out = decodeBody(Buffer.alloc(0), 0, false, "application/json", "", rt);
    expect(out).toBeUndefined();
  });

  test("size propagates onto the capture", () => {
    const body = "hello world";
    const out = captureRaw(body, "text/plain");
    expect(out?.size).toBe(body.length);
  });
});

describe("toCapture — content-type routing", () => {
  test("application/json parses JSON", () => {
    const out = toCapture(Buffer.from('{"a":1}'), 7, false, "application/json", rt);
    expect(out.json).toEqual({ a: 1 });
    expect(out.text).toBeUndefined();
  });

  test("no content-type, body looks like JSON, parsed via heuristic", () => {
    const out = toCapture(Buffer.from("[1,2,3]"), 7, false, "", rt);
    expect(out.json).toEqual([1, 2, 3]);
  });

  test("text/plain stays as text", () => {
    const out = toCapture(Buffer.from("hello"), 5, false, "text/plain", rt);
    expect(out.text).toBe("hello");
    expect(out.json).toBeUndefined();
  });

  test("text/html stays as text", () => {
    const out = toCapture(Buffer.from("<p>hi</p>"), 9, false, "text/html", rt);
    expect(out.text).toBe("<p>hi</p>");
  });

  test.each([["image/png"], ["application/octet-stream"], ["audio/mpeg"], ["video/mp4"], ["application/pdf"]])(
    "binary content-type (%s) → binary: true, no text/json",
    (ct) => {
      const out = toCapture(Buffer.from([0, 1, 2, 3]), 4, false, ct, rt);
      expect(out.binary).toBe(true);
      expect(out.json).toBeUndefined();
      expect(out.text).toBeUndefined();
    },
  );

  test("x-www-form-urlencoded is textual (kept as text)", () => {
    const out = toCapture(Buffer.from("a=1&b=2"), 7, false, "application/x-www-form-urlencoded", rt);
    expect(out.text).toBe("a=1&b=2");
  });

  test("text/event-stream is textual", () => {
    const out = toCapture(Buffer.from("event: ping\ndata: {}\n"), 20, false, "text/event-stream", rt);
    expect(out.text).toContain("event: ping");
  });

  test("empty contentType string becomes undefined on the capture", () => {
    const out = toCapture(Buffer.from("hello"), 5, false, "", rt);
    expect(out.contentType).toBeUndefined();
  });

  test("truncated flag propagates and only shows up when true", () => {
    const yes = toCapture(Buffer.from("x"), 1, true, "text/plain", rt);
    expect(yes.truncated).toBe(true);
    const no = toCapture(Buffer.from("x"), 1, false, "text/plain", rt);
    expect(no.truncated).toBeUndefined();
  });

  test("very long text is truncated at 20_000 chars with an ellipsis", () => {
    const long = "x".repeat(21_000);
    const out = toCapture(Buffer.from(long), long.length, false, "text/plain", rt);
    expect(out.text?.length).toBe(20_001); // 20000 + ellipsis char
    expect(out.text?.endsWith("…")).toBe(true);
  });

  test("invalid JSON with application/json falls through to text", () => {
    const bad = "{not json";
    const out = toCapture(Buffer.from(bad), bad.length, false, "application/json", rt);
    expect(out.json).toBeUndefined();
    expect(out.text).toBe(bad);
  });

  test("JSON with secrets is run through the redactor", () => {
    const secretRt = { redactor: makeRedactor(["password"]), root: process.cwd() } as unknown as Runtime;
    const body = JSON.stringify({ user: "amina", password: "hunter22-super-secret" });
    const out = toCapture(Buffer.from(body), body.length, false, "application/json", secretRt);
    expect((out.json as any).password).toContain("[redacted]");
    expect((out.json as any).user).toBe("amina");
  });
});
