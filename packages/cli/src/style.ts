export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export const ok = (s: string) => console.log(`  ${c.green("✓")} ${s}`);
export const skip = (s: string) => console.log(`  ${c.dim("•")} ${c.dim(s)}`);
export const warn = (s: string) => console.log(`  ${c.yellow("!")} ${s}`);
export const fail = (s: string) => {
  console.log(`  ${c.red("✗")} ${s}\n`);
  process.exitCode = 1;
};
