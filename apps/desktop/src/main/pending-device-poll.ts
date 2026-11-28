/** Only an empty result is cached. Active exchanges can advance between polls. */
export class PendingDevicePoll<T> {
  private emptyUntil = 0;
  private revision = 0;
  private reading: { revision: number; result: Promise<T[]> } | undefined;
  private readonly load: () => Promise<T[]>;
  private readonly emptyTtlMs: number;

  constructor(load: () => Promise<T[]>, emptyTtlMs: number) {
    this.load = load;
    this.emptyTtlMs = emptyTtlMs;
  }

  invalidate(): void {
    this.emptyUntil = 0;
    this.revision++;
  }

  read(): Promise<T[]> {
    if (Date.now() < this.emptyUntil) return Promise.resolve([]);
    const reading = this.reading;
    if (reading) {
      return reading.revision === this.revision
        ? reading.result
        : reading.result.then(() => this.read(), () => this.read());
    }
    const revision = this.revision;
    const result = this.load().then((rows) => {
      if (rows.length === 0 && revision === this.revision) this.emptyUntil = Date.now() + this.emptyTtlMs;
      return rows;
    }).finally(() => { this.reading = undefined; });
    this.reading = { revision, result };
    return result;
  }
}
