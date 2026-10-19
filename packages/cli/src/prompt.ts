import readline from "node:readline";

/** Where init asks its questions. `interactive` false: never ask, take the default. */
export interface PromptIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  interactive: boolean;
}

/** The terminal, interactive only when both stdin and stdout are TTYs (not in CI or a pipe). */
export function terminalIO(): PromptIO {
  return { input: process.stdin, output: process.stdout, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY };
}

/** Ask a `[y/N]` question: true only for y / yes. An empty answer, or input that ends, is no. */
export function askYesNo(question: string, io: PromptIO): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
    let done = false;
    const finish = (yes: boolean) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(yes);
    };
    rl.on("close", () => finish(false));
    rl.question(question, (answer) => finish(/^\s*y(es)?\s*$/i.test(answer)));
  });
}
