import { describe, expect, test } from "vitest";
import { makeRedactor, preview } from "../src/serialize";

describe("serialize", () => {
  test("redacts secrets and bounds previews", () => {
    const r = makeRedactor(["password", "authorization"]);
    const out: any = preview(
      { user: { password: "hunter22222", name: "A" }, list: Array.from({ length: 40 }, (_, i) => i) },
      r,
    );
    expect(out.user.password).toBe("hunt… [redacted]");
    expect(out.user.name).toBe("A");
    expect(out.list.length).toBe(26);
  });

  test("truncates long strings", () => {
    const r = makeRedactor([]);
    const long = "x".repeat(500);
    const out = preview(long, r) as string;
    expect(out.length).toBeLessThan(long.length);
    expect(out).toMatch(/…/);
  });
});
