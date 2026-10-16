import { normalizeUrl } from "../../facts";
import type { Finding, SpanRecord } from "../../types";
import { type Rule, fingerprint, methodOf, pickLocation, shapeOf, urlOf } from "../context";

/**
 * Why a GET fetch bypassed Next's data cache, or undefined when it didn't (or we can't tell). Reads
 * only the request-side options: the upstream CDN's status (`hoplens.fetch.upstreamCache`, e.g.
 * cf-cache-status DYNAMIC) says nothing about Next's cache and would flag every Cloudflare API.
 */
export function uncachedReason(s: SpanRecord): string | undefined {
  if (s.kind !== "fetch" || methodOf(s) !== "GET") return undefined;
  const a = s.attrs;
  const mode = String(a["hoplens.fetch.cache"] ?? "").toLowerCase();
  const hit = String(a["hoplens.fetch.cacheHit"] ?? "").toLowerCase();
  const revalidate = String(a["hoplens.fetch.revalidate"] ?? "");
  if (mode === "no-store" || mode === "no-cache" || mode === "reload") return `cache: "${mode}"`;
  if (revalidate === "0") return "revalidate: 0";
  if (hit === "no-store") return "cache: no-store";
  return undefined;
}

/** GET fetches that opted out of Next's data cache (no-store / no-cache / reload / revalidate 0). */
export const fetchUncached: Rule = (ctx) => {
  const groups = new Map<string, { reason: string; spans: SpanRecord[] }>();
  for (const s of ctx.spans) {
    const reason = uncachedReason(s);
    if (!reason) continue;
    const key = shapeOf(s) ?? s.name;
    const g = groups.get(key);
    if (g) g.spans.push(s);
    else groups.set(key, { reason, spans: [s] });
  }
  const out: Finding[] = [];
  for (const [key, { reason, spans }] of groups) {
    const first = spans[0]!;
    const owner = ctx.owner(first);
    const url = urlOf(first);
    const times = spans.length > 1 ? ` x${spans.length}` : "";
    const f: Finding = {
      rule: "fetch-uncached",
      severity: "info",
      title: `fetch ${url ? normalizeUrl(url) : first.name} not cached (${reason})${times}`,
      detail: "If this data can be a few seconds stale, use next: { revalidate } or cache: 'force-cache'.",
      fingerprint: fingerprint("fetch-uncached", ctx.routeKey, key),
      spanIds: spans.map((s) => s.id),
      count: spans.length,
    };
    if (owner.fn) f.fn = owner.fn;
    const loc = pickLocation(first.location, owner.location);
    if (loc) f.location = loc;
    out.push(f);
  }
  return out;
};
