type Handler = (x: number) => number;

export const h1 = ((x: number) => x + 1) satisfies Handler;
export const h2 = ((x: number) => x - 1) as Handler;
