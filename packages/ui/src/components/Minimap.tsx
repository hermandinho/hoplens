import { useRef, useState } from "preact/hooks";
import type { TimeBucket } from "../api/types";
import type { FlameRect, Range, TimeScale, ViewNode } from "../state/flame";
import { fmtMs } from "../state/stats";

/**
 * Overview strip above the canvas: every flame box of the whole trace at a few px per row, the
 * current viewport as a window, everything outside it shaded. Drag on empty space to brush a range
 * (zooms to it), drag the window to pan, click outside the window to centre it there, double-click
 * to reset. Hand-rolled SVG in a 1000-unit wide viewBox stretched to the width.
 */

const W = 1000;
const H = 28;
/** Below this many px of drag a press is a click, not a brush. */
const DRAG_PX = 4;

export interface MinimapProps {
  rects: readonly FlameRect[];
  rows: number;
  /** Full-range scale (same fold as the canvas). */
  scale: TimeScale;
  /** Current viewport. */
  view: Range;
  total: number;
  hlKeys: ReadonlySet<string>;
  /** Fill bucket for a node (folded groups: their dominant bucket). */
  fill: (n: ViewNode) => TimeBucket;
  /** null = reset to the full range. */
  onRange: (r: Range | null) => void;
}

type Drag =
  | { mode: "brush"; x0: number; x1: number; px0: number }
  | { mode: "pan"; grab: number; view: Range; px0: number; moved: boolean };

export function Minimap({ rects, rows, scale, view, total, hlKeys, fill, onRange }: MinimapProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const rowH = Math.max(1.5, Math.min(5, H / Math.max(1, rows)));
  const hlOn = hlKeys.size > 0;
  const full = view[0] <= 0 && view[1] >= total;
  const vx0 = clamp01(scale.x(view[0])) * W;
  const vx1 = clamp01(scale.x(view[1])) * W;

  const frac = (clientX: number): number => {
    const r = ref.current?.getBoundingClientRect();
    return r && r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0;
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const f = frac(e.clientX);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (!full && f * W >= vx0 && f * W <= vx1) {
      setDrag({ mode: "pan", grab: scale.invert(f), view, px0: e.clientX, moved: false });
    } else setDrag({ mode: "brush", x0: f, x1: f, px0: e.clientX });
  };

  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const f = frac(e.clientX);
    if (drag.mode === "brush") {
      setDrag({ ...drag, x1: f });
      return;
    }
    if (!drag.moved && Math.abs(e.clientX - drag.px0) < DRAG_PX) return;
    const w = drag.view[1] - drag.view[0];
    const lo = Math.max(0, Math.min(total - w, drag.view[0] + (scale.invert(f) - drag.grab)));
    setDrag({ ...drag, moved: true });
    onRange([lo, lo + w]);
  };

  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    setDrag(null);
    if (drag.mode === "pan") return;
    const f = frac(e.clientX);
    if (Math.abs(e.clientX - drag.px0) >= DRAG_PX) {
      const a = scale.invert(Math.min(drag.x0, f));
      const b = scale.invert(Math.max(drag.x0, f));
      onRange([a, b]);
    } else if (!full) {
      // A click outside the window centres the window there.
      const w = view[1] - view[0];
      const lo = Math.max(0, Math.min(total - w, scale.invert(f) - w / 2));
      onRange([lo, lo + w]);
    }
  };

  const brush = drag?.mode === "brush" && Math.abs(drag.x1 - drag.x0) > 0 ? drag : null;

  return (
    <div class="tc-minimap">
      <svg
        ref={ref}
        class={`tc-mm ${drag?.mode === "pan" ? "tc-mm-panning" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Trace overview, showing ${fmtMs(view[0])} to ${fmtMs(view[1])} of ${fmtMs(total)}. Drag to zoom, double-click to reset.`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
        onDblClick={() => onRange(null)}
      >
        <title>Drag to zoom, drag the window to pan, double-click to show the full range</title>
        {scale.fold && (
          <rect class="tc-mm-fold" x={scale.x(scale.fold.a) * W} y={0} width={scale.fold.share * W} height={H} />
        )}
        {rects.map((r) => {
          const n = r.node;
          const x0 = scale.x(n.start) * W;
          const w = Math.max(0.6, scale.x(n.end) * W - x0);
          const y = r.row * rowH;
          if (y >= H) return null;
          const dim = hlOn && !hlKeys.has(n.key);
          return (
            <rect
              key={n.key}
              class={`tc-mm-r mm-${fill(n)} ${dim ? "tc-mm-dim" : ""}`}
              x={x0}
              y={y}
              width={w}
              height={Math.max(1, rowH - 0.5)}
            />
          );
        })}
        {!full && (
          <>
            <rect class="tc-mm-shade" x={0} y={0} width={vx0} height={H} />
            <rect class="tc-mm-shade" x={vx1} y={0} width={W - vx1} height={H} />
            <rect
              class="tc-mm-window"
              x={vx0}
              y={0.5}
              width={Math.max(1, vx1 - vx0)}
              height={H - 1}
              vector-effect="non-scaling-stroke"
            />
          </>
        )}
        {brush && (
          <rect
            class="tc-mm-brush"
            x={Math.min(brush.x0, brush.x1) * W}
            y={0.5}
            width={Math.abs(brush.x1 - brush.x0) * W}
            height={H - 1}
            vector-effect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
