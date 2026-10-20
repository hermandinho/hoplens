// Request path P5 fixture for shapes only a compiler runs: an enum esbuild inlines (the structure
// stays: mapped), and a statement esbuild drops (`void 0;`: the shape breaks, so UNKNOWN 'unmapped').
export enum Level {
  Low = 1,
  High = 2,
}

export function rank(level: Level, n: number): string {
  if (level === Level.High) {
    return n > 10 ? "top" : "high";
  }
  return "low";
}

export function dropped(flag: boolean): number {
  void 0;
  if (flag) {
    return 1;
  }
  return 0;
}
