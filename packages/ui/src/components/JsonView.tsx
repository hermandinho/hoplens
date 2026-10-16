import { useState } from "preact/hooks";

/**
 * Compact, zero-dep JSON tree renderer with:
 *  - syntax highlighting (keys / strings / numbers / booleans / null)
 *  - collapsible objects and arrays, auto-collapsed past a size threshold
 *  - deep-link to a key via a tiny "copy path" affordance in the hover state
 *
 * Used anywhere we previously called JSON.stringify(x, null, 2) and dumped it
 * into a <pre>. Falls back cleanly for strings (shown verbatim) and non-JSON
 * primitives.
 */

interface Props {
  value: unknown;
  /** Visual indent, in px, per nesting level. Default 14. */
  indent?: number;
  /** Collapse objects/arrays with more than this many entries. Default 6. */
  initialCollapseAt?: number;
  /** Hard cap on preview width (used only when a leaf is huge). */
  maxLeafChars?: number;
}

export function JsonView({ value, indent = 14, initialCollapseAt = 6, maxLeafChars = 2000 }: Props) {
  // If it isn't JSON-ish (string we couldn't parse, raw text), show as-is.
  if (typeof value === "string") {
    return <pre class="jv-root mono jv-text">{truncate(value, maxLeafChars)}</pre>;
  }
  return (
    <div class="jv-root mono" role="tree">
      <Node value={value} depth={0} indent={indent} collapseAt={initialCollapseAt} maxLeafChars={maxLeafChars} />
    </div>
  );
}

interface NodeProps {
  value: unknown;
  depth: number;
  indent: number;
  collapseAt: number;
  maxLeafChars: number;
  path?: string;
}

function Node({ value, depth, indent, collapseAt, maxLeafChars, path }: NodeProps) {
  if (value === null) return <span class="jv-null">null</span>;
  if (value === undefined) return <span class="jv-null">undefined</span>;
  const t = typeof value;
  if (t === "string") {
    const s = truncate(value as string, maxLeafChars);
    return (
      <span class="jv-str" title={path}>
        "{escapeString(s)}"
      </span>
    );
  }
  if (t === "number") return <span class="jv-num">{String(value)}</span>;
  if (t === "boolean") return <span class="jv-bool">{String(value)}</span>;
  if (t === "bigint") return <span class="jv-num">{String(value)}n</span>;
  if (Array.isArray(value)) {
    return (
      <Container
        kind="array"
        entries={value.map((v, i) => [String(i), v] as [string, unknown])}
        depth={depth}
        indent={indent}
        collapseAt={collapseAt}
        maxLeafChars={maxLeafChars}
        path={path}
      />
    );
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <Container
        kind="object"
        entries={entries}
        depth={depth}
        indent={indent}
        collapseAt={collapseAt}
        maxLeafChars={maxLeafChars}
        path={path}
      />
    );
  }
  return <span class="jv-str">{String(value)}</span>;
}

interface ContainerProps {
  kind: "object" | "array";
  entries: [string, unknown][];
  depth: number;
  indent: number;
  collapseAt: number;
  maxLeafChars: number;
  path?: string;
}

function Container({ kind, entries, depth, indent, collapseAt, maxLeafChars, path }: ContainerProps) {
  const [open, setOpen] = useState(() => entries.length <= collapseAt && depth < 3);
  const open_ = kind === "array" ? "[" : "{";
  const close_ = kind === "array" ? "]" : "}";

  if (entries.length === 0) {
    return (
      <span class="jv-empty">
        {open_}
        {close_}
      </span>
    );
  }

  if (!open) {
    return (
      <span class="jv-collapsed">
        <button type="button" class="jv-toggle" onClick={() => setOpen(true)} aria-label="Expand">
          ▸
        </button>
        <span class="jv-brace">{open_}</span>
        <span class="jv-count"> {entries.length} </span>
        <span class="jv-brace">{close_}</span>
      </span>
    );
  }

  return (
    <span class="jv-container">
      <button type="button" class="jv-toggle jv-toggle-open" onClick={() => setOpen(false)} aria-label="Collapse">
        ▾
      </button>
      <span class="jv-brace">{open_}</span>
      <ul class="jv-list" style={{ paddingLeft: `${indent}px` }}>
        {entries.map(([k, v], i) => {
          const childPath = path ? (kind === "array" ? `${path}[${k}]` : `${path}.${k}`) : k;
          return (
            <li key={childPath} class="jv-row">
              {kind === "object" ? (
                <>
                  <span class="jv-key">"{escapeString(k)}"</span>
                  <span class="jv-colon">: </span>
                </>
              ) : (
                <span class="jv-key jv-index">{k}: </span>
              )}
              <Node
                value={v}
                depth={depth + 1}
                indent={indent}
                collapseAt={collapseAt}
                maxLeafChars={maxLeafChars}
                path={childPath}
              />
              {i < entries.length - 1 && <span class="jv-comma">,</span>}
            </li>
          );
        })}
      </ul>
      <span class="jv-brace">{close_}</span>
    </span>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (+${s.length - max} chars)`;
}

function escapeString(s: string): string {
  // Keep the output printable but valid-looking.
  return s.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
