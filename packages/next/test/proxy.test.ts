import path from "node:path";
import { describe, expect, test } from "vitest";
import { NextDiscoverySource } from "../src/routes";

describe("proxy / middleware detection", () => {
  test("proxy.ts with matcher as a bare string", () => {
    const d = new NextDiscoverySource(path.join(__dirname, "fixture-proxy-string"), "").scan();
    expect(d.proxy).toBeDefined();
    expect(d.proxy!.file).toBe("proxy.ts");
    expect(d.proxy!.matcher).toEqual(["/api/:path*"]);
  });

  test("proxy.ts with matcher as a string array", () => {
    const d = new NextDiscoverySource(path.join(__dirname, "fixture-proxy-array"), "").scan();
    expect(d.proxy!.matcher).toEqual(["/api/:path*", "/admin/:path*"]);
  });

  test("proxy.ts with matcher as an array of {source: ...} objects", () => {
    const d = new NextDiscoverySource(path.join(__dirname, "fixture-proxy-objects"), "").scan();
    expect(d.proxy!.matcher).toEqual(["/api/:path*", "/dashboard/:path*"]);
  });

  test("middleware.ts (Next 15) is detected the same way", () => {
    const d = new NextDiscoverySource(path.join(__dirname, "fixture-middleware"), "").scan();
    expect(d.proxy).toBeDefined();
    expect(d.proxy!.file).toBe("middleware.ts");
    expect(d.proxy!.matcher).toEqual(["/legacy/:path*"]);
  });
});
