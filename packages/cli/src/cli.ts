import path from "node:path";
import { doctor } from "./commands/doctor";
import { init } from "./commands/init";
import { remove } from "./commands/remove";
import { c, fail } from "./style";
import { readJson } from "./util";

type Command = {
  run: (args: string[]) => void | Promise<void>;
  summary: string;
  help: string;
};

const VERSION = readJson(path.join(__dirname, "..", "package.json"))?.version ?? "0.0.0";

const commands: Record<string, Command> = {
  init: {
    run: init,
    summary: "wire Hoplens into next.config and instrumentation (or the Express dev script)",
    help: `Usage: hoplens init [--dry-run] [--framework next|express]

  Next.js: patches next.config.* with withHoplens() and adds hoplens/node to
  the instrumentation register() hook.
  Express: adds --import hoplens/express/register to the dev script in
  package.json (scripts.dev, else start:dev or watch). Nothing else changes.
  Idempotent and safe to re-run.

  --dry-run      Print the proposed edits without touching any file.
  --framework    next or express. Detected from package.json; needed when
                 the project depends on both.`,
  },
  doctor: {
    run: doctor,
    summary: "check that everything is wired correctly",
    help: `Usage: hoplens doctor [--framework next|express]

  Non-destructive health check across Environment / Install / Wiring /
  Integrations. Exits 1 if Hoplens isn't ready to run; 0 otherwise.

  --framework    next or express. Detected from package.json; needed when
                 the project depends on both.`,
  },
  remove: {
    run: remove,
    summary: "unwire Hoplens from this project (reverse of init)",
    help: `Usage: hoplens remove [--dry-run] [--framework next|express]

  Next.js: unwraps withHoplens(...) in next.config and strips the Hoplens
  block from instrumentation.register(). Deletes files that init created
  when nothing user-authored remains.
  Express: takes init's flag out of the dev script and deletes
  node_modules/.cache/hoplens. Idempotent.

  --dry-run      Print the proposed edits without touching any file.
  --framework    next or express. Detected from package.json; needed when
                 the project depends on both.`,
  },
};

function topLevelHelp() {
  const names = Object.keys(commands);
  const width = Math.max(...names.map((n) => n.length));
  const list = names.map((n) => `  ${c.bold(n.padEnd(width))}   ${commands[n]!.summary}`).join("\n");
  console.log(`
${c.magenta("◆ Hoplens")} ${c.dim(`v${VERSION}`)}  for Node.js backends

Usage: ${c.bold("hoplens")} <command> [options]

Commands:
${list}

Global flags:
  ${c.bold("-h, --help")}      Show this message (or ${c.bold("hoplens <cmd> --help")})
  ${c.bold("-v, --version")}   Print version and exit

Then run ${c.bold("next dev")} (or your Express dev script) and open ${c.bold("/__hoplens")}.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "help" || first === "--help" || first === "-h") {
    topLevelHelp();
    return;
  }
  if (first === "--version" || first === "-v") {
    console.log(VERSION);
    return;
  }

  const cmd = commands[first];
  if (!cmd) {
    fail(`Unknown command: ${c.bold(first)}. Run ${c.bold("hoplens --help")} for the list.`);
    return;
  }

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`\n${cmd.help}\n`);
    return;
  }
  return cmd.run(rest);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
