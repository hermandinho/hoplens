// Request path, layer 3d: the reverse index from the text V8 ran (a loader's generated JavaScript) to
// the file on disk, for setups where they differ (tsx, a CommonJS require hook). Pure: no fs.
//
// V8's coverage offsets are into the GENERATED text. The truth model runs on that text (its own
// control-flow model, built from it: identity, exactly as for plain JavaScript); this index is what
// lets mapped.ts carry the result over to the raw file, and only where the correspondence is
// certain. It is built once per script (text hash + map) from the generated text's last
// `sourceMappingURL` (inline `data:` only: the text V8 ran is the one the map belongs to).
//
// Anchors: every mapping segment is a pair (generated offset, raw offset), UTF-16 code units like
// V8's offsets. Segments of other sources (a multi-source map) are kept as FOREIGN anchors: a span
// that holds one does not map. Segments without a source are skipped.
//
// mapSpan(start, end) is the containment rule: a generated span maps only when it holds at least
// one anchor, every anchor in it is of this file, and their raw offsets never go backwards
// (monotonic; or, for a caller that orders spans itself, only [min, max]). The raw span it answers
// is where the anchors landed: mapped.ts then requires the raw AST node it pairs with the span to
// contain it.
//
// Refused at build (`MapError.why`):
//   - 'unmapped': no inline map, a map that does not parse, no source naming this file, or text with
//     line terminators other than \n / \r\n (a lone \r, U+2028, U+2029: tools disagree on lines);
//   - 'source-moved': the map's sourcesContent for this file is not the file on disk (a prefix is
//     accepted: Hoplens' own trailer is appended after the last original byte, so offsets before it
//     are the file's own). Missing sourcesContent (tsx writes null) is accepted: the caller's
//     capture-time hash and mtime checks are what vouch for the file then.

import path from "node:path";
import { fileURLToPath } from "node:url";

export type MapWhy = "unmapped" | "source-moved";

export class MapError extends Error {
  constructor(
    readonly why: MapWhy,
    detail: string,
  ) {
    super(detail);
  }
}

/* ------------------------------------------------------------------ VLQ */

const B64 = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;

export interface Segment {
  /** 0-based generated line and UTF-16 column. */
  line: number;
  col: number;
  source: number;
  srcLine: number;
  srcCol: number;
}

/** Decode a v3 `mappings` string. Throws on malformed input. */
export function decodeMappings(mappings: string, lineOffset = 0, colOffset = 0): Segment[] {
  const out: Segment[] = [];
  let line = 0;
  let col = 0;
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  const fields: number[] = [];
  let i = 0;
  const n = mappings.length;
  while (i <= n) {
    const c = i < n ? mappings.charCodeAt(i) : 59; // end acts as ';'
    if (c === 59 /* ; */ || c === 44 /* , */) {
      if (fields.length) {
        if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5)
          throw new Error(`segment with ${fields.length} fields`);
        col += fields[0]!;
        if (fields.length >= 4) {
          source += fields[1]!;
          srcLine += fields[2]!;
          srcCol += fields[3]!;
          if (col < 0 || source < 0 || srcLine < 0 || srcCol < 0) throw new Error("negative position");
          out.push({ line: line + lineOffset, col: line === 0 ? col + colOffset : col, source, srcLine, srcCol });
        }
        fields.length = 0;
      }
      if (c === 59) {
        line++;
        col = 0;
      }
      i++;
      continue;
    }
    // one VLQ value
    let value = 0;
    let shift = 0;
    for (;;) {
      if (i >= n) throw new Error("truncated VLQ");
      const d = B64[mappings.charCodeAt(i++)] ?? -1;
      if (d < 0) throw new Error("bad base64 digit");
      value += (d & 31) * 2 ** shift;
      shift += 5;
      if (!(d & 32)) break;
      if (shift > 35) throw new Error("VLQ overflow");
    }
    fields.push(value % 2 === 1 ? -Math.floor(value / 2) : value / 2);
  }
  return out;
}

/* ------------------------------------------------------------- the map */

export interface RawMap {
  version?: number;
  sources?: Array<string | null>;
  sourcesContent?: Array<string | null>;
  sourceRoot?: string;
  mappings?: string;
  sections?: Array<{ offset: { line: number; column: number }; map: RawMap }>;
}

/** The inline map of the last `//# sourceMappingURL=data:...` comment of `text` (Node takes the last). */
export function inlineMap(text: string): RawMap | undefined {
  const re = /\/\/[#@][ \t]+sourceMappingURL=([^\s'"]+)[ \t]*(?:\r?\n|$)/g;
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  if (!last?.startsWith("data:")) return undefined;
  const comma = last.indexOf(",");
  if (comma < 0) return undefined;
  const meta = last.slice(5, comma);
  const body = last.slice(comma + 1);
  try {
    const json = /;base64$/i.test(meta) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
    return JSON.parse(json) as RawMap;
  } catch {
    return undefined;
  }
}

const win = process.platform === "win32";
const normPath = (p: string) => {
  const n = path.normalize(p);
  return win ? n.toLowerCase() : n;
};

/** The absolute path a map source names, resolved against the generated file's directory. */
export function resolveSource(source: string, sourceRoot: string | undefined, genFile: string): string | undefined {
  let s = source;
  if (sourceRoot) s = sourceRoot.endsWith("/") ? sourceRoot + s : `${sourceRoot}/${s}`;
  try {
    if (s.startsWith("file:")) return fileURLToPath(s);
  } catch {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return undefined; // webpack://, http:// ...
  if (path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s)) return path.resolve(s);
  return path.resolve(path.dirname(genFile), s);
}

/** Offsets where each line starts; undefined when the text has a line terminator other than \n. */
export function lineStarts(text: string): number[] | undefined {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) !== 10) return undefined;
    } else if (c === 0x2028 || c === 0x2029) return undefined;
  }
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface SpanMap {
  /** Raw offsets of the first and the last anchor in the span. */
  first: number;
  last: number;
  /** Lowest and highest raw offset of the span's anchors (first / last when monotonic). */
  min: number;
  max: number;
  /** Anchors in the span. */
  anchors: number;
}

export type SpanWhy = "no-anchor" | "foreign" | "backwards";

/** Generated -> raw anchors of one script (see the header). */
export class ReverseIndex {
  /** Generated offsets, ascending. */
  private readonly gen: Int32Array;
  /** Raw offset per anchor; -1 for a foreign anchor (another source). */
  private readonly raw: Int32Array;
  readonly anchorCount: number;

  constructor(
    pairs: ReadonlyArray<readonly [number, number]>,
    private readonly rawStarts: readonly number[],
    private readonly genStarts: readonly number[],
    /** The generated text (for leadingTrivia). */
    private readonly genText = "",
  ) {
    const sorted = pairs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.gen = Int32Array.from(sorted, (p) => p[0]);
    this.raw = Int32Array.from(sorted, (p) => p[1]);
    this.anchorCount = sorted.length;
  }

  /** Index of the first anchor at or after `off`. */
  private lower(off: number): number {
    let lo = 0;
    let hi = this.gen.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.gen[mid]! < off) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The containment rule for generated [start, end). `monotonic: false` lets anchors inside the span
   * go backwards (a compiler's helper call after a nested function, esbuild's `__name(f, "f")`, maps
   * its name back to `f`): the caller then owns the ordering (mapped.ts: siblings in disjoint raw nodes).
   */
  mapSpan(start: number, end: number, opts: { monotonic?: boolean } = {}): SpanMap | { why: SpanWhy } {
    const a = this.lower(start);
    const b = this.lower(end);
    if (a >= b) return { why: "no-anchor" };
    const mono = opts.monotonic !== false;
    let prev = -1;
    let min = Number.POSITIVE_INFINITY;
    let max = -1;
    for (let i = a; i < b; i++) {
      const r = this.raw[i]!;
      if (r < 0) return { why: "foreign" };
      if (mono && r < prev) return { why: "backwards" };
      prev = r;
      if (r < min) min = r;
      if (r > max) max = r;
    }
    return { first: this.raw[a]!, last: this.raw[b - 1]!, min, max, anchors: b - a };
  }

  /** Raw 1-based line of the first own anchor at or after `off` (before `end`), for display. */
  rawLine(off: number, end = Number.POSITIVE_INFINITY): number | undefined {
    for (let i = this.lower(off); i < this.gen.length && this.gen[i]! < end; i++) {
      const r = this.raw[i]!;
      if (r >= 0) return lineOf(this.rawStarts, r);
    }
    return undefined;
  }

  /** Raw 1-based line of the last own anchor before `end` (and at or after `start`), for display. */
  rawEndLine(start: number, end: number): number | undefined {
    for (let i = this.lower(end) - 1; i >= 0 && this.gen[i]! >= start; i--) {
      const r = this.raw[i]!;
      if (r >= 0) return lineOf(this.rawStarts, r);
    }
    return undefined;
  }

  /** 1-based line of a generated offset (in the generated text). */
  /**
   * `off` moved back over the spaces and tabs before it on its line: a compiler that pretty-prints
   * maps a statement at its line's indentation (esbuild), not at its first token.
   */
  leadingTrivia(off: number): number {
    let o = off;
    while (o > 0) {
      const c = this.genText.charCodeAt(o - 1);
      if (c !== 32 && c !== 9) break;
      o--;
    }
    return o;
  }

  genLine(off: number): number {
    return lineOf(this.genStarts, off);
  }
}

export interface IndexInput {
  /** The text V8 ran. */
  generated: string;
  /** Absolute path of the generated script (its URL's path): relative sources resolve against it. */
  genFile: string;
  /** The file on disk, and its absolute path. */
  raw: string;
  rawFile: string;
  /** The map; default: the inline map of `generated`. */
  map?: RawMap;
}

/** Build the reverse index of one script. Throws MapError. */
export function buildIndex(input: IndexInput): ReverseIndex {
  const map = input.map ?? inlineMap(input.generated);
  if (!map) throw new MapError("unmapped", "the generated text has no inline source map");
  const genStarts = lineStarts(input.generated);
  const rawStarts = lineStarts(input.raw);
  if (!genStarts || !rawStarts)
    throw new MapError("unmapped", "a line terminator other than \\n or \\r\\n (tools disagree on lines)");
  const want = normPath(input.rawFile);
  const pairs: Array<[number, number]> = [];
  let own = 0;
  const addMap = (m: RawMap, lineOff: number, colOff: number) => {
    if (m.sections) {
      for (const s of m.sections)
        addMap(s.map, lineOff + s.offset.line, s.offset.line === 0 ? colOff + s.offset.column : s.offset.column);
      return;
    }
    if (typeof m.mappings !== "string" || !Array.isArray(m.sources))
      throw new MapError("unmapped", "the source map has no mappings");
    const mine = m.sources.map((s) => {
      if (typeof s !== "string") return false;
      const abs = resolveSource(s, m.sourceRoot, input.genFile);
      return abs !== undefined && normPath(abs) === want;
    });
    mine.forEach((isMine, i) => {
      if (!isMine) return;
      const content = m.sourcesContent?.[i];
      if (typeof content === "string" && content !== input.raw && !content.startsWith(input.raw))
        throw new MapError("source-moved", "the source map's sourcesContent is not the file on disk");
    });
    let segs: Segment[];
    try {
      segs = decodeMappings(m.mappings, lineOff, colOff);
    } catch (err) {
      throw new MapError("unmapped", `the source map does not decode (${err instanceof Error ? err.message : err})`);
    }
    for (const s of segs) {
      const gl = genStarts[s.line];
      if (gl === undefined) throw new MapError("unmapped", "a mapping past the generated text's last line");
      const g = gl + s.col;
      if (!mine[s.source]) {
        pairs.push([g, -1]);
        continue;
      }
      const rl = rawStarts[s.srcLine];
      // Past the raw file's end: Hoplens' own trailer (in a prefix sourcesContent) or a stale map.
      const r = rl === undefined ? -1 : rl + s.srcCol;
      if (rl === undefined || r >= input.raw.length) {
        pairs.push([g, -1]);
        continue;
      }
      pairs.push([g, r]);
      own++;
    }
  };
  try {
    addMap(map, 0, 0);
  } catch (err) {
    if (err instanceof MapError) throw err;
    throw new MapError("unmapped", err instanceof Error ? err.message : String(err));
  }
  if (!own) throw new MapError("unmapped", "the source map names no position in this file");
  return new ReverseIndex(pairs, rawStarts, genStarts, input.generated);
}
