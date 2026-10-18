import { types } from "node:util";

const MAX_STRING = 400;
const MAX_KEYS = 40;
const MAX_ITEMS = 25;
const MAX_DEPTH = 5;

export function makeRedactor(keys: string[]) {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  const hit = (k: string) => {
    const l = k.toLowerCase();
    if (set.has(l)) return true;
    for (const s of set) if (s.length > 3 && l.includes(s)) return true;
    return false;
  };
  const mask = (v: unknown) => {
    const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
    return s.length > 8 ? `${s.slice(0, 4)}… [redacted]` : "[redacted]";
  };
  return { hit, mask };
}

export type Redactor = ReturnType<typeof makeRedactor>;

const UNREADABLE = "[unreadable]";
const GETTER = "[Getter]";

/**
 * JSON-safe, size-bounded copy of any value for display. It reads what a value holds without running
 * the app's code, and never throws: a Proxy shows as `[Proxy]` (no trap runs), an accessor property
 * as `[Getter]` (it is not called), anything else it cannot read as `[unreadable]`. Previews run on a
 * traced function's arguments before the function itself, so a side effect or a throw here would be
 * one the app never had.
 */
export function preview(value: unknown, r: Redactor, depth = 0, seen = new WeakSet<object>()): unknown {
  try {
    return previewValue(value, r, depth, seen);
  } catch {
    return UNREADABLE;
  }
}

/** `key` on obj or its prototype chain: the value of a data property, GETTER for an accessor. */
function dataProp(obj: object, key: PropertyKey): unknown {
  let o: object | null = obj;
  for (let i = 0; o && i < 32; i++) {
    if (types.isProxy(o)) return undefined;
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return "value" in d ? d.value : GETTER;
    o = Object.getPrototypeOf(o);
  }
  return undefined;
}

function ctorName(obj: object): string | undefined {
  const c = dataProp(obj, "constructor");
  if (typeof c !== "function") return undefined;
  const n = dataProp(c, "name");
  return typeof n === "string" ? n : undefined;
}

/** An own property's value, without calling an accessor. */
function ownValue(obj: object, key: PropertyKey): unknown {
  try {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (!d) return undefined;
    return "value" in d ? d.value : GETTER;
  } catch {
    return UNREADABLE;
  }
}

function previewValue(value: unknown, r: Redactor, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… (+${s.length - MAX_STRING} chars)` : s;
  }
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return `${value}n`;
  if (t === "symbol") return String(value);
  if (types.isProxy(value)) return "[Proxy]";
  if (t === "function") {
    const n = dataProp(value as object, "name");
    return `[Function ${(typeof n === "string" && n) || "anonymous"}]`;
  }
  const obj = value as any;
  if (seen.has(obj)) return "[Circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(obj) ? `[Array(${obj.length})]` : `[${ctorName(obj) ?? "Object"}]`;
  seen.add(obj);
  if (types.isDate(obj)) {
    const ms = Date.prototype.getTime.call(obj);
    return Number.isNaN(ms) ? "Invalid Date" : new Date(ms).toISOString();
  }
  if (types.isNativeError(obj) || obj instanceof Error) {
    const name = dataProp(obj, "name");
    const message = dataProp(obj, "message");
    return {
      name: typeof name === "string" ? name : "Error",
      message: typeof message === "string" ? message : String(message ?? ""),
    };
  }
  if (types.isMap(obj)) {
    const entries = Array.from(Map.prototype.entries.call(obj) as Iterable<[unknown, unknown]>).slice(0, MAX_KEYS);
    return preview(Object.fromEntries(entries), r, depth, seen);
  }
  if (types.isSet(obj)) {
    return preview(Array.from(Set.prototype.values.call(obj) as Iterable<unknown>).slice(0, MAX_ITEMS), r, depth, seen);
  }
  if (typeof URL !== "undefined" && obj instanceof URL) return obj.href;
  if (typeof Request !== "undefined" && obj instanceof Request) return `[Request ${obj.method} ${obj.url}]`;
  if (typeof Response !== "undefined" && obj instanceof Response) return `[Response ${obj.status}]`;
  if (typeof Headers !== "undefined" && obj instanceof Headers) {
    return preview(Object.fromEntries((obj as any).entries()), r, depth, seen);
  }
  if (ArrayBuffer.isView(obj) || types.isAnyArrayBuffer(obj))
    return `[${ctorName(obj) ?? "ArrayBuffer"} ${obj.byteLength} bytes]`;
  if (types.isPromise(obj) || typeof dataProp(obj, "then") === "function") return "[Promise]";
  if (Array.isArray(obj)) {
    const len = obj.length;
    const out: unknown[] = [];
    for (let i = 0; i < Math.min(len, MAX_ITEMS); i++) {
      const v = ownValue(obj, i);
      out.push(v === GETTER || v === UNREADABLE ? v : preview(v, r, depth + 1, seen));
    }
    if (len > MAX_ITEMS) out.push(`… ${len - MAX_ITEMS} more`);
    return out;
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const k of keys.slice(0, MAX_KEYS)) {
    const v = ownValue(obj, k);
    if (r.hit(k)) out[k] = r.mask(v);
    else out[k] = v === GETTER || v === UNREADABLE ? v : preview(v, r, depth + 1, seen);
  }
  if (keys.length > MAX_KEYS) out["…"] = `${keys.length - MAX_KEYS} more keys`;
  const ctor = ctorName(obj);
  if (ctor && ctor !== "Object" && depth === 0) return { __type: ctor, ...out };
  return out;
}

export function redactHeaders(h: Record<string, unknown>, r: Redactor): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    const s = Array.isArray(v) ? v.join(", ") : String(v);
    out[k] = r.hit(k) ? r.mask(s) : s;
  }
  return out;
}
