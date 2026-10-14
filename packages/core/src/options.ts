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
