export function tidy(n: number): number {
  return n + 1;
}

export const later = async (): Promise<number> => 2;

using res = { [Symbol.dispose]() {} };
