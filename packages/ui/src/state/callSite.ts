import { signal } from "@preact/signals";
import { api } from "../api/client";
import type { SourceResponse } from "../api/types";

/*
 * The culprit line of an N+1 loop, the same everywhere (r2). The core places an N+1 through a
 * per-item function (`for (p of posts) await getUser(p.id)`) on the declaration of the function that
 * owns the loop (buildFeedSlow, external.ts:63); the trace verdict marks the loop's call to the
 * per-item function instead (external.ts:67) by reading the source below the declaration. The
 * Overview, the route subject and the palette only have the finding summary: they resolve the same
 * line here, once per (file, line, callee), and show the declaration until it is known.
 * Follow-up: the core could record the caller frame of the outermost wrapper instead.
 */

/** Lines read below the declaration when looking for the call (as the inline peek does). */
export const SEEK_SPAN = 30;

/** The per-item function an N+1 title names: "... x10 via getUser() (N+1)" -> "getUser". */
export function calleeOfTitle(title: string): string | undefined {
  return /\bvia ([^\s()]+)\(\)/.exec(title)?.[1];
}

/** The first line at or after `line` that calls `seek(` (a word boundary before it). */
export function findCallLine(
  data: Pick<SourceResponse, "start" | "lines">,
  line: number,
  seek: string,
): number | undefined {
  const re = new RegExp(`(^|[^\\w$])${seek.replace(/[$.*+?^()[\]{}|\\]/g, "\\$&")}\\s*\\(`);
  for (let i = 0; i < data.lines.length; i++) {
    const n = data.start + i;
    if (n >= line && re.test(data.lines[i] ?? "")) return n;
  }
  return undefined;
}

/** Resolved call lines by "file:line:callee" (the declaration line when the call was not found). */
export const callSites = signal<ReadonlyMap<string, number>>(new Map());
const tried = new Set<string>();

const keyOf = (file: string, line: number, callee: string) => `${file}:${line}:${callee}`;

function resolve(file: string, line: number, callee: string): void {
  const key = keyOf(file, line, callee);
  if (tried.has(key)) return;
  tried.add(key);
  const half = Math.ceil(SEEK_SPAN / 2);
  api
    .source(file, line + half, half)
    .then((data) => {
      const next = new Map(callSites.peek());
      next.set(key, findCallLine(data, line, callee) ?? line);
      callSites.value = next;
    })
    .catch(() => {
      /* source unavailable: keep showing the declaration */
    });
}

interface Loc {
  file: string;
  line: number;
  column?: number;
}

/**
 * Where to point for a finding: for an N+1 through a per-item function, the loop's call to it
 * (resolved from the source, asynchronously; read `callSites` to re-render when it lands), else the
 * finding's own location.
 */
export function culpritLoc(f: { rule: string; title: string; location?: Loc }): Loc | undefined {
  const loc = f.location;
  if (!loc || f.rule !== "n-plus-1") return loc;
  const callee = calleeOfTitle(f.title);
  if (!callee) return loc;
  const hit = callSites.value.get(keyOf(loc.file, loc.line, callee));
  if (hit === undefined) {
    resolve(loc.file, loc.line, callee);
    return loc;
  }
  return hit === loc.line ? loc : { file: loc.file, line: hit };
}
