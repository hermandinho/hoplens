// Request path P5 oracle fixture: branchy TypeScript that Node's type stripping can run as it is
// (identity: the ground truth) and esbuild compiles (offsets shift: the mapped run). Types,
// interfaces, generics and `as` everywhere so the compiled offsets really move.
export interface Item {
  id: number;
  kind: "a" | "b" | "c" | "d";
  tags?: readonly string[];
}

type Opts<T> = { pick?: (x: T) => boolean; limit: number };

let ticks = 0;
function tick(): void {
  ticks++;
}

function boom(msg: string): never {
  throw new Error(msg);
}

export function classify(item: Item, high: boolean): string {
  let out: string = "";
  if (item.id < 0) {
    return "negative";
  } else if (item.id === 0) {
    out = "zero";
  } else {
    out = high ? "high" : "low";
  }
  switch (item.kind) {
    case "a":
      out += ":a";
    case "b":
      out += ":ab";
      break;
    case "c": {
      out += ":c";
      break;
    }
    default:
      out += ":?";
  }
  return out;
}

export function scan<T extends { id: number }>(rows: readonly T[], opts: Opts<T>): number {
  let n: number = 0;
  for (const r of rows) {
    if (opts.pick && !opts.pick(r)) continue;
    if (n >= opts.limit) return -1;
    n += r.id as number;
  }
  let i = 0;
  while (i < 3) {
    i++;
  }
  return n;
}

export function guarded(flag: boolean): string {
  try {
    if (flag) boom("bad");
    return "ok";
  } catch (err: unknown) {
    const e = err as Error;
    return e.message ?? "unknown";
  } finally {
    tick();
  }
}

export class Tally<K extends string> {
  private readonly seen = new Map<K, number>();
  add(key: K, by = 1): number {
    const n = (this.seen.get(key) ?? 0) + by;
    this.seen.set(key, n);
    return n > 2 ? n : -n;
  }
}

export function total(): number {
  return ticks;
}
