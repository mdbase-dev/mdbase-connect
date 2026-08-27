export interface CollectionScopeToken {
  readonly epoch: number;
  readonly collectionId?: string;
}

export class FrozenCollectionError extends Error {
  constructor() { super("Collection mutations are temporarily disabled."); }
}

export class StaleCollectionOperationError extends Error {
  constructor() { super("The collection changed before this operation completed."); }
}

/** Owns the exact publication boundary for collection-scoped asynchronous work. */
export class CollectionMutationScope {
  private epoch = 0;
  private owner?: string;
  private frozen = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();

  get isFrozen(): boolean { return this.frozen; }

  token(): CollectionScopeToken {
    return Object.freeze({ epoch: this.epoch, collectionId: this.owner });
  }

  isCurrent = (token: CollectionScopeToken): boolean =>
    !this.frozen && this.owns(token);

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.publish();
  }

  unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.publish();
  }

  changeOwner(collectionId?: string): CollectionScopeToken {
    this.epoch += 1;
    this.owner = collectionId;
    return this.token();
  }

  run<T>(operation: (token: CollectionScopeToken) => Promise<T>): Promise<T> {
    if (this.frozen) return Promise.reject(new FrozenCollectionError());
    return this.register(this.token(), operation(this.token()));
  }

  /** Register coordinator work which was accepted before a transition froze input. */
  register<T>(token: CollectionScopeToken, promise: Promise<T>): Promise<T> {
    const bounded = promise.then((value) => {
      if (!this.owns(token)) throw new StaleCollectionOperationError();
      return value;
    });
    this.pending.add(bounded);
    void bounded.finally(() => this.pending.delete(bounded)).catch(() => undefined);
    return bounded;
  }

  async drain(): Promise<void> {
    let failure: unknown;
    let failed = false;
    while (this.pending.size > 0) {
      const outcomes = await Promise.allSettled([...this.pending]);
      for (const outcome of outcomes) {
        if (!failed && outcome.status === "rejected") {
          failed = true;
          failure = outcome.reason;
        }
      }
    }
    if (failed) throw failure;
  }

  private owns(token: CollectionScopeToken): boolean {
    return token.epoch === this.epoch && token.collectionId === this.owner;
  }

  private publish(): void { for (const listener of this.listeners) listener(); }
}
