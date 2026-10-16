import type { SpanRecord, TraceRecord } from "../src/types";

let seq = 0;

export function span(p: Partial<SpanRecord> & Pick<SpanRecord, "kind">): SpanRecord {
  return { id: `s${++seq}`, name: p.kind, start: 0, end: 0, attrs: {}, ...p };
}

export function db(parentId: string, start: number, end: number, statement: string, extra: Partial<SpanRecord> = {}) {
  return span({ kind: "db", name: "pg.query", parentId, start, end, attrs: { "db.statement": statement }, ...extra });
}

export function fetchSpan(
  parentId: string,
  start: number,
  end: number,
  url: string,
  attrs: Record<string, string | number | boolean> = {},
) {
  return span({
    kind: "fetch",
    name: `fetch GET ${url}`,
    parentId,
    start,
    end,
    attrs: { "url.full": url, "http.method": "GET", ...attrs },
  });
}

export function makeTrace(spans: SpanRecord[], extra: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "tr_test",
    startedAt: 0,
    duration: 100,
    done: true,
    method: "GET",
    url: "/api/products",
    path: "/api/products",
    route: "/api/products",
    kind: "route",
    status: 200,
    request: { headers: {} },
    response: { headers: {} },
    spans,
    logs: [],
    ...extra,
  };
}

/** request root -> handler -> fn, the usual Next shape. */
export function skeleton(duration = 100) {
  const root = span({ kind: "request", name: "GET /api/products", start: 0, end: duration });
  const handler = span({ kind: "handler", parentId: root.id, start: 1, end: duration - 1 });
  const fn = span({
    kind: "function",
    name: "listProducts",
    parentId: handler.id,
    start: 2,
    end: duration - 2,
    location: { file: "src/lib/store.ts", line: 42 },
  });
  return { root, handler, fn };
}
