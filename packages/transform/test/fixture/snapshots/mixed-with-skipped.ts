// Mix of traceable + skipped. Only `traced` and `alsoTraced` should get wrapped.

export function traced(a: number) {
  return a + 1;
}

export default function defExport() {
  return "default";
}

export function* generator() {
  yield 1;
}

export const alsoTraced = (x: number) => x * 2;

const _skippedBecauseNotExported = () => 99;
export const nonFunction = 42;
