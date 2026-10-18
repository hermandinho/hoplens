export default function main(): number {
  return 1;
}

export class Box {
  v = 1;
}

export function real(): Box {
  return new Box();
}
