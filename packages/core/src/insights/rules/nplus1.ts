import { firstCallSite } from "../../callsite";
import { unionLength } from "../../facts";
import type { Finding, SpanRecord } from "../../types";
import { type Rule, type RuleContext, dur, fingerprint, labelOf, pickLocation, roundMs, shapeOf } from "../context";

/** How many per-call wrapper functions we look through (loop -> getUser -> fetchJson -> fetch). */
const MAX_WRAPPER_DEPTH = 3;

/**
 * N+1: the same query/url shape issued at least `nPlusOneMin` times under one parent. Covers fetch
 * too (e.g. GET /users/:id once per post). Also covers the common loop over a traced per-item
 * function (`for (p of posts) await getAuthor(p.id)`): there every query has its own wrapper span as
 * parent, so the group key climbs past up to `MAX_WRAPPER_DEPTH` function wrappers and requires the
 * wrappers themselves to be distinct calls. Spans claimed here (and their wrappers) are skipped by
 * `duplicate` and `parallelizable`.
 */
export const nPlusOne: Rule = (ctx) => {
  const io: SpanRecord[] = [];
  for (const s of ctx.spans) if (shapeOf(s)) io.push(s);
  if (io.length < ctx.th.nPlusOneMin) return [];
  const out: Finding[] = [];

  // Grouping uses nested maps (anchor -> shape -> spans) rather than concatenated keys: the shape
  // strings are cached per span, so their hashes are too, and nothing gets re-flattened per span.
  // Pass 0: same direct parent.
  const direct = new Map<string, Map<string, SpanRecord[]>>();
  for (const s of io) {
    const shape = shapeOf(s)!;
    const anchor = s.parentId ?? "";
    let byShape = direct.get(anchor);
    if (!byShape) direct.set(anchor, (byShape = new Map()));
    const list = byShape.get(shape);
    if (list) list.push(s);
    else byShape.set(shape, [s]);
  }
  for (const byShape of direct.values())
    for (const list of byShape.values()) if (list.length >= ctx.th.nPlusOneMin) out.push(toFinding(ctx, list, []));

  // Pass k: climb past k function wrappers; key on the anchor above them + the wrapper names.
  // Each span's wrapper chain is walked once, up front; most I/O has no function parent at all.
  const chains: Array<SpanRecord[] | undefined> = [];
  let wrapped = 0;
  for (const s of io) {
    const chain = wrappersOf(ctx, s);
    chains.push(chain);
    if (chain) wrapped++;
  }
  type Group = { spans: SpanRecord[]; wrappers: SpanRecord[]; chain: SpanRecord[] };
  for (let k = 1; k <= MAX_WRAPPER_DEPTH && wrapped >= ctx.th.nPlusOneMin; k++) {
    // anchor (the outermost wrapper's parent) -> wrapper names -> shape. Keys are strings the spans
    // already hold, so their hashes are cached; building a combined key string per span was the
    // single most expensive thing in the analysis.
    const groups = new Map<string, Map<string, Map<string, Group>>>();
    for (let i = 0; i < io.length; i++) {
      const chain = chains[i];
      const s = io[i]!;
      if (!chain || chain.length < k || ctx.claimed.has(s.id)) continue;
      const top = chain[k - 1]!;
      const anchor = top.parentId ?? "";
      const names = k === 1 ? top.name : namesOf(chain, k);
      const shape = shapeOf(s)!;
      let byNames = groups.get(anchor);
      if (!byNames) groups.set(anchor, (byNames = new Map()));
      let byShape = byNames.get(names);
      if (!byShape) byNames.set(names, (byShape = new Map()));
      const g = byShape.get(shape);
      if (g) {
        g.spans.push(s);
        g.wrappers.push(top);
      } else byShape.set(shape, { spans: [s], wrappers: [top], chain: chain.slice(0, k) });
    }
    if (groups.size === 0) break;
    for (const byNames of groups.values())
      for (const byShape of byNames.values())
        for (const { spans, wrappers, chain } of byShape.values()) {
          if (spans.length < ctx.th.nPlusOneMin) continue;
          // The wrappers must be separate calls; one wrapper running the query N times is pass 0's job.
          const distinct = new Set(wrappers.map((w) => w.id));
          if (distinct.size < ctx.th.nPlusOneMin) continue;
          for (const s of spans) {
            let cur = s;
            for (let j = 0; j < k; j++) {
              const p = cur.parentId ? ctx.byId.get(cur.parentId) : undefined;
              if (!p) break;
              ctx.claimed.add(p.id);
              cur = p;
            }
          }
          out.push(
            toFinding(
              ctx,
              spans,
              chain.map((w) => w.name),
              wrappers[0],
              wrappers,
            ),
          );
        }
  }
  return out;
};

function namesOf(chain: SpanRecord[], k: number): string {
  let out = chain[0]!.name;
  for (let i = 1; i < k; i++) out += `>${chain[i]!.name}`;
  return out;
}

/** Up to MAX_WRAPPER_DEPTH nearest ancestors that are function spans (nearest first). */
function wrappersOf(ctx: RuleContext, s: SpanRecord): SpanRecord[] | undefined {
  let chain: SpanRecord[] | undefined;
  let cur = s;
  for (let i = 0; i < MAX_WRAPPER_DEPTH; i++) {
    const p = cur.parentId ? ctx.byId.get(cur.parentId) : undefined;
    if (!p || p.kind !== "function") break;
    (chain ??= []).push(p);
    cur = p;
  }
  return chain;
}

/** `wrappers` = wrapper fn names, nearest first; `top` = one outermost wrapper span, `tops` = all of them. */
function toFinding(
  ctx: RuleContext,
  list: SpanRecord[],
  wrappers: string[],
  top?: SpanRecord,
  tops?: readonly SpanRecord[],
): Finding {
  const first = list[0]!;
  const shape = shapeOf(first)!;
  // With wrappers, the owner is whoever called the outermost wrapper in a loop.
  const caller = top?.parentId ? ctx.byId.get(top.parentId) : undefined;
  const owner = ctx.owner(caller ?? first);
  for (const s of list) ctx.claimed.add(s.id);
  const total = unionLength(list.map((s): [number, number] => [s.start, s.end]));
  const longest = Math.max(...list.map(dur));
  const fetching = first.kind === "fetch";
  const outer = wrappers[wrappers.length - 1];
  const via = outer ? ` via ${outer}()` : "";
  const f: Finding = {
    rule: "n-plus-1",
    severity: list.length >= ctx.th.nPlusOneMin * 4 ? "error" : "warn",
    title: `${owner.fn ?? "request"} ${fetching ? "fetched" : "ran"} ${labelOf(first)} x${list.length}${via} (N+1)`,
    detail: `The same ${fetching ? "request" : "query"} shape ran ${list.length} times${
      outer ? `, once per ${outer}() call` : " under one parent"
    }. Batch it (WHERE id IN (...), a join, or one bulk endpoint).`,
    fingerprint: fingerprint(
      "n-plus-1",
      ctx.routeKey,
      wrappers.length ? `${owner.fn ?? ""}|${wrappers.join(">")}|${shape}` : `${owner.fn ?? ""}|${shape}`,
    ),
    spanIds: list.map((s) => s.id),
    count: list.length,
  };
  if (owner.fn) f.fn = owner.fn;
  // Through wrappers, point at the loop: the line that called the outermost wrapper (captured on
  // its first repeat, see callsite.ts), else the query's own line, else the owning function.
  const site = tops ? firstCallSite(tops) : undefined;
  const loc = site?.file ? { ...site, via: "call-site" as const } : pickLocation(first.location, owner.location);
  if (loc) f.location = loc;
  if (total > longest) f.estSavedMs = roundMs(total - longest);
  return f;
}
