import type { FindingRule } from "../api/types";
import { type FrameworkCopy, NEXT_COPY, ruleLabel } from "./framework";
import { RULE_LABELS } from "./stats";

/*
 * Autocomplete for the request-log query bar. Pure: given the input, the caret and the known routes,
 * return the suggestions for the token under the caret and how to splice one in.
 */

export interface Suggestion {
  /** Text inserted in place of the token (or its value part). */
  insert: string;
  /** What the list shows. */
  label: string;
  hint?: string;
}

export interface SuggestResult {
  /** Index in the input where the replaced part starts (it ends at the caret). */
  from: number;
  /** True when completing a key: no trailing space, the user goes on to type the value. */
  isKey: boolean;
  items: Suggestion[];
}

export const QUERY_KEYS: ReadonlyArray<{ key: string; hint: string; example: string }> = [
  { key: "status:", hint: "5xx, 404, >=400, 400..499", example: "status:5xx" },
  { key: "dur:", hint: ">200, <=50ms, >1.5s, 100..500", example: "dur:>200" },
  { key: "route:", hint: "glob over the route template or path", example: "route:/api/*" },
  { key: "method:", hint: "GET, POST, get,put", example: "method:POST" },
  { key: "has:", hint: "a finding rule, error, findings", example: "has:n+1" },
  { key: "kind:", hint: "route, page, rsc, action, asset", example: "kind:route" },
  { key: "cold:", hint: "true or false", example: "cold:true" },
  { key: "text:", hint: '"quoted phrase": also searches logs and bodies', example: 'text:"timeout"' },
];

const RULES = Object.keys(RULE_LABELS) as FindingRule[];

const VALUES: Record<string, ReadonlyArray<{ v: string; hint?: string }>> = {
  status: [
    { v: "5xx", hint: "server errors" },
    { v: "4xx", hint: "client errors" },
    { v: "2xx" },
    { v: "3xx" },
    { v: ">=400", hint: "anything failing" },
    { v: "404" },
    { v: "500" },
  ],
  dur: [
    { v: ">100", hint: "slower than 100 ms" },
    { v: ">500" },
    { v: ">1s" },
    { v: "<50", hint: "faster than 50 ms" },
    { v: "100..500", hint: "between" },
  ],
  method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((v) => ({ v })),
  kind: [
    { v: "route", hint: "API route handlers" },
    { v: "page", hint: "page renders" },
    { v: "rsc", hint: "RSC payloads" },
    { v: "action", hint: "server actions" },
    { v: "asset" },
    { v: "other" },
  ],
  has: [
    ...RULES.map((r) => ({ v: r, hint: ruleLabel(r) })),
    { v: "error", hint: "a captured error (thrown or caught)" },
    { v: "findings", hint: "any finding" },
  ],
  cold: [
    { v: "true", hint: "first request after a rebuild" },
    { v: "false", hint: "warm requests only" },
  ],
};

const MAX_ITEMS = 10;

/** The value hints that follow the framework: the cold-compile label and what `cold:true` means. */
function valuesFor(key: string, fw: FrameworkCopy): ReadonlyArray<{ v: string; hint?: string }> {
  const list = VALUES[key] ?? [];
  if (fw.isNext) return list;
  if (key === "has") return list.map((x) => (x.v === "cold-compile" ? { ...x, hint: ruleLabel(x.v, fw) } : x));
  if (key === "cold") return list.map((x) => (x.v === "true" ? { ...x, hint: fw.coldQueryHint } : x));
  return list;
}

/** Suggestions for the token ending at `caret`. Empty `items` means nothing to offer. */
export function suggest(
  input: string,
  caret: number,
  routes: readonly string[],
  fw: FrameworkCopy = NEXT_COPY,
): SuggestResult {
  const before = input.slice(0, caret);
  // Inside an open quote: free text, nothing to complete.
  if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return { from: caret, isKey: false, items: [] };
  let start = before.length;
  while (start > 0 && !/\s/.test(before[start - 1] as string)) start--;
  let token = before.slice(start);
  let from = start;
  if (token.startsWith("-")) {
    token = token.slice(1);
    from++;
  }
  const colon = token.indexOf(":");
  if (colon < 0) {
    const t = token.toLowerCase();
    const items = QUERY_KEYS.filter((k) => k.key.startsWith(t) && k.key !== t).map((k) => ({
      insert: k.key,
      label: k.key,
      hint: k.hint,
    }));
    return { from, isKey: true, items: items.slice(0, MAX_ITEMS) };
  }
  const key = token.slice(0, colon).toLowerCase();
  const value = token.slice(colon + 1);
  const comma = value.lastIndexOf(",");
  const prefix = (comma >= 0 ? value.slice(comma + 1) : value).toLowerCase();
  const valueFrom = from + colon + 1 + (comma >= 0 ? comma + 1 : 0);
  let pool: ReadonlyArray<{ v: string; hint?: string }>;
  if (key === "route") {
    const seen = new Set<string>();
    const list: Array<{ v: string }> = [];
    for (const r of routes) {
      if (seen.has(r)) continue;
      seen.add(r);
      list.push({ v: r });
    }
    pool = list.filter((r) => r.v.toLowerCase().includes(prefix));
  } else {
    pool = valuesFor(key, fw).filter((x) => x.v.toLowerCase().startsWith(prefix));
  }
  const items = pool
    .filter((x) => x.v.toLowerCase() !== prefix)
    .slice(0, MAX_ITEMS)
    .map((x) => ({ insert: /\s/.test(x.v) ? `"${x.v}"` : x.v, label: `${key}:${x.v}`, hint: x.hint }));
  return { from: valueFrom, isKey: false, items };
}

/** Splice a suggestion in. Returns the new input and where the caret goes. */
export function applySuggestion(
  input: string,
  caret: number,
  res: SuggestResult,
  s: Suggestion,
): { value: string; caret: number } {
  const tail = input.slice(caret);
  const sep = res.isKey || tail.startsWith(" ") ? "" : " ";
  const head = `${input.slice(0, res.from)}${s.insert}${sep}`;
  return { value: `${head}${tail}`, caret: head.length };
}

/** Quote a query value when it carries spaces or quotes. */
export function quoteValue(v: string): string {
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/**
 * The query a finding badge or a "Needs attention" row prefills: `has:<rule>` plus the route when
 * there is exactly one. `routeKey` is "METHOD /route".
 */
export function findingQuery(rule: string, routeKeys: readonly string[] = []): string {
  const parts = [`has:${rule}`];
  if (routeKeys.length === 1) {
    const k = routeKeys[0] as string;
    const sp = k.indexOf(" ");
    if (sp > 0) parts.push(`method:${k.slice(0, sp)}`, `route:${quoteValue(k.slice(sp + 1))}`);
    else parts.push(`route:${quoteValue(k)}`);
  }
  return parts.join(" ");
}
