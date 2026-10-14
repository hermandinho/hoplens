import { init } from "./commands/init";
import { doctor } from "./commands/doctor";
import { remove } from "./commands/remove";
import { c } from "./style";

type Command = (args: string[]) => void | Promise<void>;

const commands: Record<string, Command> = {
  init,
  doctor,
  remove,
};

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const run = commands[cmd];
  if (run) return run(rest);
  console.log(`
${c.magenta("◆ Hoplens")} for Node.js backends

  ${c.bold("npx hoplens init")}      wire Hoplens into next.config and instrumentation
  ${c.bold("npx hoplens doctor")}    check that everything is in place
  ${c.bold("npx hoplens remove")}    unwire Hoplens from this project

Then run ${c.bold("next dev")} and open ${c.bold("/__hoplens")}.
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
