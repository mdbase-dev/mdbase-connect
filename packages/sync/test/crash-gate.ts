/** Fault injection at port awaits, including streaming iterator awaits.
 * Once killed, a process cannot persist catch/finally recovery writes. */
export class CrashGate {
  readonly trace: string[] = [];
  crashed = false;
  constructor(private readonly cut?: number) {}

  wrap<Port extends object>(name: string, port: Port): Port {
    return new Proxy(port, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        const label = `${name}.${String(property)}`;
        return (...args: unknown[]) => {
          this.boundary(`${label}:before`);
          const result = value.apply(target, args);
          if (result && typeof result[Symbol.asyncIterator] === "function") {
            this.boundary(`${label}:after`);
            return this.stream(label, result);
          }
          return Promise.resolve(result).then((resolved) => {
            this.boundary(`${label}:after`);
            return resolved && typeof resolved[Symbol.asyncIterator] === "function"
              ? this.stream(label, resolved) : resolved;
          });
        };
      }
    });
  }

  private async *stream(label: string, source: AsyncIterable<unknown>) {
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        this.boundary(`${label}.next:before`);
        const next = await iterator.next();
        this.boundary(`${label}.next:after`);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      if (!this.crashed) await iterator.return?.();
    }
  }

  private boundary(label: string) {
    if (this.crashed) throw new Error("process killed");
    this.trace.push(label);
    if (this.trace.length - 1 === this.cut) {
      this.crashed = true;
      throw new Error("process killed");
    }
  }
}
