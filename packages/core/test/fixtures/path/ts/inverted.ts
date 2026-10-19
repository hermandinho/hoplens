// A ternary a minifier inverts: `!(a > 0) ? f1() : f2()` becomes `a>0?f2():f1()`. The shape still
// matches; only the arms' anchors tell the swap apart (mapped.ts must say UNKNOWN 'unmapped').
const out: string[] = [];
function f1(): string {
  return "x";
}
function f2(): string {
  return "y";
}

export function inv(a: number): number {
  for (const _ of [1]) {
    out.push(!(a > 0) ? f1() : f2());
  }
  return out.length;
}
