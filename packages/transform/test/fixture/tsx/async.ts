export async function load(id: number): Promise<number> {
  await new Promise((r) => setTimeout(r, 1));
  return id;
}

export const save = async (v: string): Promise<string> => {
  return v;
};

export function* gen(): Generator<number> {
  yield 1;
}
