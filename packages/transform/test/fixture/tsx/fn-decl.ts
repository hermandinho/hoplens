interface User {
  id: number;
  name: string;
}

export function getUser(id: number): User {
  return { id, name: `user ${id}` };
}

export function boom(): never {
  throw new Error("kaboom");
}

function internal(x: number): number {
  return x;
}
internal(1);
