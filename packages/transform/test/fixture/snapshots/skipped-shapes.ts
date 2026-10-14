// Everything here should be SKIPPED by the loader.

export default function defaultOne() {
  return 1;
}

export function* iota() {
  yield 1;
  yield 2;
}

export const notAFn = 42;
export const alsoNot = { a: 1 };

const _internal = () => "internal";
function alsoInternal() {}
