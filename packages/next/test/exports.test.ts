import path from "node:path";
import { describe, expect, test } from "vitest";
import { NextDiscoverySource } from "../src/routes";

const root = path.join(__dirname, "fixture-exports");

describe("export-shape detection", () => {
  const d = new NextDiscoverySource(root, "").scan();
  const by = (p: string) => d.routes.find((r) => r.path === p)!;

  test("named function exports", () => {
    const r = by("/api/named-fn");
    expect(r.methods.map((m) => m.method).sort()).toEqual(["GET", "POST"]);
  });

  test("const + arrow exports", () => {
    const r = by("/api/named-const");
    expect(r.methods.map((m) => m.method).sort()).toEqual(["GET", "PUT"]);
  });

  test("aliased export: `export { fn as DELETE }`", () => {
    const r = by("/api/aliased");
    expect(r.methods.map((m) => m.method)).toEqual(["DELETE"]);
  });

  test("re-exported method: `export { h as GET } from './handlers'`", () => {
    const r = by("/api/re-export-named");
    expect(r.methods.map((m) => m.method)).toEqual(["GET"]);
  });

  test("multiple re-exported methods from one sibling", () => {
    const r = by("/api/re-export-multi");
    expect(r.methods.map((m) => m.method).sort()).toEqual(["GET", "POST"]);
  });

  test("readsBody heuristic recognises `await req.json()`", () => {
    const r = by("/api/named-fn");
    const post = r.methods.find((m) => m.method === "POST")!;
    expect(post.readsBody).toBe(true);
    const get = r.methods.find((m) => m.method === "GET")!;
    expect(get.readsBody).toBe(false);
  });
});
