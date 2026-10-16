import { describe, expect, test, vi } from "vitest";
import type { FindingSeverity, TraceSummary } from "../src/api/types";
import {
  type PaletteActs,
  type PaletteItem,
  buildItems,
  editsOf,
  flatRows,
  pushRecent,
  rankItems,
  scoreItem,
  scoreToken,
} from "../src/state/palette";
import type { FindingGroup, RouteStats } from "../src/state/stats";

/* WP1b palette: matching, ranking, and the acceptance "Ctrl+K finds a route, a request and a
 * finding within 3 keystrokes". Run: pnpm --filter @hoplens/ui exec vitest run test/palette.test.ts */

const trace = (id: string, method: string, url: string, extra: Partial<TraceSummary> = {}): TraceSummary => ({
  id,
  startedAt: 1_700_000_000_000 + Number(id.replace(/\D/g, "") || 0) * 1000,
  duration: 120,
  done: true,
  method,
  path: url.split("?")[0] as string,
  url,
  kind: "page" as TraceSummary["kind"],
  status: 200,
  hops: 3,
  ...extra,
});

const route = (method: string, path: string, hits: number): RouteStats => ({
  key: `${method} ${path}`,
  method,
  route: path,
  hits,
  errors: 0,
  errPct: 0,
  latency: { n: hits, p50: 100, p95: 200 } as RouteStats["latency"],
  coldHits: 0,
  findings: 0,
  lastAt: 0,
  lastTraceId: "t1",
});

const finding = (
  fingerprint: string,
  title: string,
  routes: string[],
  extra: Partial<FindingGroup> = {},
): FindingGroup => ({
  fingerprint,
  rule: "n-plus-1",
  severity: "warn" as FindingSeverity,
  title,
  requests: 3,
  impactMs: (extra.savedMsPerRequest ?? 0) * (extra.requests ?? 3),
  seenOnce: (extra.requests ?? 3) === 1,
  routes,
  latestTraceId: `latest-${fingerprint}`,
  latestAt: 0,
  firstAt: 0,
  isNew: false,
  ...extra,
});

function acts(): PaletteActs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openTrace: (id) => calls.push(`trace ${id}`),
    openRoute: (key) => calls.push(`route ${key}`),
    filterRequests: (q) => calls.push(`filter ${q}`),
    openShape: (fp) => calls.push(`shape ${fp}`),
    openEdit: (e) => calls.push(`edit ${e}`),
    scopeSince: (e) => calls.push(`since ${e}`),
  };
}

/** The audit app's traffic, roughly: the target plus distractors sharing letters with it. */
function auditItems(a = acts()): PaletteItem[] {
  return buildItems(
    {
      findings: [
        finding("fp-flaky", "fetchFlaky() swallowed an error", ["GET /api/flaky"], {
          rule: "swallowed-error",
          severity: "error",
          worstSavedMs: 0,
        }),
        finding("fp-feed", "getUser() called 10x in a loop", ["GET /api/feed"], {
          worstSavedMs: 173,
          savedMsPerRequest: 173,
          fn: "getUser",
        }),
        finding("fp-db", "pg.query x12 in a loop", ["GET /api/db/products"], {
          worstSavedMs: 130,
          savedMsPerRequest: 130,
        }),
      ],
      routes: [
        route("GET", "/api/flaky", 6),
        route("GET", "/api/db/products", 12),
        route("GET", "/api/feed", 9),
        route("POST", "/api/cart", 2),
        route("GET", "/api/catalog", 1),
      ],
      traces: [
        trace("t9", "GET", "/api/db/products"),
        trace("t8", "GET", "/api/flaky?mode=throw", { status: 500 }),
        trace("t7", "GET", "/api/feed?fast=0"),
        trace("t6", "POST", "/api/cart"),
        trace("t5", "GET", "/_next/static/chunk.js", { kind: "asset" as TraceSummary["kind"] }),
      ],
      shapes: [],
      edits: [],
    },
    a,
  );
}

describe("palette matching", () => {
  test("a word-start prefix beats a substring, which beats a subsequence", () => {
    const prefix = scoreToken("fee", "GET /api/feed");
    const sub = scoreToken("eed", "GET /api/feed");
    const subseq = scoreToken("fd", "GET /api/feed");
    expect(prefix).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
    expect(scoreToken("zz", "GET /api/feed")).toBe(0);
  });

  test("camelCase humps count as word starts", () => {
    expect(scoreToken("user", "getUser()")).toBeGreaterThan(scoreToken("ser", "getUser()"));
  });

  test("every token has to match somewhere", () => {
    const item = { title: "GET /api/feed", detail: "9 reqs" };
    expect(scoreItem(item, "feed get")).toBeGreaterThan(0);
    expect(scoreItem(item, "feed post")).toBe(0);
  });
});

describe("palette acceptance: route, request and finding within 3 keystrokes", () => {
  test('"fee" puts /api/feed first among routes, requests and findings', () => {
    const sections = rankItems(auditItems(), "fee");
    const first = (g: string) => sections.find((s) => s.group === g)?.items[0]?.id;
    expect(first("routes")).toBe("route:GET /api/feed");
    expect(first("requests")).toBe("req:t7");
    // The finding's title doesn't say "feed": its route does (keywords).
    expect(first("findings")).toBe("finding:fp-feed");
  });

  test("assets are not listed as requests", () => {
    const ids = auditItems().map((i) => i.id);
    expect(ids).not.toContain("req:t5");
  });

  test("findings are ordered by impact (saveable ms x requests), not severity", () => {
    const sections = rankItems(auditItems(), "");
    const findings = sections.find((s) => s.group === "findings")?.items.map((i) => i.id);
    expect(findings?.[0]).toBe("finding:fp-feed");
  });

  test("findings follow the Overview ranking: a seen-once cold compile sinks below a repeatable N+1", () => {
    const items = buildItems(
      {
        findings: [
          finding("cc", "Cold request: 2000ms", ["GET /api/x"], {
            rule: "cold-compile",
            requests: 1,
            worstSavedMs: 2000,
            savedMsPerRequest: 2000,
          }),
          finding("np", "getUser() called 10x in a loop", ["GET /api/feed"], {
            requests: 10,
            maxCount: 10,
            fn: "getUser",
            worstSavedMs: 40,
            savedMsPerRequest: 30,
          }),
        ],
        routes: [],
        traces: [],
        shapes: [],
        edits: [],
      },
      acts(),
    );
    const f = items.filter((i) => i.group === "findings");
    expect(f.map((i) => i.id)).toEqual(["finding:np", "finding:cc"]);
    // The Overview's sentence and per-request figure, not the raw title and the worst case.
    expect(f[0]?.title).toBe("getUser() ran 10 queries in a loop (N+1)");
    expect(f[0]?.detail).toContain("~30ms/req × 10 = 300ms");
    expect(f[1]?.detail).toContain("in 1 request (seen once)");
  });
});

describe("palette actions", () => {
  test("Enter opens, Ctrl+Enter runs the secondary action", () => {
    const a = acts();
    const items = auditItems(a);
    const feedFinding = items.find((i) => i.id === "finding:fp-feed") as PaletteItem;
    feedFinding.primary.run();
    feedFinding.secondary?.run();
    const feedRoute = items.find((i) => i.id === "route:GET /api/feed") as PaletteItem;
    feedRoute.primary.run();
    feedRoute.secondary?.run();
    expect(a.calls).toEqual([
      "trace latest-fp-feed",
      "filter has:n-plus-1 method:GET route:/api/feed",
      "route GET /api/feed",
      "filter method:GET route:/api/feed",
    ]);
  });

  test("a server search hit is listed even when only its logs or body matched", () => {
    const items = buildItems(
      {
        findings: [],
        routes: [],
        traces: [trace("t1", "GET", "/api/feed"), trace("t2", "GET", "/api/cart")],
        shapes: [],
        edits: [],
        search: { q: "ECONNRESET", ids: new Set(["t2"]) },
      },
      acts(),
    );
    const rows = flatRows(rankItems(items, "ECONNRESET"));
    expect(rows.map((r) => r.id)).toEqual(["req:t2"]);
    expect(rows[0]?.detail).toContain("matched in logs/body");
  });

  test("a server hit its own url already explains is not labelled as a logs/body match", () => {
    const items = buildItems(
      {
        findings: [],
        routes: [],
        traces: [trace("t1", "GET", "/api/dashboard")],
        shapes: [],
        edits: [],
        search: { q: "das", ids: new Set(["t1"]) },
      },
      acts(),
    );
    expect(items[0]?.detail).not.toContain("matched in logs/body");
  });

  test("edits come newest first and open Changes or scope the lists", () => {
    const a = acts();
    const traces = [
      trace("t1", "GET", "/a", { facts: { epoch: 3 } as TraceSummary["facts"] }),
      trace("t2", "GET", "/a", { facts: { epoch: 7 } as TraceSummary["facts"] }),
      trace("t3", "GET", "/a", { facts: { epoch: 7 } as TraceSummary["facts"] }),
    ];
    const edits = editsOf(traces);
    expect(edits.map((e) => [e.epoch, e.n])).toEqual([
      [7, 2],
      [3, 1],
    ]);
    const items = buildItems({ findings: [], routes: [], traces: [], shapes: [], edits }, a);
    const e7 = items.find((i) => i.id === "edit:7") as PaletteItem;
    e7.primary.run();
    e7.secondary?.run();
    expect(a.calls).toEqual(["edit 7", "since 7"]);
  });
});

describe("palette recents", () => {
  test("recent picks show first before typing, and not again in their group", () => {
    const items = auditItems();
    const sections = rankItems(items, "", { recents: ["route:POST /api/cart", "gone:id"] });
    expect(sections[0]?.group).toBe("recent");
    expect(sections[0]?.items.map((i) => i.id)).toEqual(["route:POST /api/cart"]);
    const routes = sections.find((s) => s.group === "routes")?.items.map((i) => i.id) ?? [];
    expect(routes).not.toContain("route:POST /api/cart");
  });

  test("recents are hidden while typing", () => {
    const sections = rankItems(auditItems(), "cart", { recents: ["route:POST /api/cart"] });
    expect(sections.some((s) => s.group === "recent")).toBe(false);
  });

  test("pushRecent dedupes and caps", () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = pushRecent(list, `id${i}`);
    list = pushRecent(list, "id5");
    expect(list[0]).toBe("id5");
    expect(list.length).toBe(8);
    expect(new Set(list).size).toBe(8);
  });
});

describe("palette group order", () => {
  test("while typing, the group with the best match comes first", () => {
    const run = vi.fn();
    const items: PaletteItem[] = [
      { id: "f", group: "findings", title: "slow function in render", primary: { label: "", run } },
      { id: "v", group: "views", title: "Requests", primary: { label: "", run } },
    ];
    expect(rankItems(items, "req")[0]?.group).toBe("views");
  });
});
