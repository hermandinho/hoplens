/**
 * Byte-preserving edits of one string value in a JSON file (package.json `scripts.dev`). The file is
 * never re-serialised: the value's raw span is located with a small scanner and only the bytes of
 * the inserted or deleted text change, so indentation, key order, CRLF, a BOM and the trailing
 * newline stay as they were.
 */

export type StringSpan = {
  /** Raw index of the first byte inside the quotes. */
  start: number;
  /** Raw index of the closing quote. */
  end: number;
  /** The decoded value. */
  value: string;
  /** `map[k]` is the raw index of decoded unit k; `map[value.length] === end`. */
  map: number[];
};

/** The string value at `keys` (object keys from the top level), or null when absent or not a string. */
export function findJsonString(src: string, keys: string[]): StringSpan | null {
  let i = 0;
  let found: StringSpan | null = null;

  const ws = () => {
    while (i < src.length && /[\s﻿]/.test(src[i]!)) i++;
  };
  const str = (): StringSpan => {
    if (src[i] !== '"') throw new Error(`expected string at ${i}`);
    const start = ++i;
    const map: number[] = [];
    let value = "";
    while (i < src.length && src[i] !== '"') {
      map.push(i);
      if (src[i] === "\\") {
        const e = src[i + 1];
        if (e === "u") {
          value += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[e!] ?? e;
          i += 2;
        }
      } else {
        value += src[i];
        i++;
      }
    }
    if (src[i] !== '"') throw new Error("unterminated string");
    map.push(i);
    const span = { start, end: i, value, map };
    i++;
    return span;
  };
  const val = (path: string[] | null) => {
    ws();
    const ch = src[i];
    if (ch === "{") {
      i++;
      ws();
      if (src[i] === "}") return void i++;
      for (;;) {
        ws();
        const key = str().value;
        ws();
        if (src[i] !== ":") throw new Error(`expected : at ${i}`);
        i++;
        const childPath = path && path[0] === key ? path.slice(1) : null;
        if (childPath && childPath.length === 0) {
          ws();
          if (src[i] === '"') {
            found = str();
          } else val(null);
        } else val(childPath);
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "}") return void i++;
        throw new Error(`expected , or } at ${i}`);
      }
    }
    if (ch === "[") {
      i++;
      ws();
      if (src[i] === "]") return void i++;
      for (;;) {
        val(null);
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "]") return void i++;
        throw new Error(`expected , or ] at ${i}`);
      }
    }
    if (ch === '"') return void str();
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (!m) throw new Error(`unexpected token at ${i}`);
    i += m[0].length;
  };

  try {
    val(keys);
  } catch {
    return null;
  }
  return found;
}

/** JSON-escape `s` for use inside an existing string literal. */
export function escapeJsonText(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/** Insert decoded `text` at decoded offset `at` of the value. */
export function insertInto(src: string, span: StringSpan, at: number, text: string): string {
  const raw = span.map[at]!;
  return src.slice(0, raw) + escapeJsonText(text) + src.slice(raw);
}

/** Delete the decoded range [from, to) of the value. */
export function deleteFrom(src: string, span: StringSpan, from: number, to: number): string {
  return src.slice(0, span.map[from]!) + src.slice(span.map[to]!);
}

/** The full line of `src` that holds raw index `at`, without its line ending. */
export function lineAt(src: string, at: number): string {
  const s = src.lastIndexOf("\n", at - 1) + 1;
  let e = src.indexOf("\n", at);
  if (e < 0) e = src.length;
  return src.slice(s, e).replace(/\r$/, "");
}
