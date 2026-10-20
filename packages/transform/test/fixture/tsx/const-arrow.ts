type Id = number;

export const listUsers = (n: Id): Id[] => {
  return Array.from({ length: n }, (_, i) => i);
};

export const sum = function (a: number, b: number): number {
  return a + b;
};

export const typed = ((s: string) => s.trim()) as (s: string) => string;

export const notAFunction = 42;
