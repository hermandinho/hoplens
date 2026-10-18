function logged<T>(value: T, _ctx: ClassDecoratorContext): T {
  return value;
}

@logged
export class Service {
  run(): number {
    return 1;
  }
}

export function useService(): number {
  return new Service().run();
}
