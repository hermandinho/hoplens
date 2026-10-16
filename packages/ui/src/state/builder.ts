import { computed, effect, signal } from "@preact/signals";
import { api } from "../api/client";
import type { MethodInfo, RouteInfo, RunResult, SchemaInfo } from "../api/types";
import { REPLAY_N, type ReplayRequest, startReplay } from "./replay";
import { type Route, route } from "./router";
import { builderOpen, loadTrace, metaState, routesState, selectedRouteKey } from "./store";

export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

export interface BuilderState {
  routeKey: string;
  method: string;
  path: string; // template with :params
  params: Record<string, string>;
  body: string; // JSON text
  query: KV[];
  headers: KV[];
  profile: string;
}

export type BuilderTab = "body" | "query" | "headers" | "auth";

export const builderState = signal<BuilderState | null>(null);
export const builderTab = signal<BuilderTab>("body");
export const sending = signal(false);
export const lastRunResult = signal<RunResult | null>(null);
export const sendError = signal<string | null>(null);

export const activeRoute = computed((): { route: RouteInfo; method: MethodInfo } | null => {
  const key = selectedRouteKey.value;
  if (!key) return null;
  const [routeId, method] = key.split("::");
  const route = routesState.value?.routes.find((r) => r.id === routeId);
  if (!route) return null;
  const m = route.methods.find((x) => x.method === method);
  if (!m) return null;
  return { route, method: m };
});

export const activeSchemas = computed(() => activeRoute.value?.method.schemas ?? []);
export const activeBodySchema = computed(() => activeSchemas.value.find((s) => s.target === "body") ?? null);
export const activeQuerySchema = computed(() => activeSchemas.value.find((s) => s.target === "query") ?? null);

/* ------------------------------------------------- route → initial builder */

function kvFromObject(obj: Record<string, unknown> | undefined): KV[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value: String(value), enabled: true }));
}

function paramsFromExample(schema: SchemaInfo | undefined): Record<string, string> {
  if (!schema || typeof schema.example !== "object" || schema.example === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(schema.example as Record<string, unknown>)) out[k] = String(v);
  return out;
}

function initialBuilder(route: RouteInfo, method: MethodInfo): BuilderState {
  const paramSchema = method.schemas.find((s) => s.target === "params");
  const paramSeed = paramsFromExample(paramSchema);
  // Fill any path-param with the example or a placeholder.
  const params: Record<string, string> = {};
  for (const p of route.params) {
    params[p.name] = paramSeed[p.name] ?? (p.name === "id" ? "123" : p.name);
  }

  const bodySchema = method.schemas.find((s) => s.target === "body");
  const body =
    method.readsBody && bodySchema ? JSON.stringify(bodySchema.example, null, 2) : method.readsBody ? "{}" : "";

  const querySchema = method.schemas.find((s) => s.target === "query");
  const query = kvFromObject((querySchema?.example as Record<string, unknown>) ?? {});

  return {
    routeKey: `${route.id}::${method.method}`,
    method: method.method === "ANY" ? "GET" : method.method,
    path: route.path,
    params,
    body,
    query,
    headers: [],
    profile: "",
  };
}

/* ---------------------------------------------------------- localStorage */

const STORAGE_PREFIX = "hoplens:builder:";
const storageKey = (key: string) => `${STORAGE_PREFIX}${key}`;

function readStored(key: string): BuilderState | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.routeKey === key) return parsed as BuilderState;
  } catch {
    /* ignore corruption */
  }
  return null;
}

function writeStored(state: BuilderState): void {
  try {
    localStorage.setItem(storageKey(state.routeKey), JSON.stringify(state));
  } catch {
    /* quota or disabled — silently skip */
  }
}

/* -------------------------------------------- react to route selection */

let tabFor: string | null = null;

// When the selected route changes, swap builder state. Prefer localStorage, else build from schema.
effect(() => {
  const route = activeRoute.value;
  if (!route) {
    builderState.value = null;
    return;
  }
  const key = `${route.route.id}::${route.method.method}`;
  const stored = readStored(key);
  const next = stored ?? initialBuilder(route.route, route.method);
  builderState.value = next;
  // A GET has no body to edit: open on its query (plan 4.2 WP7). Only on a route switch, not when
  // the route list refreshes under the same route.
  if (key !== tabFor) builderTab.value = initialTab(next.method);
  tabFor = key;
});

/** The tab a route opens on: Query for a bodiless method, else Body. */
export function initialTab(method: string): BuilderTab {
  return /^(GET|HEAD|OPTIONS)$/i.test(method) ? "query" : "body";
}

// Persist on every change (lightweight — JSON.stringify of a few KB max).
effect(() => {
  const s = builderState.value;
  if (s) writeStored(s);
});

/* --------------------------------------------------------- mutations */

export function updateBuilder(patch: Partial<BuilderState>): void {
  const s = builderState.value;
  if (!s) return;
  builderState.value = { ...s, ...patch };
}

export function setParam(name: string, value: string): void {
  const s = builderState.value;
  if (!s) return;
  builderState.value = { ...s, params: { ...s.params, [name]: value } };
}

export function setKvRow(target: "query" | "headers", index: number, patch: Partial<KV>): void {
  const s = builderState.value;
  if (!s) return;
  const rows = [...s[target]];
  const current = rows[index];
  if (!current) return;
  rows[index] = { ...current, ...patch };
  builderState.value = { ...s, [target]: rows };
}

export function addKvRow(target: "query" | "headers"): void {
  const s = builderState.value;
  if (!s) return;
  builderState.value = { ...s, [target]: [...s[target], { key: "", value: "", enabled: true }] };
}

export function removeKvRow(target: "query" | "headers", index: number): void {
  const s = builderState.value;
  if (!s) return;
  const rows = s[target].filter((_, i) => i !== index);
  builderState.value = { ...s, [target]: rows };
}

export function resetBuilder(): void {
  const route = activeRoute.value;
  if (!route) return;
  const fresh = initialBuilder(route.route, route.method);
  try {
    localStorage.removeItem(storageKey(fresh.routeKey));
  } catch {}
  builderState.value = fresh;
}

export function formatBody(): void {
  const s = builderState.value;
  if (!s) return;
  try {
    const parsed = JSON.parse(s.body);
    builderState.value = { ...s, body: JSON.stringify(parsed, null, 2) };
  } catch {
    /* keep as-is on parse error */
  }
}

/* ----------------------------------------------------------------- send */

function buildQuery(rows: KV[]): string {
  const parts: string[] = [];
  for (const r of rows) {
    if (!r.enabled || !r.key.trim()) continue;
    parts.push(`${encodeURIComponent(r.key)}=${encodeURIComponent(r.value)}`);
  }
  return parts.join("&");
}

function resolvePath(template: string, params: Record<string, string>): string {
  return template.replace(/:([a-zA-Z_][\w]*)(\+|\*)?/g, (_m, name: string, suffix?: string) => {
    const v = params[name];
    if (!v) return suffix ? "" : `:${name}`;
    // catch-all segments remain as path segments
    return v;
  });
}

/** The builder's fields as a run input (path params filled, enabled query/header rows only). */
export function builderRequest(s: BuilderState): ReplayRequest {
  const resolved = resolvePath(s.path, s.params);
  const qs = buildQuery(s.query);
  const path = qs ? `${resolved}?${qs}` : resolved;
  const headers: Record<string, string> = {};
  for (const h of s.headers) if (h.enabled && h.key.trim()) headers[h.key.trim()] = h.value;
  const method = s.method.toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";
  return {
    method,
    path,
    headers,
    body: canHaveBody && s.body.trim() ? s.body : undefined,
    profile: s.profile || undefined,
  };
}

/** Replay xN of the builder's request (`R` while the builder is open); non-GET asks first. */
export function replayBuilder(n = REPLAY_N): void {
  const s = builderState.value;
  if (!s || !metaState.value || sending.value) return;
  startReplay({ kind: "builder", routeKey: s.routeKey }, builderRequest(s), { n });
}

export async function sendRequest(): Promise<void> {
  const s = builderState.value;
  if (!s || !metaState.value) return;
  sending.value = true;
  sendError.value = null;
  try {
    const result = await api.run(builderRequest(s));
    lastRunResult.value = result;
    if (result.traceId) await loadTrace(result.traceId);
  } catch (err) {
    sendError.value = (err as Error).message;
  } finally {
    sending.value = false;
  }
}

/**
 * Does the open builder dim the subject under it (plan 5: "the builder dims the old trace")? A
 * request or compare that was open before the drawer is not this request's result, so it is shown
 * dimmed until Send replaces it with the builder's own trace. Pure.
 */
export function builderDimsSubject(open: boolean, r: Route, ownTraceId: string | undefined): boolean {
  if (!open) return false;
  if (r.view === "compare") return true;
  return r.view === "trace" && r.traceId !== ownTraceId;
}

/** The live form of `builderDimsSubject`. */
export const builderDims = computed(() =>
  builderDimsSubject(builderOpen.value, route.value, lastRunResult.value?.traceId),
);

export function setBuilderTab(tab: BuilderTab): void {
  builderTab.value = tab;
}
