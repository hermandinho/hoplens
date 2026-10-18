export function pick(a: string): string;
export function pick(a: number): number;
export function pick(a: string | number): string | number {
  return a;
}

export declare function ambient(): void;
