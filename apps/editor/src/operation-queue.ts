export class KeyedOperationQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  run<Result>(key: Key, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  wait(key: Key): Promise<void> {
    return this.tails.get(key) ?? Promise.resolve();
  }

  async waitForIdle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all(this.tails.values());
  }

  isPending(key: Key): boolean {
    return this.tails.has(key);
  }

  get pendingCount(): number {
    return this.tails.size;
  }
}
