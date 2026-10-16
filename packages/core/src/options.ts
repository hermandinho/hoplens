import type { InsightsOptions } from "./insights/thresholds";

export interface HoplensProfile {
  /** Shown in the request builder's auth menu. */
  description?: string;
  /** Headers sent with every request that uses this profile. `${ENV_VAR}` is replaced at send time. */
  headers?: Record<string, string>;
}

export interface AutoTraceGlobs {
  include?: string[];
  exclude?: string[];
}

export interface HoplensOptions {
  /** Turn Hoplens on or off. Default: on during dev, off everywhere else. Also `HOPLENS=0`. */
  enabled?: boolean;
  /** Port of the standalone UI server. Also served at `/__hoplens` on your dev server. Default 4983. */
  port?: number;
  /** Header presets for the request builder. */
  profiles?: Record<string, HoplensProfile>;
  /**
   * Wrap exported functions in your own modules so they show up as hops in the journey.
   * `true` (default) traces exported functions outside framework paths.
   * Pass globs to narrow it down, or `false` to turn it off.
   */
  autoTrace?: boolean | AutoTraceGlobs;
  /** Keys whose values are masked in captured headers, bodies, arguments and results. */
  redact?: string[];
  /** Number of traces kept in memory. Default 300. */
  maxTraces?: number;
  /** Serve the UI to non-loopback clients. Default false. */
  allowRemote?: boolean;
  /**
   * Findings engine. Override thresholds (see `DEFAULT_THRESHOLDS`) or switch rules off:
   * `insights: { thresholds: { nPlusOneMin: 10 }, disable: ["logs-on-success"] }`.
   */
  insights?: InsightsOptions;
  /** How long (ms) to wait after the response finishes for late spans before finalizing. Default 40. */
  lateSpanGraceMs?: number;
  /**
   * Add `x-hoplens-trace: <id>` and a `Server-Timing` header (db, cache, ext, fn, compile, total) to
   * traced dev responses, so the browser's Network panel shows where the time went. Values are what
   * is known when headers flush: streamed responses get partial numbers. Appended to an existing
   * Server-Timing header, never overwriting it. Never added when NODE_ENV=production. Default true.
   */
  serverTiming?: boolean;
  /**
   * Keep route stats, rebuild epochs and finding counts across dev restarts, as NDJSON in
   * `<distDir>/cache/hoplens` (two files of at most 5 MB). Facts and summaries only: no bodies,
   * headers, spans, logs or error messages are written. `hoplens remove` deletes it. Default false.
   */
  persist?: boolean;
}

/** What an adapter hands to the runtime through env/disk. */
export interface ResolvedOptions extends HoplensOptions {
  port: number;
  /** URL prefix the host app lives at, e.g. `/app`. Empty by default. */
  basePath: string;
  /** Build-output dir — used by the source-map scanner. */
  distDir: string;
  /** Project root (absolute). */
  root: string;
  /** True when the host app's config wrapper ran successfully. */
  configured?: boolean;
}

export const DEFAULT_REDACT = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "x-api-key",
  "cardnumber",
  "card_number",
  "cvv",
] as const;
