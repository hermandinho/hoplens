import { describe, expect, test } from "vitest";
import config from "../vite.config";

/*
 * The Vite dev proxy rewrites Host to the runtime's loopback port (changeOrigin), so core's DNS
 * rebinding guard only sees the browser's real Host through x-forwarded-host. The proxy must set it
 * from the incoming Host and overwrite any value the client sent (a rebound page can send its own).
 * Run: pnpm --filter @hoplens/ui exec vitest run test/dev-proxy.test.ts
 */

type Listener = (proxyReq: { setHeader(n: string, v: string): void }, req: { headers: Record<string, string> }) => void;

function forwardedHostFor(headers: Record<string, string>): string | undefined {
  const entry = (config as { server?: { proxy?: Record<string, unknown> } }).server?.proxy?.["/__hoplens/api"] as {
    configure?: (proxy: { on(ev: string, fn: Listener): void }, opts: unknown) => void;
  };
  const listeners: Listener[] = [];
  entry.configure?.({ on: (ev, fn) => ev === "proxyReq" && listeners.push(fn) }, entry);
  const set: Record<string, string> = {};
  for (const fn of listeners) fn({ setHeader: (n, v) => (set[n.toLowerCase()] = v) }, { headers });
  return set["x-forwarded-host"];
}

describe("vite dev proxy", () => {
  test("forwards the browser's Host so core can check it", () => {
    expect(forwardedHostFor({ host: "evil.example:5173" })).toBe("evil.example:5173");
    expect(forwardedHostFor({ host: "localhost:5173" })).toBe("localhost:5173");
  });

  test("overwrites a client-sent x-forwarded-host", () => {
    expect(forwardedHostFor({ host: "evil.example:5173", "x-forwarded-host": "localhost:5173" })).toBe(
      "evil.example:5173",
    );
  });
});
