import fs from "node:fs";
import path from "node:path";
import type { EpochInfo } from "./epoch";
import { normalizeUrl } from "./facts";
import type { Redactor } from "./serialize";
import type { CapturedError, FindingSummary, TimeBucket, TraceKind, TraceRecord } from "./types";

/**
 * WP10: opt-in NDJSON persistence (`persist: true`). Facts and summaries only, never bodies, headers,
 * spans, logs or error messages, so `/api/stats`, the epochs and the regressions built on them survive
 * a dev restart. Lives in `<distDir>/cache/hoplens`, which `hoplens remove` deletes.
 *
 * Rows are buffered in memory by the "done" listener and written by an unref'd timer, never on the
 * request path. Each file is capped at `maxBytes`; past it the file rotates to `facts.1.ndjson`, so at
 * most two files exist.
 */

export const PERSIST_VERSION = 1;
/** Relative to the dist dir. */
export const PERSIST_DIR = path.join("cache", "hoplens");
export const PERSIST_FILE = "facts.ndjson";
export const PERSIST_ROTATED = "facts.1.ndjson";
export const DEFAULT_PERSIST_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PERSIST_FLUSH_MS = 2000;
/** Rows held in memory between flushes; older ones are dropped past it. */
const MAX_BUFFER = 5000;

/** Session header: one per process start and at the top of every new file. */
export interface SessionRow {
  k: "s";
  v: number;
  /** Session number, 1-based, +1 per dev restart. */
  s: number;
  at: number;
}

/** One epoch (rebuild) of a session. */
export interface EpochRow {
  k: "e";
  s: number;
  info: EpochInfo;
}

/** The fields of a finished trace that the stats store reads. */
export interface TraceRow {
  k: "t";
  id: string;
  startedAt: number;
  duration?: number;
  method: string;
  /** Route template, or the normalized path when there is none (never the raw path). */
  route: string;
  kind: TraceKind;
  status?: number;
  /** The trace threw. The error itself is not kept. */
  error?: 1;
  /** Path and query (persistedUrl): only short plain values kept, everything else masked. */
  url?: string;
  facts?: {
    epoch: number;
    cold: boolean;
    time: Record<TimeBucket, number>;
    counts: { db: number; fetch: number; cache: number; fn: number };
    droppedSpans: number;
  };
  findings?: FindingSummary[];
}

export type PersistRow = SessionRow | EpochRow | TraceRow;

const REDACTED = "[redacted]";

/** Mask the values of query params whose key the redactor flags. Pure; exported for tests. */
export function redactQuery(url: string, r: Pick<Redactor, "hit">): string {
  const hashAt = url.indexOf("#");
  const clean = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = clean.indexOf("?");
  if (q < 0) return clean;
  const params = clean
    .slice(q + 1)
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf("=");
      const key = eq >= 0 ? p.slice(0, eq) : p;
      let name = key;
      try {
        name = decodeURIComponent(key);
      } catch {
        /* keep the raw key */
      }
      return eq >= 0 && r.hit(name) ? `${key}=${REDACTED}` : p;
    });
  return params.length ? `${clean.slice(0, q)}?${params.join("&")}` : clean.slice(0, q);
}

/**
 * A finding title safe to write to disk. Two rules quote free text: logs-on-success the first log line,
 * swallowed-error the error message (and the failing span's name, a concrete fetch url). Both are
 * rebuilt from their fixed parts; every other rule's title is built from normalized shapes only.
 * Pure; exported for tests.
 */
export function persistedTitle(f: Pick<FindingSummary, "rule" | "title" | "fn">): string {
  if (f.rule === "logs-on-success") {
    const m = /^(\d+ \w+(?: \+ \d+ \w+)? logs? on a \d+)/.exec(f.title);
    return m ? m[1]! : "Logs on a successful response";
  }
  if (f.rule === "swallowed-error") {
    const type = /^.*? failed \(([\w$.]+)/.exec(f.title)?.[1] ?? "Error";
    const tail = / but the response was (\d+)( x\d+)?$/.exec(f.title);
    return `${f.fn ?? "a call"} failed (${type})${tail ? ` but the response was ${tail[1]}${tail[2] ?? ""}` : ""}`;
  }
  return f.title;
}

/**
 * The request URL as persisted: path plus query keys. A value is kept only when it is short and plain
 * (`?fast=0`, `?mode=n1`), which keeps URL variants apart; anything else (an OAuth `code`, a `state`,
 * an email) and every value the redactor flags is masked. Pure; exported for tests.
 */
export function persistedUrl(url: string, r: Pick<Redactor, "hit">): string {
  const red = redactQuery(url, r);
  const q = red.indexOf("?");
  if (q < 0) return red.slice(0, 400);
  const params = red
    .slice(q + 1)
    .split("&")
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return p;
      const v = p.slice(eq + 1);
      return v === REDACTED || /^[\w.-]{0,8}$/.test(v) ? p : `${p.slice(0, eq)}=${REDACTED}`;
    });
  return `${red.slice(0, q)}?${params.join("&")}`.slice(0, 400);
}

/** The persisted form of a finished trace. Pure; exported for tests. */
export function traceRow(t: TraceRecord, r: Pick<Redactor, "hit">): TraceRow {
  const row: TraceRow = {
    k: "t",
    id: t.id,
    startedAt: t.startedAt,
    method: t.method,
    route: t.route ?? normalizeUrl(t.path),
    kind: t.kind,
  };
  if (t.duration !== undefined) row.duration = t.duration;
  if (t.status !== undefined) row.status = t.status;
  if (t.error) row.error = 1;
  if (t.url) row.url = persistedUrl(t.url, r);
  const f = t.facts;
  if (f)
    row.facts = {
      epoch: f.epoch,
      cold: f.cold,
      time: { ...f.time },
      counts: { db: f.counts.db, fetch: f.counts.fetch, cache: f.counts.cache, fn: f.counts.fn },
      droppedSpans: f.droppedSpans,
    };
  if (t.findings?.length)
    row.findings = t.findings.map((x) => {
      const s: FindingSummary = {
        rule: x.rule,
        severity: x.severity,
        title: persistedTitle(x),
        fingerprint: x.fingerprint,
      };
      if (x.fn) s.fn = x.fn;
      if (x.location) s.location = x.location;
      if (x.count !== undefined) s.count = x.count;
      if (x.estSavedMs !== undefined) s.estSavedMs = x.estSavedMs;
      return s;
    });
  return row;
}

/** A TraceRecord the stats store can ingest, rebuilt from a row. Pure; exported for tests. */
export function rowToTrace(row: TraceRow): TraceRecord {
  const t: TraceRecord = {
    id: row.id,
    startedAt: row.startedAt,
    duration: row.duration,
    done: true,
    method: row.method,
    url: row.url ?? row.route,
    path: row.route,
    route: row.route,
    kind: row.kind,
    status: row.status,
    request: { headers: {} },
    response: { headers: {} },
    spans: [],
    logs: [],
  };
  if (row.error) t.error = { type: "Error", message: "", stack: "" } satisfies CapturedError;
  if (row.facts) {
    const c = row.facts.counts;
    t.facts = {
      time: row.facts.time,
      reqBytes: 0,
      resBytes: 0,
      counts: { spans: 0, db: c.db, fetch: c.fetch, cache: c.cache, fn: c.fn, warn: 0, error: 0 },
      cold: row.facts.cold,
      compileMs: 0,
      droppedSpans: row.facts.droppedSpans,
      epoch: row.facts.epoch,
    };
  }
  if (row.findings) t.findings = row.findings.map((f) => ({ ...f, spanIds: [] }));
  return t;
}

/** Rows from NDJSON text. Malformed or unknown lines are skipped (a crash can cut the last one). */
export function parseRows(text: string): PersistRow[] {
  const out: PersistRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const row = v as PersistRow;
    if (row.k === "s" && typeof row.s === "number" && row.v === PERSIST_VERSION) out.push(row);
    else if (row.k === "e" && typeof row.s === "number" && typeof row.info?.id === "number") out.push(row);
    else if (row.k === "t" && typeof row.id === "string" && typeof row.route === "string") out.push(row);
  }
  return out;
}

export interface LoadedState {
  /** Newest session found (0 when nothing was persisted). */
  session: number;
  /** Earlier sessions' epochs, oldest first, each tagged with its session. */
  epochs: EpochInfo[];
  traces: TraceRow[];
  /** First epoch id the new session should use (0 when nothing was persisted). */
  nextEpoch: number;
}

/** Fold rows (rotated file first) into the state a new session starts from. Pure; exported for tests. */
export function foldRows(rows: readonly PersistRow[]): LoadedState {
  let session = 0;
  let maxEpoch = -1;
  const epochs = new Map<number, EpochInfo>();
  const traces: TraceRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.k === "s") session = Math.max(session, row.s);
    else if (row.k === "e") {
      session = Math.max(session, row.s);
      epochs.set(row.info.id, { ...row.info, session: row.s });
      maxEpoch = Math.max(maxEpoch, row.info.id);
    } else {
      if (seen.has(row.id)) continue; // a row can be in both files only if a rotation was interrupted
      seen.add(row.id);
      traces.push(row);
      if (row.facts) maxEpoch = Math.max(maxEpoch, row.facts.epoch);
    }
  }
  return {
    session,
    epochs: [...epochs.values()].sort((a, b) => a.id - b.id),
    traces,
    nextEpoch: maxEpoch + 1,
  };
}

export interface PersisterOptions {
  maxBytes?: number;
  flushMs?: number;
  clock?: () => number;
  /** Rows written at the top of every new file after the session header (epochs so far). */
  header?: () => PersistRow[];
}

/** Reads, buffers and writes the NDJSON files in one directory. Every fs error is swallowed. */
export class Persister {
  readonly file: string;
  readonly rotated: string;
  private readonly maxBytes: number;
  private readonly flushMs: number;
  private readonly clock: () => number;
  private readonly header: () => PersistRow[];
  private buffer: string[] = [];
  private size = -1;
  private timer?: NodeJS.Timeout;
  private reset = false;
  private stopped = false;
  session = 0;

  constructor(
    readonly dir: string,
    opts: PersisterOptions = {},
  ) {
    this.file = path.join(dir, PERSIST_FILE);
    this.rotated = path.join(dir, PERSIST_ROTATED);
    this.maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_PERSIST_MAX_BYTES);
    this.flushMs = opts.flushMs ?? DEFAULT_PERSIST_FLUSH_MS;
    this.clock = opts.clock ?? Date.now;
    this.header = opts.header ?? (() => []);
  }

  /** Read what earlier sessions left. Never throws. */
  load(): LoadedState {
    const rows: PersistRow[] = [];
    for (const f of [this.rotated, this.file]) {
      try {
        rows.push(...parseRows(fs.readFileSync(f, "utf8")));
      } catch {
        /* missing or unreadable: nothing to restore from it */
      }
    }
    return foldRows(rows);
  }

  /** Start a session: queue its header and start the flush timer. */
  begin(session: number): void {
    this.session = session;
    this.buffer.push(this.line(this.sessionRow()));
    if (this.flushMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  /** Queue a row. Memory only; the timer writes it. */
  push(row: PersistRow): void {
    if (this.stopped) return;
    this.buffer.push(this.line(row));
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
  }

  /** Forget everything persisted so far (the UI's "clear"): the next flush starts a fresh file. */
  clear(): void {
    this.buffer = [];
    this.reset = true;
  }

  /** Write queued rows now (sync: the timer and shutdown both call it; it is never on the request path). */
  flush(): void {
    if (!this.buffer.length && !this.reset) return;
    const lines = this.buffer;
    this.buffer = [];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (this.reset) {
        this.reset = false;
        fs.rmSync(this.rotated, { force: true });
        this.writeFresh(this.file, lines);
        return;
      }
      if (this.size < 0) this.size = fileSize(this.file);
      const chunk = lines.join("");
      const bytes = Buffer.byteLength(chunk);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        fs.rmSync(this.rotated, { force: true });
        fs.renameSync(this.file, this.rotated);
        this.writeFresh(this.file, lines);
        return;
      }
      fs.appendFileSync(this.file, chunk);
      this.size += bytes;
    } catch {
      this.size = -1; // re-stat next time
    }
  }

  /** Stop the timer and write what is left. Idempotent. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
  }

  private writeFresh(file: string, lines: string[]): void {
    const head = [this.sessionRow(), ...safeHeader(this.header)].map((r) => this.line(r));
    const sessionLine = head[0]!;
    const body = lines.filter((l) => l !== sessionLine);
    const chunk = [...head, ...body].join("");
    fs.writeFileSync(file, chunk);
    this.size = Buffer.byteLength(chunk);
  }

  private sessionRow(): SessionRow {
    return { k: "s", v: PERSIST_VERSION, s: this.session, at: this.sessionAt ?? (this.sessionAt = this.clock()) };
  }
  private sessionAt?: number;

  private line(row: PersistRow): string {
    return `${JSON.stringify(row)}\n`;
  }
}

function safeHeader(fn: () => PersistRow[]): PersistRow[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function fileSize(f: string): number {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

/** `<root>/<distDir>/cache/hoplens`. */
export function persistDir(root: string, distDir: string): string {
  return path.join(root, distDir || ".next", PERSIST_DIR);
}
