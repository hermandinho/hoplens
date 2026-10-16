import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EpochTracker } from "../src/epoch";
import {
  PERSIST_FILE,
  PERSIST_ROTATED,
  Persister,
  foldRows,
  parseRows,
  persistDir,
  redactQuery,
  rowToTrace,
  traceRow,
} from "../src/persist";
import { Runtime } from "../src/runtime";
import { makeRedactor } from "../src/serialize";
import { RouteStatsStore } from "../src/stats";
import type { TraceRecord } from "../src/types";
import { makeTrace, skeleton } from "./helpers";

const redactor = makeRedactor(["authorization", "token", "password"]);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoplens-persist-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function trace(over: Partial<TraceRecord> = {}, epoch = 0, ms = 50): TraceRecord {
  const { root, handler, fn } = skeleton(ms);
  return makeTrace([root, handler, fn], {
    id: `t${++seq}`,
    startedAt: 1_000_000 + seq,
    duration: ms,
    request: { headers: { authorization: "Bearer sekret" }, body: { text: "password=hunter2", size: 16 } },
    response: { headers: { "set-cookie": "sid=abc" }, body: { json: { secret: 1 }, size: 12 } },
    logs: [{ level: "info", message: "user hunter2 logged in", time: 0 } as any],
    facts: {
      time: { db: 4, cache: 0, ext: 0, fn: 10, framework: 1, compile: 0, idle: 0 },
      reqBytes: 10,
      resBytes: 20,
      counts: { spans: 3, db: 2, fetch: 1, cache: 0, fn: 1, warn: 0, error: 0 },
      cold: false,
      compileMs: 0,
      droppedSpans: 0,
      epoch,
    },
    findings: [
      {
        rule: "n-plus-1",
        severity: "warn",
        title: "listProducts ran SELECT x5 (N+1)",
        detail: "SELECT * FROM t WHERE token = 'hunter2'",
        fingerprint: "fp1",
        spanIds: ["s1"],
        fn: "listProducts",
        count: 5,
        estSavedMs: 12,
      },
    ],
    ...over,
  });
}

/** Snapshot minus the store's own creation time. */
function snap(s: RouteStatsStore) {
  const { since: _since, ...rest } = s.snapshot({ buckets: true });
  return rest;
}

describe("persist rows", () => {
  test("redactQuery masks redacted keys only and drops the fragment", () => {
    expect(redactQuery("/a?token=abc&page=2#x", redactor)).toBe("/a?token=[redacted]&page=2");
    expect(redactQuery("/a?access_token=abc", redactor)).toBe("/a?access_token=[redacted]");
    expect(redactQuery("/a", redactor)).toBe("/a");
  });

  test("a trace row carries no bodies, headers, logs, spans, error text or finding detail", () => {
    const t = trace({
      url: "/api/products?token=hunter2&q=1",
      error: { type: "Error", message: "hunter2 failed", stack: "at hunter2" },
    });
    const line = JSON.stringify(traceRow(t, redactor));
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("sekret");
    expect(line).not.toContain("sid=abc");
    expect(line).not.toMatch(/"(request|response|spans|logs|detail|headers)"/);
    expect(line).toContain("token=[redacted]");
  });

  test("finding titles that quote a log line or an error message are rebuilt without the text", () => {
    const t = trace({
      findings: [
        {
          rule: "logs-on-success",
          severity: "warn",
          title: "1 error + 2 warn logs on a 200: auth failed for key sk_live_SECRET123",
          fingerprint: "f",
          spanIds: [],
        },
        {
          rule: "swallowed-error",
          severity: "warn",
          title:
            "fetch GET https://api.x.dev/u?k=SECRET2 failed (TypeError: Bearer eyJSECRET rejected) but the response was 200 x3",
          fingerprint: "g",
          spanIds: [],
          fn: "getUser",
        },
      ],
    });
    const row = traceRow(t, redactor);
    const line = JSON.stringify(row);
    expect(line).not.toMatch(/SECRET/);
    expect(row.findings?.map((f) => f.title)).toEqual([
      "1 error + 2 warn logs on a 200",
      "getUser failed (TypeError) but the response was 200 x3",
    ]);
  });

  test("query values: short plain ones kept (variants stay apart), the rest masked", () => {
    const t = trace({ url: "/cb?code=4/0AbCdEf_secretcode&state=xyz123abc456&email=a@b.co&fast=0&mode=n1" });
    expect(traceRow(t, redactor).url).toBe("/cb?code=[redacted]&state=[redacted]&email=[redacted]&fast=0&mode=n1");
  });

  test("replaying rows gives the same stats snapshot", () => {
    const a = new RouteStatsStore();
    const b = new RouteStatsStore();
    const traces = [
      trace({}, 0, 40),
      trace({}, 0, 60),
      trace({ status: 500 }, 1, 80),
      trace({ path: "/api/orders/7", url: "/api/orders/7", route: undefined }, 1, 30),
      trace({ error: { type: "E", message: "x", stack: "" } }, 1, 20),
    ];
    for (const t of traces) a.add(t);
    const rows = parseRows(traces.map((t) => `${JSON.stringify(traceRow(t, redactor))}\n`).join(""));
    for (const r of foldRows(rows).traces) b.add(rowToTrace(r));
    expect(snap(b)).toEqual(snap(a));
  });

  test("parseRows skips a torn last line and unknown rows", () => {
    const rows = parseRows('{"k":"s","v":1,"s":1,"at":0}\n{"k":"zz"}\nnot json\n{"k":"t","id":"x","rou');
    expect(rows).toEqual([{ k: "s", v: 1, s: 1, at: 0 }]);
  });

  test("foldRows: next session and epoch continue after the newest seen", () => {
    const info = (id: number) => ({
      id,
      at: 0,
      rebuiltAt: 0,
      files: [],
      deleted: [],
      moreFiles: 0,
      via: "unknown" as const,
      candidates: [],
    });
    const st = foldRows([
      { k: "s", v: 1, s: 1, at: 0 },
      { k: "e", s: 1, info: info(0) },
      { k: "e", s: 1, info: info(2) },
      { k: "s", v: 1, s: 2, at: 0 },
      { k: "e", s: 2, info: info(3) },
      traceRow(trace({}, 4), redactor),
    ]);
    expect(st.session).toBe(2);
    expect(st.nextEpoch).toBe(5);
    expect(st.epochs.map((e) => [e.id, e.session])).toEqual([
      [0, 1],
      [2, 1],
      [3, 2],
    ]);
  });
});

describe("Persister", () => {
  test("push never touches the disk; flush does", () => {
    const p = new Persister(dir, { flushMs: 0 });
    p.begin(1);
    const append = vi.spyOn(fs, "appendFileSync");
    const write = vi.spyOn(fs, "writeFileSync");
    try {
      for (let i = 0; i < 100; i++) p.push(traceRow(trace(), redactor));
      expect(append).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(dir, PERSIST_FILE))).toBe(false);
      p.flush();
      expect(fs.existsSync(path.join(dir, PERSIST_FILE))).toBe(true);
    } finally {
      append.mockRestore();
      write.mockRestore();
      p.stop();
    }
    expect(foldRows(parseRows(fs.readFileSync(path.join(dir, PERSIST_FILE), "utf8"))).traces).toHaveLength(100);
  });

  test("rotates past maxBytes and keeps at most 2 files; the header survives rotation", () => {
    const p = new Persister(dir, {
      flushMs: 0,
      maxBytes: 4096,
      header: () => [{ k: "e", s: 1, info: { id: 0 } as any }],
    });
    p.begin(1);
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 5; i++) p.push(traceRow(trace(), redactor));
      p.flush();
    }
    p.stop();
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual([PERSIST_ROTATED, PERSIST_FILE].sort());
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096 + 2048);
      const rows = parseRows(text);
      expect(rows[0]).toMatchObject({ k: "s", s: 1 });
      expect(rows[1]).toMatchObject({ k: "e" });
    }
  });

  test("clear() starts a fresh file", () => {
    const p = new Persister(dir, { flushMs: 0 });
    p.begin(1);
    p.push(traceRow(trace(), redactor));
    p.flush();
    p.clear();
    p.flush();
    p.stop();
    expect(foldRows(parseRows(fs.readFileSync(path.join(dir, PERSIST_FILE), "utf8"))).traces).toHaveLength(0);
  });
});

describe("EpochTracker.restore", () => {
  test("continues numbering and keeps earlier epochs before this session's start", () => {
    let m = 0;
    const tr = new EpochTracker(
      () => m,
      0,
      () => 1000,
    );
    const prior = [0, 1, 2].map((id) => ({
      id,
      at: 0,
      rebuiltAt: 0,
      files: [],
      deleted: [],
      moreFiles: 0,
      via: "unknown" as const,
      candidates: [],
      session: 1,
    }));
    tr.restore(3, prior);
    expect(tr.epoch).toBe(3);
    expect(tr.list().map((i) => [i.id, i.session, i.via])).toEqual([
      [0, 1, "unknown"],
      [1, 1, "unknown"],
      [2, 1, "unknown"],
      [3, undefined, "start"],
    ]);
    tr.observe("GET /a", false);
    m = 5;
    tr.observe("GET /a", false);
    expect(tr.epoch).toBe(4);
  });
});

describe("Runtime persistence", () => {
  const make = () =>
    new Runtime({
      options: { port: 0, basePath: "", distDir: ".next-none", root: dir, persist: true },
      discovery: { scan: () => ({ routes: [], typescript: false, scannedAt: 0 }) },
      persist: { dir: path.join(dir, "store"), flushMs: 0 },
    });
  const begin = (rt: Runtime) => (rt as any).startPersistence();
  const finish = (rt: Runtime, t: TraceRecord) => {
    const facts = t.facts;
    t.facts = undefined;
    t.done = false;
    rt.store.add(t, { rawHeaders: {} });
    t.facts = facts ? { ...facts, epoch: rt.epochs.epoch } : facts;
    rt.store.finish(t);
  };

  test("write -> stop -> restart gives the same stats; the new session starts a new epoch", async () => {
    const a = make();
    begin(a);
    expect(a.session).toBe(1);
    for (const ms of [30, 40, 50]) finish(a, trace({}, 0, ms));
    await new Promise((r) => setTimeout(r, 80)); // the store's finish timer fires "done"
    const before = snap(a.stats);
    expect(before.totals.requests).toBe(3);
    a.stop();
    a.stop(); // idempotent

    const b = make();
    begin(b);
    try {
      expect(b.session).toBe(2);
      expect(snap(b.stats)).toEqual(before);
      expect(b.epochs.epoch).toBe(1);
      const list = b.epochs.list();
      expect(list.map((i) => [i.id, i.session])).toEqual([
        [0, 1],
        [1, undefined],
      ]);
    } finally {
      b.stop();
    }
  });

  test("persist dir defaults to <distDir>/cache/hoplens", () => {
    expect(persistDir("/p", ".next")).toBe(path.join("/p", ".next", "cache", "hoplens"));
  });

  test("stop() stops health sampling and closes the epoch watchers", () => {
    const rt = make();
    rt.health.start();
    const close = vi.spyOn(rt.epochs, "close");
    const healthStop = vi.spyOn(rt.health, "stop");
    rt.stop();
    expect(healthStop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
