import path from "node:path";
import { describe, expect, test } from "vitest";
import { NextDiscoverySource } from "../src/routes";

const root = path.join(__dirname, "fixture");

describe("NextDiscoverySource", () => {
  test("discovers app and pages routes with params and methods", () => {
    const d = new NextDiscoverySource(root, "").scan();
    const paths = d.routes.map((r) => r.path);
    expect(paths).toEqual(["/api/ping", "/api/reports", "/api/users/:id"]);

    const users = d.routes.find((r) => r.path === "/api/users/:id")!;
    expect(users.methods.map((m) => m.method)).toEqual(["GET", "PUT", "DELETE"]);
    expect(users.nextRoute).toBe("/api/users/[id]");

    const ping = d.routes.find((r) => r.path === "/api/ping")!;
    expect(ping.methods[0]!.method).toBe("ANY");
  });

  test("reads Zod schemas across files, re-exports, extend and namespace imports", () => {
    const users = new NextDiscoverySource(root, "").scan().routes.find((r) => r.path === "/api/users/:id")!;
    const put = users.methods.find((m) => m.method === "PUT")!;
    const body = put.schemas.find((s) => s.target === "body")!;
    expect(body.name).toBe("CreateUser");
    expect(body.file).toBe("src/lib/schemas.ts");
    expect(body.example).toEqual({
      email: "amina@example.com",
      age: 30,
      role: "member",
      address: { city: "Montreal", country: "CA" },
      tags: ["featured"],
      agreed: true,
    });

    const get = users.methods.find((m) => m.method === "GET")!;
    expect(get.schemas[0]!.target).toBe("query");
    expect(get.readsBody).toBe(false);

    const del = users.methods.find((m) => m.method === "DELETE")!;
    expect(del.schemas[0]!.name).toBe("S.Base");
    expect(del.readsBody).toBe(true);
  });
});
