import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PathPayload, PathTraceStamp, TraceRecord } from "../api/types";
import { pathMode } from "../state/canvas";
import { register } from "../state/keymap";
import {
  PATH_COST_NOTE,
  PHASES,
  PHASE_TEXT,
  type PathChip,
  type PathErrorView,
  type PathSwitch,
  QUALITY,
  type TrailRow,
  enterOpensLane,
  envFootText,
  laneCursor,
  loadPath,
  methodBlock,
  offView,
  pathAnnounce,
  pathFailure,
  pathFocus,
  pathJob,
  pathLoad,
  pathPayloads,
  pathReady,
  pathSwitch,
  pathSwitchJob,
  restartNote,
  retryLoadPath,
  runTracePath,
  setPathEnabled,
  trailModel,
  trailSummary,
  verdictModel,
} from "../state/path";
import { panelDo, pathPanel } from "../state/pathPanel";
import { openSourceAt } from "../state/source";
import { frameworkCopy, loadTrace, metaState } from "../state/store";
import "../styles/path.css";
import { PathFunction } from "./PathFunction";

/*
 * Path mode of the Journey pane (plan P3, mockup B): on a normal trace, the Trace path action (or why
 * it is off); on a path trace, its quality, the verdict line and the decision trail. Everything shown
 * as taken / not reached / UNKNOWN comes from the server's analysis (state/path.ts).
 */

export function PathPane({ trace, stamp }: { trace: TraceRecord; stamp?: PathTraceStamp }) {
  // Keyed per trace: the trail's cursor and open lists belong to one path trace. The live region
  // stays mounted across traces so 'Path traced' is announced.
  return (
    <div class="path-pane" data-key-scope="canvas">
      <output class="sr-only" aria-live="polite">
        {pathAnnounce.value}
      </output>
      {stamp ? (
        <PathTraceView key={trace.id} trace={trace} stamp={stamp} />
      ) : (
        <TracePathAction key={trace.id} trace={trace} />
      )}
      <SwitchFooter />
    </div>
  );
}

/* ------------------------------------------------------------ normal trace */

function TracePathAction({ trace }: { trace: TraceRecord }) {
  const off = offView(metaState.value, frameworkCopy.value.isNext);
  const job = pathJob.value;
  const fail = pathFailure.value?.sourceId === trace.id ? pathFailure.value.view : null;
  if (off) {
    const sw = metaState.value?.path?.state === "off" ? pathSwitch(metaState.value) : null;
    return <OffState title={off.title} body={off.body} command={off.command} commandNote={off.commandNote} sw={sw} />;
  }
  const blocked = methodBlock(trace.method);
  const running = job?.sourceId === trace.id;
  const ready = pathReady.value?.sourceId === trace.id ? pathReady.value.traceId : null;
  return (
    <div class="path-empty">
      <p class="path-lede">
        See which side of every <span class="mono">if</span>, <span class="mono">switch</span> and loop this request
        took, from V8's block counts.
      </p>
      <div class="path-action">
        <button
          type="button"
          class="sbtn path-go"
          disabled={!!blocked || !!job}
          title={blocked ?? (job ? "A path capture is running" : "Replays this request once, alone, as a new trace")}
          onClick={() => void runTracePath(trace)}
        >
          Trace path
        </button>
        <span class="dim">-- replays this request once, alone</span>
      </div>
      {blocked && <p class="path-note">{blocked}.</p>}
      {running && job && <Progress phase={job.phase} />}
      {fail && !running && <ErrorBox view={fail} onRetry={() => void runTracePath(trace)} />}
      {ready && !running && (
        <p class="path-note">
          Path ready:{" "}
          <button
            type="button"
            class="link-btn mono"
            onClick={() => {
              pathReady.value = null;
              pathFocus.value = ready;
              void loadTrace(ready, "user");
            }}
          >
            open {ready}
          </button>
        </p>
      )}
    </div>
  );
}

function Progress({ phase }: { phase: (typeof PHASES)[number] }) {
  const at = PHASES.indexOf(phase);
  return (
    <ol class="path-phases" aria-live="polite" aria-label={`Trace path: ${PHASE_TEXT[phase]}`}>
      {PHASES.map((p, i) => (
        <li
          key={p}
          class={i < at ? "done" : i === at ? "now" : ""}
          aria-current={i === at ? "step" : undefined}
          title={PHASE_TEXT[p]}
        >
          {p}
          {i === at ? "..." : ""}
        </li>
      ))}
    </ol>
  );
}

function ErrorBox({ view, onRetry }: { view: PathErrorView; onRetry?: () => void }) {
  return (
    <div class="path-error" role="alert">
      <b>{view.title}</b>
      {view.detail && <div class="muted">{view.detail}</div>}
      {view.list && (
        <ul class="path-inflight mono">
          {view.list.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div class="path-error-actions">
        {view.retry && onRetry && (
          <button type="button" class="sbtn" onClick={onRetry}>
            Retry
          </button>
        )}
        {view.link && (
          <button type="button" class="link-btn" onClick={() => void loadTrace(view.link!.traceId, "user")}>
            {view.link.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** The sticky switch: Enable (off) or its pending note. Inline in the off state (HOPLENS_PATH: none). */
function SwitchControls({ sw }: { sw: PathSwitch }) {
  const job = pathSwitchJob.value;
  const error = job.error && (
    <p class="path-note path-switch-error" role="alert">
      {job.error}
    </p>
  );
  switch (sw.kind) {
    case "enable":
      return (
        <>
          <div class="path-action">
            <button
              type="button"
              class="sbtn path-go"
              disabled={job.busy}
              onClick={() => void setPathEnabled(true)}
              title="Writes a flag in Hoplens' state dir; the next start of the dev server reads it"
            >
              Enable request path
            </button>
            <span class="dim">-- {PATH_COST_NOTE}</span>
          </div>
          {error}
        </>
      );
    case "pending-on":
      return (
        <>
          <output class="path-note path-pending">
            <span class="path-badge path-badge-pending">on at next start</span>{" "}
            {restartNote(frameworkCopy.value.isNext)}.{" "}
            <button type="button" class="link-btn" disabled={job.busy} onClick={() => void setPathEnabled(false)}>
              Undo
            </button>
          </output>
          {error}
        </>
      );
    default:
      // env: the off state's title already says HOPLENS_PATH decides; the footer covers the rest.
      return null;
  }
}

/** Under the pane when the path is not plain off: Disable (on via the flag) or who decided. */
function SwitchFooter() {
  const meta = metaState.value;
  const sw = pathSwitch(meta);
  // Plain off: the off state carries the switch. Enable / pending-on only arise there.
  if (!sw || meta?.path?.state === "off" || sw.kind === "enable" || sw.kind === "pending-on") return null;
  const job = pathSwitchJob.value;
  return (
    <div class="path-switch-foot">
      {sw.kind === "env" && <span class="dim">{envFootText(meta?.path?.state)}</span>}
      {sw.kind === "disable" && (
        <span class="dim">
          Request path: on (enabled here).{" "}
          <button
            type="button"
            class="link-btn"
            disabled={job.busy}
            title="Removes the flag; the next start runs without block coverage"
            onClick={() => void setPathEnabled(false)}
          >
            Disable
          </button>
        </span>
      )}
      {sw.kind === "pending-off" && (
        <output class="path-pending">
          <span class="path-badge path-badge-pending">off at next start</span>{" "}
          <span class="dim">{restartNote(frameworkCopy.value.isNext)}.</span>{" "}
          <button type="button" class="link-btn" disabled={job.busy} onClick={() => void setPathEnabled(true)}>
            Keep it on
          </button>
        </output>
      )}
      {job.error && (
        <p class="path-note path-switch-error" role="alert">
          {job.error}
        </p>
      )}
    </div>
  );
}

function OffState({
  title,
  body,
  command,
  commandNote,
  sw,
}: { title: string; body: string; command?: string; commandNote?: string; sw?: PathSwitch | null }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  return (
    <div class="path-empty">
      <b class="path-off-title">{title}</b>
      <p class="muted">{body}</p>
      {sw && <SwitchControls sw={sw} />}
      {command && (commandNote || sw?.kind === "enable") && (
        <span class="path-note">{commandNote ?? "Or set it in the dev server's shell:"}</span>
      )}
      {command && sw?.kind !== "pending-on" && (
        <div class="path-cmd">
          <code class="mono">{command}</code>
          <button
            type="button"
            class="sbtn"
            onClick={() => {
              const done = (r: "ok" | "fail") => setCopied(r);
              try {
                navigator.clipboard.writeText(command).then(
                  () => done("ok"),
                  () => done("fail"),
                );
              } catch {
                done("fail");
              }
            }}
          >
            {copied === "ok" ? "Copied" : "Copy"}
          </button>
          {copied === "fail" && <span class="dim">select the line and copy it</span>}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- path trace */

function PathTraceView({ trace, stamp }: { trace: TraceRecord; stamp: PathTraceStamp }) {
  const payload = pathPayloads.value.get(trace.id);
  const load = pathLoad.value.get(trace.id);
  const failed = stamp.failed || stamp.supersededBy;
  useEffect(() => {
    if (!payload && !stamp.failed) void loadPath(trace.id);
  }, [trace.id, payload, stamp.failed]);
  const q = QUALITY[payload?.quality ?? stamp.quality];
  return (
    <>
      <div class="path-badges">
        <span class="path-badge">path trace</span>
        {!failed && (
          <span class={`path-badge path-q-${payload?.quality ?? stamp.quality}`} title={q.title}>
            {q.label}
          </span>
        )}
        <button type="button" class="link-btn mono" onClick={() => void loadTrace(stamp.replayOf, "user")}>
          replay of {stamp.replayOf}
        </button>
      </div>
      {stamp.failed ? (
        <ErrorBox
          view={{
            code: stamp.failed,
            title: "The capture failed after this replay ran",
            detail: `No path was kept (${stamp.failed}). Trace path the source request again.`,
            retry: false,
            link: { label: "open the source request", traceId: stamp.replayOf },
          }}
        />
      ) : payload ? (
        <PathBody payload={payload} />
      ) : load && load !== "loading" ? (
        <ErrorBox view={load} onRetry={() => retryLoadPath(trace.id)} />
      ) : (
        <div class="path-note dim">loading the path...</div>
      )}
    </>
  );
}

function PathBody({ payload }: { payload: PathPayload }) {
  const model = useMemo(() => trailModel(payload), [payload]);
  const v = verdictModel(payload);
  const notes = [...payload.contamination.map((c) => `contaminated: ${c}`), ...payload.warnings];
  const panel = pathPanel.value?.traceId === payload.traceId ? pathPanel.value : null;
  // Opening another path trace closes the panel of the last one.
  useEffect(() => {
    if (pathPanel.peek() && pathPanel.peek()!.traceId !== payload.traceId) panelDo({ t: "close" });
  }, [payload.traceId]);
  const open = (fnKey: string | undefined, file?: string, line?: number) => {
    if (fnKey && payload.functions[fnKey]) panelDo({ t: "open", traceId: payload.traceId, fnKey, line });
    else openAt(file, line);
  };
  return (
    <div class={`path-split${panel ? " has-panel" : ""}`}>
      <div class="path-split-trail">
        {v.at ? (
          <button
            type="button"
            class={`path-verdict path-v-${v.tone}`}
            title="Open the exit's source"
            onClick={() => openSourceAt(v.at!.file, v.at!.line)}
          >
            {v.text}
          </button>
        ) : (
          <p class={`path-verdict path-v-${v.tone}`}>{v.text}</p>
        )}
        <div class="path-sub dim">{trailSummary(model)}</div>
        {notes.length > 0 && (
          <ul class="path-warnings" aria-label="Capture warnings">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <Trail key={payload.traceId} traceId={payload.traceId} rows={model.rows} open={open} panelOpen={!!panel} />
      </div>
      {panel && <PathFunction payload={payload} state={panel} />}
    </div>
  );
}

/** The trail is hidden behind the panel (narrower than the split view). */
function trailHidden(): boolean {
  return !!pathPanel.value && !(typeof matchMedia === "function" && matchMedia("(min-width: 1100px)").matches);
}

/* -------------------------------------------------------------------- trail */

function openAt(file: string | undefined, line: number | undefined): void {
  if (file && line) openSourceAt(file, line);
}

type OpenFn = (fnKey: string | undefined, file?: string, line?: number) => void;

function Trail({
  rows,
  traceId,
  open: openFn,
  panelOpen,
}: { rows: TrailRow[]; traceId: string; open: OpenFn; panelOpen: boolean }) {
  const [rawCursor, setCursor] = useState(0);
  const cursor = laneCursor(rawCursor, rows.length);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLOListElement>(null);
  const state = useRef({ rows, cursor, openFn });
  state.current = { rows, cursor, openFn };
  // Back from the panel: focus returns to the lane it was opened from.
  const wasOpen = useRef(panelOpen);
  useEffect(() => {
    if (wasOpen.current && !panelOpen)
      listRef.current?.querySelectorAll<HTMLElement>(".path-lane-name")[state.current.cursor]?.focus();
    wasOpen.current = panelOpen;
  }, [panelOpen]);
  // After Trace path (or x on a path trace), the trail takes focus so j / k reach the lanes.
  const focusFor = pathFocus.value;
  useEffect(() => {
    if (focusFor !== traceId) return;
    pathFocus.value = null;
    listRef.current?.querySelectorAll<HTMLElement>(".path-lane-name")[state.current.cursor]?.focus();
  }, [focusFor, traceId]);

  useEffect(() => {
    const focusRow = (i: number) => {
      const n = Math.max(0, Math.min(state.current.rows.length - 1, i));
      setCursor(n);
      listRef.current?.querySelectorAll<HTMLElement>(".path-lane-name")[n]?.focus();
    };
    const opts = { when: () => pathMode.value && !trailHidden(), hint: "lane" };
    const offs = [
      register("canvas", "j", "Next lane of the path", () => focusRow(state.current.cursor + 1), opts),
      register("canvas", "k", "Previous lane of the path", () => focusRow(state.current.cursor - 1), opts),
      register(
        "canvas",
        "Enter",
        "Open the lane's function (flowchart / source)",
        () => {
          const r = state.current.rows[state.current.cursor];
          state.current.openFn(r?.fnKey, r?.file, r?.line);
        },
        // Only from a lane name: a chip, '+N not reached', the verdict or a link keeps its own Enter.
        { when: (e) => pathMode.value && !trailHidden() && (!e || enterOpensLane(e.target)), hint: "open" },
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  if (!rows.length) return <p class="path-note dim">No function or handler hops were recorded for this request.</p>;
  return (
    <ol class="path-trail" ref={listRef} aria-label="Request path: one lane per function hop, in span order">
      {rows.map((r, i) => (
        <Lane
          key={r.key}
          row={r}
          tabbable={i === cursor}
          seeName={r.seeRow ? rows.find((x) => x.key === r.seeRow)?.name : undefined}
          open={open.has(r.key)}
          openFn={openFn}
          onFocus={() => setCursor(i)}
          onToggle={() => {
            const next = new Set(open);
            if (next.has(r.key)) next.delete(r.key);
            else next.add(r.key);
            setOpen(next);
          }}
        />
      ))}
    </ol>
  );
}

function Lane({
  row,
  tabbable,
  seeName,
  open,
  openFn,
  onFocus,
  onToggle,
}: {
  row: TrailRow;
  tabbable: boolean;
  seeName?: string;
  open: boolean;
  openFn: OpenFn;
  onFocus: () => void;
  onToggle: () => void;
}) {
  const go = (line?: number) => openFn(row.fnKey, row.file, line ?? row.line);
  const calls = row.hops > 1 ? `x${row.hops}` : `x${row.calls}`;
  const where = row.file ? `${row.file}${row.line ? `:${row.line}` : ""}` : "";
  return (
    <li class="path-lane" style={{ "--depth": Math.min(row.depth, 8) }}>
      <div class="path-lane-head">
        <button
          type="button"
          class="path-lane-name mono"
          tabIndex={tabbable ? 0 : -1}
          onFocus={onFocus}
          onClick={() => go()}
          aria-label={`${row.kind} ${row.name}${where ? ` at ${where}` : ""}, ${calls}${row.threw ? ", threw" : ""}. ${row.fnKey ? "Opens its flowchart and source." : "Opens the source."}`}
        >
          <span aria-hidden="true">&gt; </span>
          {row.name}
        </button>
        {where && <span class="path-lane-file mono dim">{where}</span>}
        <span
          class="path-lane-calls mono dim"
          title={`${row.calls} hop${row.calls === 1 ? "" : "s"} of this function in the trace`}
        >
          {calls}
        </span>
        {row.blended && (
          <span
            class="path-blend"
            title="This function ran more than once: its counts are totals over every call, not one call's path"
          >
            {row.coverageCalls ?? row.calls} calls: totals
          </span>
        )}
        {row.threw && <span class="path-threw">threw</span>}
      </div>
      {(row.truncated || row.fnWarnings) && !row.seeRow && (
        <ul class="path-lane-notes">
          {row.truncated && (
            <li>
              <span class="pt-chip pt-chip-unknown">? truncated</span> too large to map whole: decisions past the cap
              are not shown (UNKNOWN)
            </li>
          )}
          {row.fnWarnings?.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div class="pt-chips">
        {row.seeRow ? (
          <span class="dim">same function as {seeName ?? "above"}: its chips are shown there (totals)</span>
        ) : row.unknown ? (
          <Chip
            chip={{
              id: "fn",
              kind: "fn",
              text: "?",
              title: `UNKNOWN: ${row.unknown}`,
              tone: "unknown",
              line: row.line,
            }}
            go={go}
            label={row.unknown}
          />
        ) : (
          <>
            {row.chips.map((c) => (
              <Chip key={c.id} chip={c} go={go} />
            ))}
            {row.notReached.length > 0 && (
              <button type="button" class="path-more" aria-expanded={open} onClick={onToggle}>
                {open ? "- hide not reached" : `+${row.notReached.length} not reached`}
              </button>
            )}
            {open && row.notReached.map((c) => <Chip key={c.id} chip={c} go={go} />)}
            {!row.chips.length && !row.notReached.length && !row.truncated && <span class="dim">no decisions</span>}
          </>
        )}
      </div>
    </li>
  );
}

function Chip({ chip, go, label }: { chip: PathChip; go: (line?: number) => void; label?: string }) {
  return (
    <button
      type="button"
      class={`pt-chip pt-chip-${chip.tone}${chip.exit ? " pt-chip-exit" : ""}`}
      title={chip.title}
      data-why={chip.tone === "unknown" ? chip.title : undefined}
      aria-label={`${chip.title}${chip.line ? `. Opens its function at line ${chip.line}.` : ""}`}
      onClick={() => go(chip.line)}
    >
      {chip.tone === "unknown" && chip.text !== "?" && <span aria-hidden="true">? </span>}
      {chip.text}
      {label && <span class="pt-chip-why"> {label}</span>}
    </button>
  );
}
