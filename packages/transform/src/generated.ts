// The generated-text registry the request path reads (@hoplens/core src/path/generated.ts, plan P5).
//
// When a loader compiled a module before V8 ran it (tsx), V8's coverage offsets are into that
// loader's output, not the file on disk. Hoplens' own loaders see that output (the ESM hook in
// COMPILED mode, posted from the hooks worker; the CommonJS layer at module._compile) and keep it
// here, on the main thread, keyed by the file's absolute path: only while the request path is on
// (register's `retainGenerated`), only output with an inline source map (nothing else can be mapped),
// and bounded: one entry at most MAX_ENTRY_CHARS, all of them MAX_TOTAL_CHARS (least recently stored
// or read dropped first: a capture's reads keep the routes it traces). A dropped file's functions come
// back UNKNOWN 'no-generated-text', never guessed, and the registry remembers why it holds no text
// (dropped(): over the per-file cap, or evicted) so the reason says so. The registry exists from the
// moment a loader is registered with retainGenerated (retentionOn()): no registry means nothing was
// ever kept in this process.

import path from "node:path";

const KEY = Symbol.for("hoplens.generated");

/** One retained text at most (same limit as the transform's sources: larger is generated code). */
export const MAX_ENTRY_CHARS = 1024 * 1024;
/** All retained texts together. */
export const MAX_TOTAL_CHARS = 16 * 1024 * 1024;

/** Inline source map marker: the only output worth keeping. */
const INLINE_MAP = /\/\/[#@][ \t]+sourceMappingURL=data:/;

/**
 * Registry key of an absolute path. MUST stay identical to generatedKey() in
 * packages/core/src/path/generated.ts.
 */
export function keyOf(abs: string): string {
  const n = path.normalize(abs);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/** Keys remembered as dropped (a bounded sample: the reason text only). */
const MAX_DROPPED = 1024;

export type DropReason = "oversize" | "evicted";

export class GeneratedRegistry {
  private readonly map = new Map<string, string>();
  private readonly gone = new Map<string, DropReason>();
  private chars = 0;
  constructor(
    readonly maxEntry = MAX_ENTRY_CHARS,
    readonly maxTotal = MAX_TOTAL_CHARS,
  ) {}
  /** The text kept for `key`; a hit makes it the most recent (insertion order is the LRU order). */
  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, code: string): boolean {
    this.delete(key);
    if (code.length > this.maxEntry) {
      this.drop(key, "oversize");
      return false;
    }
    this.gone.delete(key);
    this.map.set(key, code);
    this.chars += code.length;
    while (this.chars > this.maxTotal && this.map.size) {
      const k = this.map.keys().next().value as string;
      this.delete(k);
      this.drop(k, "evicted");
    }
    return this.map.has(key);
  }
  /** Why `key` has no text although a loader handed one over, if it was dropped. */
  dropped(key: string): DropReason | undefined {
    return this.gone.get(key);
  }
  private drop(key: string, why: DropReason): void {
    this.gone.delete(key);
    this.gone.set(key, why);
    if (this.gone.size > MAX_DROPPED) this.gone.delete(this.gone.keys().next().value as string);
  }
  delete(key: string): void {
    const old = this.map.get(key);
    if (old === undefined) return;
    this.map.delete(key);
    this.chars -= old.length;
  }
  get size(): number {
    return this.map.size;
  }
  get totalChars(): number {
    return this.chars;
  }
}

/** The process's registry (created on first use). */
export function generatedRegistry(): GeneratedRegistry {
  const g = globalThis as any;
  g[KEY] ??= new GeneratedRegistry();
  return g[KEY];
}

/** Retention is on in this process: create the registry, so its absence means it never was. */
export function retentionOn(): void {
  try {
    generatedRegistry();
  } catch {
    /* the request path only loses its reason text */
  }
}

/** Worth keeping: a string with an inline source map. */
export function retainable(code: unknown): code is string {
  return typeof code === "string" && code.length <= MAX_ENTRY_CHARS && INLINE_MAP.test(code);
}

/** Keep `code` as the text V8 runs for `file` (absolute path). Never throws. */
export function retainGenerated(file: string, code: unknown): void {
  try {
    // Over the cap still goes to set(): it is refused there and remembered as 'oversize'.
    if (typeof code === "string" && INLINE_MAP.test(code)) generatedRegistry().set(keyOf(file), code);
  } catch {
    /* the request path only loses this file's mapping */
  }
}
