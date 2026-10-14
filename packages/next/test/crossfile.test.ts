import path from "node:path";
import { describe, expect, test } from "vitest";
import { NextDiscoverySource } from "../src/routes";

const root = path.join(__dirname, "fixture-crossfile");

describe("cross-file schema resolution", () => {
  const d = new NextDiscoverySource(root, "").scan();
  const find = (p: string) => d.routes.find((r) => r.path === p)!;

  test("aliased re-export through a barrel", () => {
    const r = find("/api/aliased/:id");
    const post = r.methods.find((m) => m.method === "POST")!;
    const body = post.schemas.find((s) => s.target === "body")!;
    expect(body.name).toBe("RenamedBase");
    // Resolution bottoms out at Base defined in a/schemas.ts.
    expect(body.file).toBe("src/lib/a/schemas.ts");
    expect((body.shape as any).t).toBe("object");
    expect(Object.keys((body.shape as any).props)).toContain("email");
    expect(Object.keys((body.shape as any).props)).toContain("age");
  });

  test("default export", () => {
    const r = find("/api/default-export/:id");
    const post = r.methods.find((m) => m.method === "POST")!;
    const body = post.schemas.find((s) => s.target === "body")!;
    expect(body.name).toBe("DefaultSchema");
    expect(body.file).toBe("src/lib/d/schemas.ts");
    expect(Object.keys((body.shape as any).props).sort()).toEqual(["qty", "tag"]);
  });

  test("local alias of a chained aliased re-export (import { RenamedBase as X })", () => {
    const r = find("/api/deep-chain/:id");
    const put = r.methods.find((m) => m.method === "PUT")!;
    const body = put.schemas.find((s) => s.target === "body")!;
    // Local name `X` was aliased at import, but the resolver follows through to the original schema.
    expect(body.file).toBe("src/lib/a/schemas.ts");
    expect((body.shape as any).t).toBe("object");
  });
});
