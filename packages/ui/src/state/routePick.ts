import type { MethodInfo, RouteInfo, SchemaInfo } from "../api/types";

/*
 * Pure helpers behind the request builder: the route picker's groups and labels, path params
 * (seeding, splitting a template into chips, filling it). No signals: state/builder holds the live
 * state. Tested by packages/ui/test/routePick.test.ts.
 *
 * Path notation (the builder's, shared by every adapter): `:name` required, `:name+` one or more
 * segments, `:name*` optional (zero or more). A param may sit mid-segment (`/report.:format*`).
 */

const PARAM_SRC = String.raw`:([A-Za-z_$][\w$]*)([+*])?`;

/** A regex route (Express `app.get(/^\/x$/)`): listed as written, nothing for the builder to fill. */
export function isRegexRoute(r: Pick<RouteInfo, "path" | "params">): boolean {
  return r.params.length === 0 && /[\\^$|()]/.test(r.path);
}

export type PathPart =
  | { kind: "sep" }
  | { kind: "text"; text: string }
  | { kind: "param"; name: string; mod: "" | "+" | "*" };

/** "/u/:uid/report.:format*" -> sep, text u, sep, param uid, sep, text "report.", param format. */
export function pathParts(path: string): PathPart[] {
  const out: PathPart[] = [];
  const segs = path.split("/");
  segs.forEach((seg, i) => {
    if (i > 0) out.push({ kind: "sep" });
    const re = new RegExp(PARAM_SRC, "g");
    let last = 0;
    for (let m = re.exec(seg); m; m = re.exec(seg)) {
      if (m.index > last) out.push({ kind: "text", text: seg.slice(last, m.index) });
      out.push({ kind: "param", name: m[1]!, mod: (m[2] ?? "") as "" | "+" | "*" });
      last = m.index + m[0].length;
    }
    if (last < seg.length) out.push({ kind: "text", text: seg.slice(last) });
  });
  return out;
}

/** The names of the params in a path, in order. */
export function paramNames(path: string): string[] {
  return pathParts(path).flatMap((p) => (p.kind === "param" ? [p.name] : []));
}

/**
 * Fill a path's params. An empty required param (`:name`, `:name+`) stays as written (the server
 * says what is missing); an empty optional one (`*`) drops out with the `.`, `-` or `~` that
 * introduced it inside its segment, so `/report.:format*` with no format is `/report`, not
 * `/report.`, and with the `/` before it when it is the whole segment, so `/a/:b*` + `/c` gives `/a/c`.
 */
export function resolvePath(template: string, params: Record<string, string>): string {
  const re = new RegExp(String.raw`([/](?=:[A-Za-z_$][\w$]*\*(?:[/]|$))|[.\-~])?${PARAM_SRC}`, "g");
  const out = template.replace(re, (m, pre: string | undefined, name: string, mod?: string) => {
    const v = params[name];
    if (v) return `${pre ?? ""}${v}`;
    return mod === "*" ? "" : m;
  });
  return out || "/";
}

/** Required params (`:name`, and `:name+`: one or more) left empty: Send would hit a literal `:name`. */
export function missingParams(path: string, params: Record<string, string>): string[] {
  return pathParts(path).flatMap((p) => (p.kind === "param" && p.mod !== "*" && !params[p.name] ? [p.name] : []));
}

function exampleParams(schema: SchemaInfo | undefined): Record<string, string> {
  if (!schema || typeof schema.example !== "object" || schema.example === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(schema.example as Record<string, unknown>)) out[k] = String(v);
  return out;
}

/**
 * First values for a route's path params: the params schema's example, `123` for an `id`, else
 * empty (the chip shows the name as its placeholder). Never the param's own name: `/u/uid` is a
 * request to a user called "uid".
 */
export function seedParams(
  route: Pick<RouteInfo, "params">,
  method: Pick<MethodInfo, "schemas">,
): Record<string, string> {
  const seed = exampleParams(method.schemas.find((s) => s.target === "params"));
  const params: Record<string, string> = {};
  for (const p of route.params) params[p.name] = seed[p.name] ?? (p.name === "id" ? "123" : "");
  return params;
}

/* ------------------------------------------------------------- the picker */

export interface PickOption {
  /** `${route.id}::${method}`, the builder key. */
  value: string;
  label: string;
  disabled?: boolean;
  /** Why it is disabled (its tooltip). */
  reason?: string;
}

export interface PickGroup {
  label: string;
  options: PickOption[];
}

export const REGEX_GROUP = "regex routes (not sendable)";
export const REGEX_REASON =
  "A regex route has no template for the builder to fill. Send its URL with curl or replay a trace.";

/**
 * The picker's option groups. Labels show the template a trace names (`nextRoute`) except under
 * Next.js, which keeps its `:param` path. Grouped by first path segment (`/root` for `/`), sorted;
 * regex routes go last, disabled. One method + template registered in two files gets the file
 * appended, so the two options can be told apart.
 */
export function pickerGroups(routes: readonly RouteInfo[], isNext: boolean): PickGroup[] {
  const shown = (r: RouteInfo) => (isNext ? r.path : r.nextRoute || r.path);
  const seen = new Map<string, number>();
  for (const r of routes)
    for (const m of r.methods) {
      const k = `${m.method} ${shown(r)}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  const groups = new Map<string, PickOption[]>();
  const regex: PickOption[] = [];
  for (const r of routes) {
    const re = isRegexRoute(r);
    const g = shown(r).split("/").filter(Boolean)[0] ?? "root";
    for (const m of r.methods) {
      const base = `${m.method} ${shown(r)}`;
      const dup = (seen.get(base) ?? 0) > 1 ? `  (${r.file || r.id})` : "";
      const opt: PickOption = {
        value: `${r.id}::${m.method}`,
        label: `${base}${dup}${m.schemas.length > 0 ? "  (schema)" : ""}`,
      };
      if (re) regex.push({ ...opt, disabled: true, reason: REGEX_REASON });
      else {
        const list = groups.get(g) ?? [];
        list.push(opt);
        groups.set(g, list);
      }
    }
  }
  const out = [...groups.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([g, options]) => ({ label: `/${g}`, options }));
  if (regex.length) out.push({ label: REGEX_GROUP, options: regex });
  return out;
}
