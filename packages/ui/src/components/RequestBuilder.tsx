import { useEffect } from "preact/hooks";
import {
  activeBodySchema,
  activeQuerySchema,
  activeRoute,
  addKvRow,
  builderState,
  builderTab,
  formatBody,
  lastRunResult,
  removeKvRow,
  replayBuilder,
  resetBuilder,
  sendError,
  sendRequest,
  sending,
  setBuilderTab,
  setKvRow,
  setParam,
  updateBuilder,
} from "../state/builder";
import { register } from "../state/keymap";
import { REPLAY_N, isRunning, replayBusy } from "../state/replay";
import { builderOpen, metaState } from "../state/store";
import { BuilderReplayPanel } from "./ReplayPanel";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

// The shortcut accepts both modifiers; the hint shows the one this platform's users expect.
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const SEND_KEYS = IS_MAC ? "⌘↵" : "Ctrl+↵";

export function RequestBuilder() {
  const route = activeRoute.value;
  const s = builderState.value;
  const tab = builderTab.value;
  const meta = metaState.value;
  const isSending = sending.value;
  const err = sendError.value;
  const run = lastRunResult.value;
  const replaying = replayBusy(); // a Changes x10 batch blocks it too (replayBuilder returns early)

  // Register ⌘/Ctrl+Enter globally while builder is mounted.
  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        if (builderState.value && !sending.value) void sendRequest();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // R: replay the builder's request x10 (the trace's own R stands down while the drawer is open).
  // Registered only while a route is picked, so the cheatsheet and palette offer it only then.
  const hasRoute = !!s;
  useEffect(() => {
    if (!hasRoute) return;
    return register("global", "R", `Replay the builder's request x${REPLAY_N}`, () => replayBuilder(), {
      when: () => builderOpen.peek() && !!builderState.peek() && !sending.peek() && !isRunning(),
      hint: `replay x${REPLAY_N}`,
    });
  }, [hasRoute]);

  if (!route || !s) {
    return (
      <div class="builder-empty">
        <b>Pick a route to start</b>
        Select a method tag in the Routes sidebar. Hoplens pre-fills bodies from Zod schemas when it finds them.
      </div>
    );
  }

  const profiles = Object.entries(meta?.profiles ?? {});

  return (
    <div class="builder">
      <div class="urlbar">
        <label class="sr-only" for="builder-method">
          Method
        </label>
        <select
          id="builder-method"
          class={`method-select m-${s.method}`}
          value={s.method}
          onChange={(e) => updateBuilder({ method: (e.target as HTMLSelectElement).value })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <div class="url">
          <PathWithParams path={s.path} params={s.params} onParam={setParam} />
        </div>

        <button type="button" class="send" onClick={() => void sendRequest()} disabled={isSending}>
          {isSending ? "Sending…" : "Send"}
          <kbd class="send-kbd">{SEND_KEYS}</kbd>
        </button>
        <button
          type="button"
          class="sbtn builder-replay"
          onClick={() => replayBuilder()}
          disabled={isSending || replaying}
          title={`Send this request ${REPLAY_N} times in a row: warm p50/p95, cold runs left out, vs last run`}
        >
          <kbd class="rp-kbd">R</kbd> Replay x{REPLAY_N}
        </button>
      </div>

      <div class="builder-tabs" role="tablist" aria-label="Request fields">
        {(["body", "query", "headers", "auth"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`builder-tab-${t}`}
            aria-controls="builder-panel"
            class={`builder-tab ${tab === t ? "active" : ""}`}
            aria-selected={tab === t}
            onClick={() => setBuilderTab(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
            {t === "body" && activeBodySchema.value && <span class="zod-dot" aria-label="Zod schema detected" />}
            {t === "query" && activeQuerySchema.value && <span class="zod-dot" aria-label="Zod schema detected" />}
          </button>
        ))}
      </div>

      <div id="builder-panel" class="builder-body" role="tabpanel" aria-labelledby={`builder-tab-${tab}`}>
        {tab === "body" && <BodyPane />}
        {tab === "query" && <KvPane target="query" rows={s.query} />}
        {tab === "headers" && <KvPane target="headers" rows={s.headers} />}
        {tab === "auth" && <AuthPane profiles={profiles} value={s.profile} />}
      </div>

      {(err || run) && (
        <output class={`run-status ${err ? "run-status-err" : ""}`}>
          {err ? (
            <>
              <b>Send failed:</b> {err}
            </>
          ) : run?.error ? (
            <>
              <b>502:</b> {run.error}
            </>
          ) : run ? (
            <>
              <b>{run.status}</b>
              {run.traceId && <span class="dim mono"> trace {run.traceId}</span>}
              <span class="dim mono"> {run.elapsed}ms</span>
            </>
          ) : null}
        </output>
      )}
      <BuilderReplayPanel routeKey={s.routeKey} />
    </div>
  );
}

/* ----------------------------------------------------------- components */

function PathWithParams({
  path,
  params,
  onParam,
}: {
  path: string;
  params: Record<string, string>;
  onParam: (name: string, value: string) => void;
}) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((p, i) => {
        const key = `${i}-${p}`;
        if (!p)
          return i > 0 ? (
            <span key={key} class="path-sep">
              /
            </span>
          ) : null;
        if (p.startsWith(":")) {
          const name = p.slice(1).replace(/[+*]$/, "");
          return (
            <span key={key} class="path-chip-wrap">
              <span class="path-sep">/</span>
              <input
                class="path-chip"
                aria-label={`Path parameter ${name}`}
                value={params[name] ?? ""}
                onInput={(e) => onParam(name, (e.target as HTMLInputElement).value)}
                size={Math.max((params[name] ?? name).length + 1, 4)}
              />
            </span>
          );
        }
        return (
          <span key={key} class="path-segment">
            {i > 0 && <span class="path-sep">/</span>}
            {p}
          </span>
        );
      })}
    </>
  );
}

function BodyPane() {
  const s = builderState.value!;
  const schema = activeBodySchema.value;
  let parseError: string | null = null;
  if (s.body.trim()) {
    try {
      JSON.parse(s.body);
    } catch (err) {
      parseError = (err as Error).message;
    }
  }
  return (
    <div class="pane body-pane">
      <div class="pane-main">
        <label class="sr-only" for="builder-body">
          Request body
        </label>
        <textarea
          id="builder-body"
          class={`code-edit ${parseError ? "has-error" : ""}`}
          value={s.body}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => updateBuilder({ body: (e.target as HTMLTextAreaElement).value })}
          placeholder={s.method === "GET" || s.method === "HEAD" ? "GET requests don't have a body" : "{}"}
          rows={12}
        />
        <div class="body-tools">
          <button type="button" class="sbtn" onClick={resetBuilder} title="Reset to schema example">
            Reset
          </button>
          <button type="button" class="sbtn" onClick={formatBody} title="Pretty-print JSON">
            Format
          </button>
          {parseError && (
            <span class="pane-issue">
              <b>Invalid JSON:</b> {parseError.slice(0, 80)}
            </span>
          )}
        </div>
      </div>
      {schema && (
        <aside class="schema-side" aria-label="Zod schema fields">
          <div class="schema-head">
            <b class="mono">{schema.name ?? "schema"}</b>
            {schema.file && (
              <span class="dim mono">
                {schema.file}
                {schema.line ? `:${schema.line}` : ""}
              </span>
            )}
          </div>
          <ul class="fields">
            {schema.fields.slice(0, 40).map((f) => (
              <li key={f.path} class="field">
                <span class="field-path mono">
                  {f.path}
                  {f.optional && <span class="dim"> ?</span>}
                </span>
                <span class="field-type dim mono">{f.type}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

function KvPane({
  target,
  rows,
}: {
  target: "query" | "headers";
  rows: Array<{ key: string; value: string; enabled: boolean }>;
}) {
  return (
    <div class="pane">
      <table class="kv-table">
        <thead>
          <tr>
            <th class="sr-only">Enabled</th>
            <th>Key</th>
            <th>Value</th>
            <th class="sr-only">Remove</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // index key is fine here — rows are a flat edit list anchored to i by design (K/V edits).
            // biome-ignore lint/suspicious/noArrayIndexKey: KV editor needs stable positional keys
            <tr key={`${target}-${i}`}>
              <td class="kv-check">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  aria-label={`Include row ${i + 1}`}
                  onChange={(e) => setKvRow(target, i, { enabled: (e.target as HTMLInputElement).checked })}
                />
              </td>
              <td>
                <input
                  class="kv-input mono"
                  value={row.key}
                  aria-label={`${target} key ${i + 1}`}
                  onInput={(e) => setKvRow(target, i, { key: (e.target as HTMLInputElement).value })}
                />
              </td>
              <td>
                <input
                  class="kv-input mono"
                  value={row.value}
                  aria-label={`${target} value ${i + 1}`}
                  onInput={(e) => setKvRow(target, i, { value: (e.target as HTMLInputElement).value })}
                />
              </td>
              <td>
                <button type="button" class="row-x" aria-label="Remove row" onClick={() => removeKvRow(target, i)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" class="sbtn" onClick={() => addKvRow(target)}>
        + Add row
      </button>
    </div>
  );
}

function AuthPane({
  profiles,
  value,
}: {
  profiles: Array<[string, { description?: string; headers: string[] }]>;
  value: string;
}) {
  if (profiles.length === 0) {
    return (
      <div class="pane">
        <div class="muted">
          No auth profiles configured. Add them in <code>withHoplens</code>:
          <pre class="code-block mono">{`profiles: {
  admin: { headers: { authorization: "Bearer \${ADMIN_TOKEN}" } },
}`}</pre>
        </div>
      </div>
    );
  }
  return (
    <div class="pane">
      <label class="field-label" for="builder-profile">
        Profile
      </label>
      <select
        id="builder-profile"
        class="profile-select"
        value={value}
        onChange={(e) => updateBuilder({ profile: (e.target as HTMLSelectElement).value })}
      >
        <option value="">(none)</option>
        {profiles.map(([k, p]) => (
          <option key={k} value={k}>
            {k} {p.description ? `· ${p.description}` : ""}
          </option>
        ))}
      </select>
      {value && profiles.find(([k]) => k === value) && (
        <ul class="profile-headers">
          {profiles
            .find(([k]) => k === value)![1]
            .headers.map((h) => (
              <li key={h} class="mono dim">
                {h}: <span class="dim">&lt;from env&gt;</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
