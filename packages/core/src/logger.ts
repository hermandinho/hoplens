// Tiny namespaced logger. Writes to stderr for warnings and above; info/debug go to stdout only
// when HOPLENS_DEBUG=1. Keeps us from scattering `process.stdout.write("[hoplens] …")` everywhere.

const DEBUG = process.env.HOPLENS_DEBUG === "1";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

type Level = "debug" | "info" | "warn" | "error";

function emit(stream: NodeJS.WriteStream, level: Level, ns: string, msg: string) {
  const tag = level === "error" ? `${RED}✗${RESET}` : level === "warn" ? `${YELLOW}!${RESET}` : `${MAGENTA}◆${RESET}`;
  stream.write(`${tag} ${DIM}hoplens:${ns}${RESET} ${msg}\n`);
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export function createLogger(ns: string): Logger {
  return {
    debug(msg) {
      if (DEBUG) emit(process.stdout, "debug", ns, msg);
    },
    info(msg) {
      emit(process.stdout, "info", ns, msg);
    },
    warn(msg) {
      emit(process.stderr, "warn", ns, msg);
    },
    error(msg, err) {
      const detail = err instanceof Error ? err.stack ?? err.message : err !== undefined ? String(err) : "";
      emit(process.stderr, "error", ns, detail ? `${msg}\n${detail}` : msg);
    },
  };
}
