import { batch, computed, signal } from "@preact/signals";
import type { HopKind, SpanRecord, TraceRecord } from "../api/types";
import { selectedTrace } from "./store";

/* -------------------------------------------------------- layout types */

export type HopLane = "main" | "call";

export interface Hop {
  id: string;
  kind: HopKind;
  name: string;
  file?: string;
  line?: number;
  start: number;
  end: number;
  /** Normalised [0,1] relative to total trace duration — used to animate the packet. */
  tStart: number;
  tEnd: number;
  lane: HopLane;
  /** Grid column for main-lane hops; depth level for call hops. */
  col: number;
  /** Row (0 = main lane, 1+ = calls underneath). */
  row: number;
  span: SpanRecord;
}

export interface Journey {
  trace: TraceRecord;
  hops: Hop[];
  mainHops: Hop[];
  callHops: Hop[];
  duration: number;
}

/* ------------------------------------------------------ hop ordering */

/** Order in which main-lane kinds appear left→right. */
const MAIN_ORDER: HopKind[] = ["request", "proxy", "router", "handler", "response"];
const CALL_KINDS = new Set<HopKind>(["function", "fetch", "db", "custom", "render"]);

export const journey = computed<Journey | null>(() => {
  const t = selectedTrace.value;
  if (!t) return null;

  const spans = [...t.spans].sort((a, b) => a.start - b.start);
  const duration = Math.max(1, ...spans.map((s) => s.end));

  // Pick ONE representative per main kind — collapse multiple router spans etc.
  const mainBuckets = new Map<HopKind, SpanRecord>();
  for (const kind of MAIN_ORDER) {
    const match = spans.find((s) => s.kind === kind);
    if (match) mainBuckets.set(kind, match);
  }

  // Synthesise a client node when no proxy present — graph always starts somewhere.
  const client: Hop = {
    id: "client",
    kind: "request",
    name: t.runId ? "Hoplens" : "Client",
    start: 0,
    end: 0,
    tStart: 0,
    tEnd: 0,
    lane: "main",
    col: 0,
    row: 0,
    span: {
      id: "client",
      name: "Client",
      kind: "request",
      start: 0,
      end: 0,
      attrs: {},
    },
  };

  let col = 1;
  const mainHops: Hop[] = [client];
  for (const kind of MAIN_ORDER) {
    const s = mainBuckets.get(kind);
    if (!s) continue;
    mainHops.push({
      id: s.id,
      kind: s.kind,
      name: labelForMain(s, t),
      file: s.location?.file,
      line: s.location?.line,
      start: s.start,
      end: s.end,
      tStart: s.start / duration,
      tEnd: s.end / duration,
      lane: "main",
      col: col++,
      row: 0,
      span: s,
    });
  }

  // Calls hang below the handler as a flat list for now; later we can nest by parentId.
  const callHops: Hop[] = [];
  let row = 1;
  for (const s of spans) {
    if (!CALL_KINDS.has(s.kind)) continue;
    callHops.push({
      id: s.id,
      kind: s.kind,
      name: s.name,
      file: s.location?.file,
      line: s.location?.line,
      start: s.start,
      end: s.end,
      tStart: s.start / duration,
      tEnd: s.end / duration,
      lane: "call",
      col: 0,
      row: row++,
      span: s,
    });
  }

  return { trace: t, hops: [...mainHops, ...callHops], mainHops, callHops, duration };
});

function labelForMain(s: SpanRecord, t: TraceRecord): string {
  if (s.kind === "request") return `${t.method} ${t.route ?? t.path}`;
  if (s.kind === "proxy") return "proxy";
  if (s.kind === "router") return "router";
  if (s.kind === "handler") return "handler";
  if (s.kind === "response") return `response ${t.status ?? ""}`.trim();
  return s.name;
}

/* ---------------------------------------------------------- playback */

export const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEED_OPTIONS)[number];

export const playing = signal(false);
export const speed = signal<Speed>(1);
export const currentTime = signal(0); // in [0, duration]
export const selectedHopId = signal<string | null>(null);

export const normalisedTime = computed(() => {
  const d = journey.value?.duration ?? 1;
  return Math.min(1, Math.max(0, currentTime.value / d));
});

export function play(): void {
  const j = journey.value;
  if (!j) return;
  if (currentTime.value >= j.duration) currentTime.value = 0;
  playing.value = true;
}

export function pause(): void {
  playing.value = false;
}

export function togglePlay(): void {
  playing.value ? pause() : play();
}

export function stepBy(ms: number): void {
  const j = journey.value;
  if (!j) return;
  currentTime.value = Math.min(j.duration, Math.max(0, currentTime.value + ms));
}

export function seekTo(ms: number): void {
  const j = journey.value;
  if (!j) return;
  currentTime.value = Math.min(j.duration, Math.max(0, ms));
}

export function setSpeed(s: Speed): void {
  speed.value = s;
}

export function selectHop(id: string | null): void {
  selectedHopId.value = id;
}

/** Reset playback when a new trace is loaded. */
export function resetPlayback(): void {
  batch(() => {
    currentTime.value = 0;
    playing.value = false;
    selectedHopId.value = null;
  });
}
