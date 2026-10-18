import { describe, expect, test } from "vitest";
import type { Meta, SpanRecord, TraceFacts, TraceRecord } from "../src/api/types";
import {
  NEXT_COPY,
  findingTitle,
  frameworkCopyOf,
  frameworkId,
  frameworkLabel,
  frameworkPill,
  isNextApp,
  ruleLabel,
} from "../src/state/framework";
import { buildItems } from "../src/state/palette";
import { suggest } from "../src/state/querySuggest";
import type { FindingGroup } from "../src/state/stats";
import { findingSentence, verdictFor } from "../src/state/verdict";
import { toVitest } from "../src/state/vitest";

/*
 * Framework-dependent copy: Next.js keeps every sentence it had, Express (and any other framework)
 * gets wording without next dev, dev compiles or Next's data cache.
 * Run: pnpm --filter @hoplens/ui exec vitest run test/framework.test.ts
 */

const meta = (over: Partial<Meta>): Meta =>
  ({ root: "/", basePath: "", otel: "own", configured: true, autoTrace: true, profiles: {}, ...over }) as Meta;

describe("frameworkLabel / frameworkPill", () => {
  test("Express from meta.framework, with its version", () => {
    const m = meta({ framework: { name: "express", version: "5.3.0" } });
    expect(frameworkId(m)).toBe("express");
    expect(isNextApp(m)).toBe(false);
    expect(frameworkLabel(m)).toBe("Express");
    expect(frameworkPill(m)).toBe("Express 5.3.0");
  });

  test("Next from meta.framework, else the older meta.next field", () => {
    expect(frameworkPill(meta({ framework: { name: "next", version: "16.0.1" }, next: "16.0.1" }))).toBe("Next 16.0.1");
    // A core from before meta.framework: only `next`.
    const old = meta({ next: "15.5.0" });
    expect(isNextApp(old)).toBe(true);
    expect(frameworkLabel(old)).toBe("Next.js");
    expect(frameworkPill(old)).toBe("Next 15.5.0");
    // Next reported with no version anywhere: no pill, as before.
    expect(frameworkPill(meta({ framework: { name: "next" } }))).toBeNull();
  });

  test("unknown meta reads as Next; another framework is capitalised; no version shows the name", () => {
    expect(frameworkLabel(null)).toBe("Next.js");
    expect(frameworkPill(null)).toBeNull();
    expect(frameworkLabel(meta({ framework: { name: "koa" } }))).toBe("Koa");
    expect(frameworkPill(meta({ framework: { name: "express" } }))).toBe("Express");
  });
});

describe("copy switching", () => {
  const express = frameworkCopyOf(meta({ framework: { name: "express", version: "5.3.0" } }));

  test("Next keeps its copy word for word", () => {
    const next = frameworkCopyOf(meta({ framework: { name: "next", version: "16.0.1" } }));
    expect(next).toBe(NEXT_COPY);
    expect(next.band).toBe("Next.js");
    expect(next.bandChip).toBe("NEXT");
    expect(next.frameworkHint).toBe("Next.js internals: routing, rendering, response");
    expect(next.coldGap).toBe("Next loading instrumentation / compiling (untraced)");
    expect(next.coldTag).toBe("likely dev compile");
    expect(ruleLabel("cold-compile", next)).toBe("cold compile");
    expect(ruleLabel("n-plus-1", next)).toBe("N+1");
    expect(ruleLabel("cold-compile")).toBe("cold compile");
  });

  test("Express says nothing about Next, next dev or dev compiles", () => {
    expect(express.isNext).toBe(false);
    expect(express.band).toBe("Express");
    expect(express.frameworkHint).toBe("Express internals: routing, response");
    expect(express.coldTag).toBe("first request after start/restart");
    expect(ruleLabel("cold-compile", express)).toBe("cold start");
    for (const v of Object.values(express)) {
      if (typeof v !== "string") continue;
      expect(v).not.toMatch(/Next|next dev|dev compile|compiling/);
    }
  });

  test("a core finding title loses 'since the last rebuild' outside Next", () => {
    const t = "Cold request: first hit on this route since the last rebuild";
    expect(findingTitle(t, NEXT_COPY)).toBe(t);
    expect(findingTitle(t, express)).toBe("Cold request: first hit on this route since the app started");
  });

  test("verdict and finding sentences follow the framework; Next's are unchanged", () => {
    const handler: SpanRecord = { id: "h", kind: "handler", name: "GET /x", start: 2000, end: 2300, attrs: {} };
    const facts = {
      time: { db: 0, cache: 0, ext: 0, fn: 0, framework: 0, compile: 0, idle: 0 },
      reqBytes: 0,
      resBytes: 0,
      counts: { spans: 1, db: 0, fetch: 0, cache: 0, fn: 0, warn: 0, error: 0 },
      cold: true,
      compileMs: 0,
      droppedSpans: 0,
      epoch: 0,
      preHandlerMs: 2000,
    } as TraceFacts;
    const t = {
      id: "t",
      startedAt: 0,
      duration: 2300,
      done: true,
      method: "GET",
      url: "/x",
      path: "/x",
      route: "/x",
      kind: "route",
      status: 200,
      request: { headers: {} },
      response: { headers: {} },
      spans: [handler],
      logs: [],
      facts,
    } as TraceRecord;
    expect(verdictFor(t).text).toMatch(/\(cold: likely dev compile\)/);
    expect(verdictFor(t, express).text).toMatch(/\(cold: first request after start\/restart\)/);

    const cold = {
      rule: "cold-compile" as const,
      title: "Cold request: first hit on this route since the last rebuild",
    };
    expect(findingSentence(cold)).toBe(
      "the dev compile ran first (cold request: first hit on this route since the last rebuild)",
    );
    expect(findingSentence(cold, undefined, undefined, express)).toBe(
      "it was the first request after start/restart (cold request: first hit on this route since the app started)",
    );
    const fetch = { rule: "fetch-uncached" as const, title: "fetch https://api.test/x not cached" };
    expect(findingSentence(fetch)).toBe("fetch https://api.test/x skips Next's data cache");
    expect(findingSentence(fetch, undefined, undefined, express)).toBe("fetch https://api.test/x skips a fetch cache");
  });

  test("the palette's finding rows use the framework's rule label", () => {
    const g = {
      fingerprint: "f",
      rule: "cold-compile",
      severity: "info",
      title: "Cold request: first hit on this route since the last rebuild",
      routes: ["GET /x"],
      requests: 1,
      maxCount: 1,
      seenOnce: true,
      impactMs: 0,
    } as unknown as FindingGroup;
    const acts = {} as Parameters<typeof buildItems>[1];
    const base = { findings: [g], routes: [], traces: [], shapes: [], edits: [] };
    const next = buildItems(base, acts).find((i) => i.id === "finding:f");
    const exp = buildItems({ ...base, fw: express }, acts).find((i) => i.id === "finding:f");
    expect(next?.detail).toMatch(/^cold compile/);
    expect(exp?.detail).toMatch(/^cold start/);
    expect(exp?.title).toMatch(/^it was the first request after start\/restart/);
  });
});

describe("copy outside the framework-neutral components", () => {
  const express = frameworkCopyOf(meta({ framework: { name: "express", version: "5.3.0" } }));
  const req = { method: "GET", url: "http://localhost:3100/orders", headers: {} } as never;
  const src = { id: "t1", method: "GET", path: "/orders", status: 200 } as never;

  test("the vitest export says what to run and what cold means for the framework", () => {
    const opts = { baseUrl: "http://localhost:3100", p95: { ms: 10, n: 5 } };
    const next = toVitest(req, src, opts);
    expect(next).toContain("Run it with `next dev` (and Hoplens) up.");
    expect(next).toContain("Cold (compiling) requests are skipped.");
    const exp = toVitest(req, src, { ...opts, copy: express });
    expect(exp).not.toMatch(/next dev|compiling/);
    expect(exp).toContain("Run it with the app (and Hoplens) running.");
    expect(exp).toContain("Cold requests (the first request after start/restart) are skipped.");
  });

  test("query-bar hints for has:cold-compile and cold:true follow the framework", () => {
    const hint = (q: string, fw?: typeof express) => suggest(q, q.length, [], fw).items.map((i) => i.hint);
    expect(hint("has:cold-c")).toEqual(["cold compile"]);
    expect(hint("has:cold-c", express)).toEqual(["cold start"]);
    expect(hint("cold:t")).toEqual(["first request after a rebuild"]);
    expect(hint("cold:t", express)).toEqual(["first request after start/restart"]);
  });

  test("epoch, edits and Changes-tab wording drop dev rebuilds outside Next", () => {
    expect(NEXT_COPY.epoch).toBe("dev-rebuild epoch");
    expect(NEXT_COPY.changesTitle).toMatch(/dev rebuilds/);
    for (const s of [express.epoch, express.edits, express.changesTitle]) expect(s).not.toMatch(/rebuild|compile/);
  });

  test("the Changes empty state: a save under node --watch outside Next, next dev on Next", () => {
    expect(express.changesEmpty).toMatch(
      /^No edits yet\. Save a file: node --watch restarts the app and the edit shows up here/,
    );
    expect(express.changesEmpty).not.toMatch(/rebuild|next dev/);
    expect(NEXT_COPY.changesEmpty).toMatch(/next dev/);
  });
});
