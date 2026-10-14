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

/** JSON-safe, size-bounded copy of any value for display. */
export function preview(value: unknown, r: Redactor, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > MAX_STRING ? s.slice(0, MAX_STRING) + `… (+${s.length - MAX_STRING} chars)` : s;
  }
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return `${value}n`;
  if (t === "function") return `[Function ${(value as any).name || "anonymous"}]`;
  if (t === "symbol") return String(value);
  const obj = value as any;
  if (seen.has(obj)) return "[Circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(obj) ? `[Array(${obj.length})]` : `[${obj.constructor?.name ?? "Object"}]`;
  seen.add(obj);
  if (obj instanceof Date) return isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof Error) return { name: obj.name, message: obj.message };
  if (obj instanceof Map) return preview(Object.fromEntries(Array.from(obj.entries()).slice(0, MAX_KEYS)), r, depth, seen);
  if (obj instanceof Set) return preview(Array.from(obj).slice(0, MAX_ITEMS), r, depth, seen);
  if (typeof URL !== "undefined" && obj instanceof URL) return obj.href;
  if (typeof Request !== "undefined" && obj instanceof Request) return `[Request ${obj.method} ${obj.url}]`;
  if (typeof Response !== "undefined" && obj instanceof Response) return `[Response ${obj.status}]`;
  if (typeof Headers !== "undefined" && obj instanceof Headers) {
    return preview(Object.fromEntries((obj as any).entries()), r, depth, seen);
  }
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `[${obj.constructor?.name} ${obj.byteLength} bytes]`;
  if (typeof obj.then === "function") return "[Promise]";
  if (Array.isArray(obj)) {
    const out = obj.slice(0, MAX_ITEMS).map((v) => preview(v, r, depth + 1, seen));
    if (obj.length > MAX_ITEMS) out.push(`… ${obj.length - MAX_ITEMS} more`);
    return out;
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const k of keys.slice(0, MAX_KEYS)) {
    let v: unknown;
    try {
      v = obj[k];
    } catch {
      v = "[unreadable]";
    }
    out[k] = r.hit(k) ? r.mask(v) : preview(v, r, depth + 1, seen);
  }
  if (keys.length > MAX_KEYS) out["…"] = `${keys.length - MAX_KEYS} more keys`;
  const ctor = obj.constructor?.name;
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
