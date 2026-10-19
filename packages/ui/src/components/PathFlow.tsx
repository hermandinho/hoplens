import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PathFn, PathPayload } from "../api/types";
import { pathMode } from "../state/canvas";
import { register } from "../state/keymap";
import {
  FLOW,
  type FlowEdge,
  type FlowKey,
  type FlowNode,
  type FlowTag,
  allFolds,
  flowEnter,
  flowNav,
  flowStart,
  layoutFlow,
} from "../state/pathFlow";
import { type FromChip, pathPanel } from "../state/pathPanel";

/*
 * The function flowchart (plan P4, mockup C): an SVG of state/pathFlow.ts's layout. Taken edges
 * solid --path-taken with counts, not-run dashed and folded, UNKNOWN hatched with the reason on
 * hover / focus. Roving focus over the nodes: arrows move, Enter follows a callee link or opens a
 * fold, u unfolds everything (again: folds it back). No pan / zoom: the container scrolls sideways,
 * opened on the focused node (the spine at first).
 */

const KEYS = new Set<string>(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);
const ORDER = { not: 0, unknown: 1, taken: 2 } as const;

const live = () => pathMode.value && !!pathPanel.value;

export function PathFlow({
  payload,
  fn,
  line,
  startKey,
  autoFocus,
  onOpen,
}: {
  payload: PathPayload;
  fn: PathFn;
  line?: number;
  /** Node to focus first when drawn (back from a callee: its chip). */
  startKey?: string;
  autoFocus?: boolean;
  onOpen: (fnKey: string, from: FromChip) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const layout = useMemo(() => layoutFlow(payload, fn, { open }), [payload, fn, open]);
  const [cur, setCur] = useState<string | null>(() => (layout ? flowStart(layout, line, startKey) : null));
  const svg = useRef<SVGSVGElement>(null);
  /** After a fold / unfold: the line whose node takes focus once the new layout is drawn. */
  const want = useRef<number | null>(null);
  const focusKey = (k: string | null) => {
    setCur(k);
    const el = k ? svg.current?.querySelector<SVGGElement>(`[data-k="${k}"]`) : null;
    if (!el) return;
    el.focus({ preventScroll: true });
    // Keep the focused node (the spine, at first) in view in the sideways-scrolling box.
    el.scrollIntoView?.({ block: "nearest", inline: "center" });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: first focus once per function
  useEffect(() => {
    if (autoFocus) focusKey(cur);
    else if (cur)
      svg.current
        ?.querySelector<SVGGElement>(`[data-k="${cur}"]`)
        ?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [fn.key]);
  // A toggle unmounts the focused fold / run: move focus to the node now at its line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the layout is redrawn
  useLayoutEffect(() => {
    if (want.current === null || !layout) return;
    const k = flowStart(layout, want.current);
    want.current = null;
    focusKey(k);
  }, [layout]);
  const toggleAll = useRef<() => void>(() => {});
  toggleAll.current = () => {
    const n = layout?.nodes.find((x) => x.key === cur);
    want.current = n?.line ?? null;
    // Anything still folded: open it all; all open already: fold back.
    setOpen(layout?.nodes.some((x) => x.toggle) ? allFolds(payload, fn) : new Set());
  };
  useEffect(
    () =>
      register("canvas", "u", "Unfold everything in the function view (again: fold back)", () => toggleAll.current(), {
        when: live,
        hint: "unfold",
      }),
    [],
  );
  if (!layout) return null;
  const at = layout.nodes.find((n) => n.key === cur) ? cur : (layout.nodes[0]?.key ?? null);
  const act = (n: FlowNode | undefined) => {
    const a = flowEnter(n);
    if (a?.t === "open" && n) {
      const from: FromChip = { key: n.key };
      if (n.line !== undefined) from.line = n.line;
      onOpen(a.fnKey, from);
    } else if (a?.t === "toggle") {
      const next = new Set(open);
      next.add(a.key);
      want.current = n?.line ?? null;
      setOpen(next);
    }
  };
  const edges = [...layout.edges].sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
  return (
    <div class="path-flow" data-own-drag="">
      {open.size > 0 && (
        <button
          type="button"
          class="link-btn path-fold-all"
          title="Fold the opened parts back (u)"
          onClick={() => {
            want.current = layout.nodes.find((x) => x.key === at)?.line ?? null;
            setOpen(new Set());
          }}
        >
          fold again
        </button>
      )}
      <svg ref={svg} class="pf" width={layout.w} height={layout.h} viewBox={`0 0 ${layout.w} ${layout.h}`}>
        <title>{`Flowchart of ${fn.name || "the function"}: arrow keys move between nodes, Enter follows a call or opens a fold`}</title>
        <defs>
          <pattern id="pf-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" class="pf-hatch-line" />
          </pattern>
        </defs>
        {layout.frames.map((f) => (
          <g key={`fr${f.x},${f.y}`} class={`pf-frame pf-${f.tone}`}>
            <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={6} />
            <text x={f.x + 8} y={f.y + 12}>
              {f.label}
            </text>
          </g>
        ))}
        {edges.map((e) => (
          <Edge key={`${e.tone}${e.pts.join(" ")}`} e={e} />
        ))}
        {layout.nodes.map((n) => (
          <Node
            key={n.key}
            n={n}
            current={n.key === at}
            onFocus={() => setCur(n.key)}
            onClick={() => {
              setCur(n.key);
              act(n);
            }}
            onKey={(e) => {
              if (KEYS.has(e.key)) {
                e.preventDefault();
                focusKey(flowNav(layout.nodes, n.key, e.key as FlowKey));
              } else if ((e.key === "Enter" || e.key === " ") && flowEnter(n)) {
                e.preventDefault();
                act(n);
              }
            }}
          />
        ))}
      </svg>
      <p class="path-flow-cap" aria-hidden="true">
        {layout.nodes.find((n) => n.key === at)?.aria}
      </p>
    </div>
  );
}

function Edge({ e }: { e: FlowEdge }) {
  return (
    <g class={`pf-e pf-${e.tone}${e.back ? " pf-back" : ""}`}>
      <polyline points={e.pts.map((p) => p.join(",")).join(" ")} />
      {e.label && (
        <text x={e.label.x} y={e.label.y} text-anchor={e.label.anchor ?? "start"} class="pf-el">
          {e.label.text}
        </text>
      )}
    </g>
  );
}

function Shape({ n }: { n: FlowNode }) {
  const { x, y, w, h } = n;
  if (n.shape === "diamond") {
    const k = 12;
    return (
      <polygon
        class="pf-s"
        points={`${x + k},${y} ${x + w - k},${y} ${x + w},${y + h / 2} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${y + h / 2}`}
      />
    );
  }
  return (
    <rect class="pf-s" x={x} y={y} width={w} height={h} rx={n.shape === "pill" ? h / 2 : n.shape === "chip" ? 4 : 3} />
  );
}

function Node({
  n,
  current,
  onFocus,
  onClick,
  onKey,
}: { n: FlowNode; current: boolean; onFocus: () => void; onClick: () => void; onKey: (e: KeyboardEvent) => void }) {
  const action = !!(n.fnKey || n.toggle);
  const textX = n.shape === "chip" ? n.x + 6 : n.x + FLOW.PAD + (n.shape === "diamond" ? 8 : 0);
  return (
    <>
      <g
        data-k={n.key}
        class={`pf-n pf-${n.tone} pf-k-${n.kind}${n.exitMark ? " pf-exit" : ""}${action ? " pf-act" : ""}`}
        tabIndex={current ? 0 : -1}
        role={n.fnKey && n.kind === "callee" ? "link" : action ? "button" : "img"}
        aria-label={n.aria}
        data-why={n.tone === "unknown" ? n.aria : undefined}
        onFocus={onFocus}
        onClick={onClick}
        onKeyDown={onKey}
      >
        <title>{n.tone === "unknown" ? n.aria : n.full || n.aria}</title>
        <rect class="pf-ring" x={n.x - 3} y={n.y - 3} width={n.w + 6} height={n.h + 6} rx={6} />
        <Shape n={n} />
        <text class="pf-t" x={textX} y={n.y + n.h / 2 + 4}>
          {n.text}
        </text>
        {n.count && (
          <text class="pf-c" x={n.x + n.w - (n.shape === "diamond" ? 16 : 6)} y={n.y + n.h / 2 + 4} text-anchor="end">
            {n.count}
          </text>
        )}
      </g>
      {n.tags?.map((t) => (
        <Tag key={`${t.x},${t.y}`} t={t} />
      ))}
    </>
  );
}

function Tag({ t }: { t: FlowTag }) {
  return (
    <g class={`pf-tag pf-${t.tone}`}>
      <title>{t.title}</title>
      <rect x={t.x} y={t.y} width={t.w} height={FLOW.TAG_H} rx={4} />
      <text x={t.x + 6} y={t.y + FLOW.TAG_H / 2 + 3.5}>
        {t.text}
      </text>
    </g>
  );
}
