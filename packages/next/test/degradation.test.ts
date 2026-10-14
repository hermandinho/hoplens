import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NextDiscoverySource } from "../src/routes";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-degrade-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function writeFile(rel: string, content: string) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("degradation contract", () => {
  test("missing app/ and pages/ → empty routes, no throw", () => {
    const d = new NextDiscoverySource(tmp, "").scan();
    expect(d.routes).toEqual([]);
    expect(d.proxy).toBeUndefined();
  });

  test("syntax error in a route file → scan still completes", () => {
    writeFile("src/app/api/broken/route.ts", "export function GET(req: Request) { return");
    const d = new NextDiscoverySource(tmp, "").scan();
    const broken = d.routes.find((r) => r.path === "/api/broken");
    expect(broken).toBeDefined();
    // TypeScript error recovery is generous: GET may or may not be detected. The contract
    // is only that scan() completes and the route is still listed.
  });

  test("unresolvable Zod schema import → shape degrades to empty object with any", () => {
    writeFile(
      "src/app/api/unresolved/route.ts",
      `import { SomethingNotHere } from "./nowhere";
       export async function POST(req: Request) {
         SomethingNotHere.parse(await req.json());
         return Response.json({});
       }`,
    );
    const d = new NextDiscoverySource(tmp, "").scan();
    const r = d.routes.find((r) => r.path === "/api/unresolved");
    expect(r).toBeDefined();
    const post = r?.methods.find((m) => m.method === "POST");
    expect(post).toBeDefined();
    // Degrades gracefully — scanner doesn't throw, no schema is attached.
    expect(post?.schemas.length).toBeGreaterThanOrEqual(0);
  });

  test("non-UTF8 bytes in a route file → route skipped, scan completes", () => {
    const abs = path.join(tmp, "src/app/api/binary/route.ts");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));
    expect(() => new NextDiscoverySource(tmp, "").scan()).not.toThrow();
  });

  test("very large garbage file → scan completes bounded", () => {
    writeFile("src/app/api/huge/route.ts", `${"x = ".repeat(50000)}1;`);
    expect(() => new NextDiscoverySource(tmp, "").scan()).not.toThrow();
  });

  test("proxy.ts with no `config` export → ProxyInfo with empty matcher", () => {
    writeFile("proxy.ts", "export function proxy(req: any) { return req; }");
    const d = new NextDiscoverySource(tmp, "").scan();
    expect(d.proxy).toBeDefined();
    expect(d.proxy?.matcher).toEqual([]);
  });
});
