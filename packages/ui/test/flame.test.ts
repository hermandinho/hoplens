import assert from "node:assert/strict";
import { test } from "vitest";
import type { SpanRecord } from "../src/api/types";
import * as F from "../src/state/flame";
import * as T from "../src/state/traceview";

// WP3 canvas model: time scale with the folded cold wait, cold detection, handler zoom, fold
// stripes (dominant bucket), span search and viewport arithmetic.

type S = SpanRecord;
const sp = (
  id: string,
  kind: string,
  start: number,
  end: number,
  parentId?: string,
  name = id,
  attrs: Record<string, string> = {},
): S => ({ id, parentId, name, kind: kind as S["kind"], start, end, attrs });

test("canvas model", () => {
  // ---- makeScale
  const lin = F.makeScale(100, 300);
  assert.equal(lin.x(100), 0);
  assert.equal(lin.x(300), 1);
  assert.equal(lin.x(200), 0.5);
  assert.equal(lin.invert(0.5), 200);
  const fs = F.makeScale(0, 3000, [10, 2050], 0.12);
  assert.ok(fs.fold);
  assert.equal(fs.x(0), 0);
  assert.ok(Math.abs(fs.x(3000) - 1) < 1e-9);
  assert.ok(Math.abs(fs.x(2050) - fs.x(10) - 0.12) < 1e-9, "fold takes its share");
  for (const t of [0, 5, 10, 500, 2050, 2600, 3000]) assert.ok(Math.abs(fs.invert(fs.x(t)) - t) < 1e-6, `invert ${t}`);
  // fold outside viewport is ignored
  assert.equal(F.makeScale(2000, 3000, [10, 2050]).fold, undefined);

  // ---- cold trace: 3.01s, request root, untraced idle until 2040, handler 2040..2370, render after
  const cold: S[] = [
    sp("req", "request", 0, 3010),
    sp("cmp", "compile", 2, 8, "req"),
    sp("h", "handler", 2040, 2370, "req"),
    sp("f1", "fetch", 2050, 2300, "h", "fetch GET x", { "url.full": "https://jsonplaceholder.typicode.com/users/1" }),
    sp("resp", "response", 2370, 3010, "req"),
  ];
  const gaps = F.idleGaps(cold);
  const cw = F.coldWait(cold, gaps, 3010);
  assert.ok(cw, "cold detected");
  if (!cw) return;
  assert.equal(cw.handlerStart, 2040);
  assert.deepEqual(cw.gap, [8, 2040]);
  const hr = F.handlerRange(cold, 3010);
  assert.ok(hr && hr[0] < 2040 && hr[0] > 2000 && hr[1] === 3010, `handler range ${hr}`);
  // warm trace: no cold
  const warm: S[] = [sp("req", "request", 0, 340), sp("h", "handler", 3, 330, "req")];
  assert.equal(F.coldWait(warm, F.idleGaps(warm), 340), null);

  // ---- fold summary: x12 getProductRating, each with one pg.query child -> db
  const fold: S[] = [sp("h", "handler", 0, 200)];
  for (let i = 0; i < 12; i++) {
    fold.push(sp(`g${i}`, "function", 10 + i * 15, 24 + i * 15, "h", "getProductRating"));
    fold.push(
      sp(`q${i}`, "db", 11 + i * 15, 23 + i * 15, `g${i}`, "pg.query", {
        "db.statement": `SELECT * FROM ratings WHERE id = ${i}`,
      }),
    );
  }
  const tree = T.buildSpanTree(fold);
  assert.equal(tree.groups.size, 1);
  const g = [...tree.groups.values()][0] as T.SpanGroup;
  assert.equal(g.members.length, 12);
  const sum = F.foldSummary(tree, g, T.selfTimes(fold));
  assert.equal(sum.bucket, "db");
  assert.equal(sum.top, "pg.query");
  assert.ok(Math.abs(sum.ms - 144) < 1e-6, `ms ${sum.ms}`);

  // ---- search
  assert.deepEqual(F.searchSpans(cold, "jsonplaceholder"), ["f1"]);
  assert.deepEqual(F.searchSpans(cold, "FETCH x"), ["f1"]);
  assert.deepEqual(F.searchSpans(cold, ""), []);
  assert.equal(F.searchSpans(fold, "getproductrating").length, 12);
  assert.equal(F.searchSpans(fold, "ratings").length, 12);

  // ---- ranges
  assert.deepEqual(F.clampRange([-5, 50], 100), [0, 50]);
  assert.deepEqual(F.clampRange([10, 10], 100), [9.75, 10.25]);
  assert.deepEqual(F.panRange([0, 40], 0.25, 100), [10, 50]);
  assert.deepEqual(F.panRange([80, 100], 0.25, 100), [80, 100]);
  assert.deepEqual(F.panRange([10, 50], -1, 100), [0, 40]);
  assert.deepEqual(F.zoomRange([0, 100], 0.5, 50, 100), [25, 75]);
  assert.deepEqual(F.revealRange([0, 40], 10, 20, 100), [0, 40]);
  const rv = F.revealRange([0, 40], 70, 75, 100);
  assert.ok(rv[0] <= 70 && rv[1] >= 75 && rv[1] - rv[0] === 40, `reveal ${rv}`);
  const sr = F.spanRange(T.buildSpanTree(cold), "h", 3010);
  assert.ok(sr && sr[0] < 2040 && sr[1] > 2370, `span range ${sr}`);
});
