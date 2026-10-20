function inner(x: number): number {
  return x * 2;
}

const local = (s: string): string => s.toUpperCase();

export { inner as doubled, local as shout };
export type { Shape } from "./shapes.ts";
