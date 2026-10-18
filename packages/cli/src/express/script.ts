/**
 * Wiring the Express register hook into an npm script string, and taking it out again.
 *
 * init only inserts text (one run of characters at one offset) and remove only deletes exactly that
 * run, so an init -> remove round trip gives back the original script byte for byte. Everything
 * else in the script (env prefixes, quoting, `&&` chains, other flags) is left as written.
 *
 * The flag is always `--import hoplens/express/register`, also for a script that already uses `-r`
 * for something else: `--import` loads CommonJS and ESM alike on every Node the adapter supports
 * (>= 20.9), and one form keeps doctor and remove simple. A script wired by hand with `-r` is
 * reported as already wired and left alone.
 */

export const REGISTER = "hoplens/express/register";
export const FLAG = `--import ${REGISTER}`;
/** What init inserts after a node / tsx runner, or inside a nodemon `--exec` command. */
export const INSERT = ` ${FLAG}`;
/** What init inserts after a plain `nodemon` with no `--exec`. */
export const NODEMON_INSERT = ` --exec "node ${FLAG}"`;

/** Any form of the register hook: `-r`, `--require`, `--import`, `--import=`, scoped or meta, NODE_OPTIONS. */
export const REGISTER_RE = /(?:@hoplens\/express|hoplens\/express)\/register\b/;

export type Word = { text: string; start: number; end: number; quoted: boolean };
/** `op` is the operator before the segment (`&&`, `||`, `;`, `|`, `&`; a newline reads as `;`). */
export type Segment = { words: Word[]; op?: string };

export type Runner = "node" | "tsx" | "nodemon";
export type WireResult =
  | { kind: "wired"; at: number; text: string; runner: Runner; out: string }
  | { kind: "already" }
  | { kind: "manual"; reason: string; script?: string; hint?: string };

/** Split a shell command into segments (`&&`, `||`, `;`, `|`, `&`) of words, honouring quotes. */
export function tokenize(cmd: string): Segment[] {
  const segments: Segment[] = [{ words: [] }];
  const open = (op: string) => {
    const last = segments[segments.length - 1]!;
    // `a &&\n b` is one `&&`, not an empty segment: the stronger (sequence) operator is kept.
    if (last.words.length === 0 && segments.length > 1) {
      if (!SEQUENCE.has(last.op!)) last.op = op;
    } else segments.push({ words: [], op });
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (/\s/.test(ch)) {
      if (ch === "\n") open(";");
      i++;
      continue;
    }
    if (ch === "&" || ch === "|" || ch === ";") {
      const two = cmd[i + 1] === ch && ch !== ";";
      open(two ? ch + ch : ch);
      i += two ? 2 : 1;
      continue;
    }
    const start = i;
    let text = "";
    let quoted = false;
    while (i < cmd.length && !/\s/.test(cmd[i]!) && !"&|;".includes(cmd[i]!)) {
      const c = cmd[i]!;
      if (c === '"' || c === "'") {
        quoted = true;
        const close = cmd.indexOf(c, i + 1);
        const stop = close < 0 ? cmd.length : close;
        let inner = cmd.slice(i + 1, stop);
        if (c === '"') inner = inner.replace(/\\(["\\$`])/g, "$1");
        text += inner;
        i = stop + 1;
      } else if (c === "\\" && i + 1 < cmd.length) {
        text += cmd[i + 1];
        i += 2;
      } else {
        text += c;
        i++;
      }
    }
    segments[segments.length - 1]!.words.push({ text, start, end: Math.min(i, cmd.length), quoted });
  }
  return segments.filter((s) => s.words.length > 0);
}

/** Operators that run the next command after this one, not alongside it. */
const SEQUENCE = new Set(["&&", "||", ";"]);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const UNSUPPORTED = new Set([
  "ts-node",
  "ts-node-dev",
  "tsnd",
  "ts-node-esm",
  "bun",
  "bunx",
  "pm2",
  "pm2-runtime",
  "pm2-dev",
  "docker",
  "docker-compose",
  "podman",
  "deno",
  "forever",
  "nest",
  "vite-node",
  "babel-node",
  "swc-node",
]);

type Classified =
  | { kind: Runner; runnerIdx: number; words: Word[] }
  | { kind: "unsupported"; name: string; runnerIdx: number; words: Word[] }
  | { kind: "delegate"; name: string; words: Word[] }
  | { kind: "other" };

function base(word: string): string {
  return (
    word
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(cmd|exe|ps1)$/i, "") ?? word
  );
}

/** Skip env assignments, `cross-env` / `env`, and `npx` / `pnpm exec` style launchers. */
function runnerIndex(words: Word[]): number {
  let i = 0;
  const skipAssign = () => {
    while (i < words.length && ENV_ASSIGN.test(words[i]!.text)) i++;
  };
  skipAssign();
  for (let guard = 0; guard < 4 && i < words.length; guard++) {
    const w = base(words[i]!.text);
    if (w === "cross-env" || w === "cross-env-shell" || w === "env") {
      i++;
      skipAssign();
      continue;
    }
    if (w === "npx" || w === "pnpx") {
      i++;
      while (i < words.length && /^(-y|--yes|--no-install)$/.test(words[i]!.text)) i++;
      continue;
    }
    if ((w === "pnpm" || w === "npm" || w === "yarn") && words[i + 1]?.text === "exec") {
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function classify(seg: Segment): Classified {
  const words = seg.words;
  const idx = runnerIndex(words);
  const w = words[idx];
  if (!w) return { kind: "other" };
  const name = base(w.text);
  if (name === "node" || name === "tsx" || name === "nodemon") return { kind: name, runnerIdx: idx, words };
  if (UNSUPPORTED.has(name)) return { kind: "unsupported", name, runnerIdx: idx, words };
  if ((name === "npm" || name === "pnpm" || name === "yarn") && (words[idx + 1]?.text === "run" || name !== "npm"))
    return {
      kind: "delegate",
      name: words
        .slice(idx)
        .map((x) => x.text)
        .join(" "),
      words,
    };
  return { kind: "other" };
}

/** Offset (in the segment's own text) right after the runner, past `--watch` / `watch`. */
function afterRunner(kind: "node" | "tsx", words: Word[], runnerIdx: number): number {
  const next = words[runnerIdx + 1];
  if (kind === "node" && next?.text === "--watch") return next.end;
  if (kind === "tsx" && next?.text === "watch") return next.end;
  return words[runnerIdx]!.end;
}

export type WireOptions = {
  /** `exec` from nodemon.json or package.json `nodemonConfig`: nodemon then runs that, not node. */
  nodemonExec?: string | null;
};

/**
 * Where to insert the register flag in `cmd`. Commands run one after another (`&&`, `||`, `;`): the
 * last one that runs node, tsx or nodemon (or a runner we don't edit) is taken as the one that
 * starts the app, so `tsc && node dist/server.js` wires the node. Within a pipeline (`|`) the first
 * such command, the producer, is the app (`node app.js | node pretty.js`); two of them run side by
 * side with `&` can't be told apart, so that is left to the user.
 */
export function wireScript(cmd: string, opts: WireOptions = {}): WireResult {
  if (REGISTER_RE.test(cmd)) return { kind: "already" };
  const groups: { cls: Classified; op?: string }[][] = [];
  for (const seg of tokenize(cmd)) {
    if (!groups.length || SEQUENCE.has(seg.op!)) groups.push([]);
    groups[groups.length - 1]!.push({ cls: classify(seg), op: seg.op });
  }
  let target: Classified | undefined;
  for (const g of groups) {
    const cands = g.filter((x) => x.cls.kind !== "other");
    if (!cands.length) continue;
    if (cands.length > 1 && g.slice(1).some((x) => x.op === "&"))
      return {
        kind: "manual",
        reason: "it starts more than one node process side by side (&)",
        hint: `add ${FLAG} to the node command that starts your app (node ${FLAG} <entry>)`,
      };
    target = cands[0]!.cls;
  }
  if (!target)
    return {
      kind: "manual",
      reason: "it has no node, tsx or nodemon command",
      hint: `add ${FLAG} to the node command that starts your app (node ${FLAG} <entry>)`,
    };

  const done = (at: number, text: string, runner: Runner): WireResult => {
    const out = cmd.slice(0, at) + text + cmd.slice(at);
    // remove must give back `cmd` byte for byte; an edit it would read differently isn't made.
    const back = unwireScript(out);
    if (!back || out.slice(0, back.from) + out.slice(back.to) !== cmd) {
      const reason = "init can't add the flag there in a form remove can take out exactly";
      return runner === "nodemon"
        ? manualNodemon(reason)
        : { kind: "manual", reason, hint: `add ${FLAG} to the node command that starts your app` };
    }
    return { kind: "wired", at, text, runner, out };
  };

  if (target.kind === "delegate") {
    return {
      kind: "manual",
      reason: `it runs another script (${target.name})`,
      hint: `add ${FLAG} to the node command of the script that starts your app`,
    };
  }
  if (target.kind === "unsupported") return manualFor(cmd, target);
  if (target.kind === "node" || target.kind === "tsx") {
    return done(afterRunner(target.kind, target.words, target.runnerIdx), INSERT, target.kind);
  }

  if (target.kind !== "nodemon") return { kind: "manual", reason: "it has no node, tsx or nodemon command" };
  const words = target.words;
  const r = target.runnerIdx;
  for (let i = r + 1; i < words.length; i++) {
    const w = words[i]!;
    let value: Word;
    let valueText: string;
    let valueStart: number;
    if (w.text === "--exec" || w.text === "-x") {
      const v = words[i + 1];
      if (!v) break;
      value = v;
      valueText = v.text;
      valueStart = v.start;
    } else if (w.text.startsWith("--exec=")) {
      value = w;
      valueText = w.text.slice("--exec=".length);
      valueStart = w.start + "--exec=".length;
    } else continue;
    const raw = cmd.slice(valueStart, value.end);
    const q = raw[0];
    // Only a quoted value with no escapes inside maps 1:1 onto the script text.
    if ((q !== '"' && q !== "'") || raw.slice(1, -1) !== valueText) {
      if (!/\s/.test(valueText) && (base(valueText) === "node" || base(valueText) === "tsx"))
        return manualNodemon(`quote nodemon's --exec value: --exec "${valueText} ${FLAG}"`);
      return manualNodemon(`nodemon --exec runs ${valueText}`);
    }
    const inner = tokenize(valueText).map(classify);
    const first = inner[0];
    if (inner.length !== 1 || !first || (first.kind !== "node" && first.kind !== "tsx"))
      return manualNodemon(`nodemon --exec runs ${valueText}`);
    return done(valueStart + 1 + afterRunner(first.kind, first.words, first.runnerIdx), INSERT, "nodemon");
  }
  const rest = words.slice(r + 1);
  // A --config file can set exec (ts-node, say), and a command-line --exec would replace it.
  if (rest.some((w) => w.text === "--config" || w.text === "-c" || w.text.startsWith("--config=")))
    return manualNodemon("nodemon --config names a config file whose exec init can't see");
  if (opts.nodemonExec) return manualNodemon(`nodemon's config sets exec to ${opts.nodemonExec}`);
  // Any .ts word, not just the first non-flag one: in `--watch src -e ts src/index.ts` that is `src`.
  if (rest.some((w) => /\.(c|m)?ts$/.test(w.text))) return manualNodemon("nodemon runs .ts files with ts-node");
  const ext = rest.flatMap((w, i) =>
    w.text === "-e" || w.text === "--ext"
      ? [rest[i + 1]?.text ?? ""]
      : w.text.startsWith("--ext=")
        ? [w.text.slice("--ext=".length)]
        : [],
  );
  const watchesTs = ext.some((v) => v.split(/[\s,]+/).some((e) => /^\.?(c|m)?ts$/.test(e)));
  if (watchesTs && !rest.some((w) => /\.(c|m)?js$/.test(w.text)))
    return manualNodemon("nodemon watches .ts files, so it likely runs TypeScript with ts-node");
  return done(words[r]!.end, NODEMON_INSERT, "nodemon");
}

function manualNodemon(reason: string): WireResult {
  return {
    kind: "manual",
    reason,
    hint: `make nodemon start node with ${FLAG}, for example nodemon --exec "node ${FLAG}" <entry>`,
  };
}

function manualFor(cmd: string, t: Extract<Classified, { kind: "unsupported" }>): WireResult {
  const at = t.words[t.runnerIdx]!.end;
  const tail = t.words[t.words.length - 1]!.end;
  const reason = `${t.name} isn't edited automatically`;
  switch (t.name) {
    case "ts-node":
    case "ts-node-dev":
    case "tsnd":
      return { kind: "manual", reason, script: `${cmd.slice(0, at)} -r ${REGISTER}${cmd.slice(at)}` };
    case "pm2":
    case "pm2-dev":
    case "pm2-runtime":
      return {
        kind: "manual",
        reason,
        script: `${cmd.slice(0, tail)} --node-args="${FLAG}"${cmd.slice(tail)}`,
      };
    case "bun":
    case "bunx":
    case "deno":
      return {
        kind: "manual",
        reason: `${t.name} isn't supported by the register hook`,
        hint: "run the app with node, or call hoplens(app) from your code (see @hoplens/express)",
      };
    default:
      return {
        kind: "manual",
        reason,
        hint: `add ${FLAG} to the node command that starts your app (node ${FLAG} <entry>), or call hoplens(app) from your code`,
      };
  }
}

/**
 * The range init inserted, for remove. The nodemon `--exec` form is tried first (it contains the
 * plain flag). Null when the script holds no init-written flag. A hand-written
 * `nodemon --exec "node" app.js` would wire to the same text as a plain `nodemon app.js`; init
 * checks every edit against this function and leaves that one to the user.
 */
export function unwireScript(cmd: string): { from: number; to: number } | null {
  for (const text of [NODEMON_INSERT, INSERT]) {
    let from = cmd.indexOf(text);
    while (from >= 0) {
      const after = cmd[from + text.length];
      if (after === undefined || /[\s"';&|]/.test(after)) return { from, to: from + text.length };
      from = cmd.indexOf(text, from + 1);
    }
  }
  return null;
}

/** The register specifier a script preloads (`hoplens/express/register` or `@hoplens/express/register`). */
export function registerSpecifier(cmd: string): string | null {
  const m = /(@hoplens\/express|hoplens\/express)\/register\b/.exec(cmd);
  return m ? m[0] : null;
}

/** Entry-looking words (`src/server.js`) of a script, for the light hoplens(app) search. */
export function entryFiles(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of tokenize(cmd))
    for (const w of seg.words)
      if (/^[^-][^=]*\.(c|m)?(j|t)s$/.test(w.text) && !REGISTER_RE.test(w.text)) out.push(w.text);
  return out;
}
