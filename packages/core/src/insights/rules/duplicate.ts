import { firstCallSite } from "../../callsite";
import type { Finding, SpanRecord } from "../../types";
import {
  type Rule,
  type RuleContext,
  dur,
  exactOf,
  fingerprint,
  labelOf,
  pickLocation,
  roundMs,
  shapeOf,
} from "../context";

/** How many per-call wrapper functions we look through (handler -> getProduct -> findProduct -> query). */
const MAX_WRAPPER_DEPTH = 3;

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
    // Each repeat under its own call of the same traced function (`findProduct(id)` twice): the
    // repetition is in whoever called it, so own and locate the finding there, as n-plus-1 does.
    const via = repeatedWrapper(ctx, list);
    const callerId = via?.tops[0]!.parentId;
    const caller = callerId ? ctx.byId.get(callerId) : undefined;
    const owner = ctx.owner(caller ?? first);
    const durations = list.map(dur);
    const saved = durations.reduce((a, b) => a + b, 0) - Math.max(...durations);
    const viaText = via ? ` via ${via.names[via.names.length - 1]}()` : "";
    const key = `${owner.fn ?? ""}|${via ? `${via.names.join(">")}|` : ""}${shapeOf(first) ?? first.name}`;
    const f: Finding = {
      rule: "duplicate",
      severity: "warn",
      title: `${labelOf(first)} ran x${list.length}${viaText} with identical ${first.kind === "fetch" ? "url" : "params"}`,
      detail: "Identical calls in one request. Reuse the first result (React cache(), memoize, or hoist it).",
      fingerprint: fingerprint("duplicate", ctx.routeKey, key),
      spanIds: list.map((s) => s.id),
      count: list.length,
    };
    if (owner.fn) f.fn = owner.fn;
    // Through a wrapper, point at the repeat call (core captures the caller's line on a wrapped
    // function's 2nd call under one parent, see callsite.ts), else the query's line, else the owner.
    const site = via ? firstCallSite(via.tops) : undefined;
    const loc = site?.file ? { ...site, via: "call-site" as const } : pickLocation(first.location, owner.location);
    if (loc) f.location = loc;
    if (saved > 0) f.estSavedMs = roundMs(saved);
    out.push(f);
  }
  return out;
};

/**
 * The outermost level (up to MAX_WRAPPER_DEPTH) at which every span of `list` sits under its own call
 * of the same function chain and those calls share one parent. `tops` are the calls at that level,
 * `names` the chain nearest first. undefined when the repeats run inside one function call.
 */
function repeatedWrapper(ctx: RuleContext, list: SpanRecord[]): { tops: SpanRecord[]; names: string[] } | undefined {
  let best: { tops: SpanRecord[]; names: string[] } | undefined;
  let cur: SpanRecord[] = list;
  const names: string[] = [];
  for (let k = 0; k < MAX_WRAPPER_DEPTH; k++) {
    const next: SpanRecord[] = [];
    for (const s of cur) {
      const p = s.parentId ? ctx.byId.get(s.parentId) : undefined;
      if (!p || p.kind !== "function" || (next.length > 0 && p.name !== next[0]!.name)) return best;
      next.push(p);
    }
    // Repeats inside one call (here or above) are that call's own duplicate: stop at the level below.
    if (new Set(next.map((p) => p.id)).size !== next.length) return best;
    names.push(next[0]!.name);
    if (next.every((p) => p.parentId === next[0]!.parentId)) best = { tops: next, names: [...names] };
    cur = next;
  }
  return best;
}
