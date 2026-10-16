import type { Finding, SpanRecord } from "../../types";
import { type Rule, type RuleContext, fingerprint, pickLocation, shapeOf } from "../context";

/**
 * A span failed, yet the response still went out with a status below 400. One failure that
 * propagated through several spans (fetch -> fetchInventory, possibly re-thrown with a new
 * message) is reported once, at the outermost errored span of the chain.
 */
export const swallowedError: Rule = (ctx) => {
  const status = ctx.trace.status;
  if (status === undefined || status >= 400) return [];
  const groups = new Map<string, SpanRecord[]>();
  for (const s of ctx.spans) {
    if (!s.error || hasErroredAncestor(ctx, s)) continue;
    // shapeOf, not the name: fetch span names hold the concrete url (`.../pokemon/25`).
    const key = `${s.kind}|${shapeOf(s) ?? s.name}|${s.error.type}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const out: Finding[] = [];
  for (const [key, list] of groups) {
    const first = list[0]!;
    const err = first.error!;
    const owner = ctx.owner(first);
    // A fetch that got a 4xx/5xx and was handled is often deliberate; a thrown error rarely is.
    const httpOnly = first.kind === "fetch" && /^HTTP \d{3}$/.test(err.message);
    const times = list.length > 1 ? ` x${list.length}` : "";
    const f: Finding = {
      rule: "swallowed-error",
      severity: httpOnly ? "info" : "warn",
      title: `${first.name} failed (${err.type}: ${truncate(err.message, 60)}) but the response was ${status}${times}`,
      detail: "The error was caught somewhere and the request still succeeded. Make sure that's intended.",
      fingerprint: fingerprint("swallowed-error", ctx.routeKey, key),
      spanIds: list.map((s) => s.id),
      count: list.length,
    };
    if (owner.fn) f.fn = owner.fn;
    const loc = pickLocation(err.location, first.location, owner.location);
    if (loc) f.location = loc;
    out.push(f);
  }
  return out;
};

function hasErroredAncestor(ctx: RuleContext, s: SpanRecord): boolean {
  let cur = s.parentId ? ctx.byId.get(s.parentId) : undefined;
  for (let guard = 0; cur && guard < 256; guard++) {
    if (cur.error) return true;
    cur = cur.parentId ? ctx.byId.get(cur.parentId) : undefined;
  }
  return false;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
