enum Color {
  Red,
  Green,
}

export namespace NS {
  export const x = 1;
}

export const enum Flag {
  On = 1,
}

export const color = Color.Red;

export function paint(c: Color = Color.Green): Color {
  return c;
}
