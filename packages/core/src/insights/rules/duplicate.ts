import type { Finding, SpanRecord } from "../../types";
import { type Rule, dur, exactOf, fingerprint, labelOf, pickLocation, roundMs, shapeOf } from "../context";

/** Exact same query+params (or method+url) issued more than once in a trace. Skips N+1 groups. */
export const duplicate: Rule = (ctx) => {
  const groups = new Map<string, SpanRecord[]>();
  for (const s of ctx.spans) {
    if (ctx.claimed.has(s.id)) continue;
    const key = exactOf(s);
    if (!key) continue;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(s);
  }
  const out: Finding[] = [];
  for (const list of groups.values()) {
    if (list.length < ctx.th.duplicateMin) continue;
    const first = list[0]!;
    const owner = ctx.owner(first);
    const durations = list.map(dur);
    const saved = durations.reduce((a, b) => a + b, 0) - Math.max(...durations);
    const f: Finding = {
      rule: "duplicate",
      severity: "warn",
      title: `${labelOf(first)} ran x${list.length} with identical ${first.kind === "fetch" ? "url" : "params"}`,
      detail: "Identical calls in one request. Reuse the first result (React cache(), memoize, or hoist it).",
      fingerprint: fingerprint("duplicate", ctx.routeKey, `${owner.fn ?? ""}|${shapeOf(first) ?? first.name}`),
      spanIds: list.map((s) => s.id),
      count: list.length,
    };
    if (owner.fn) f.fn = owner.fn;
    const loc = pickLocation(first.location, owner.location);
    if (loc) f.location = loc;
    if (saved > 0) f.estSavedMs = roundMs(saved);
    out.push(f);
  }
  return out;
};
