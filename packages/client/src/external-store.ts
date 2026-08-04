/** Minimal framework-neutral shape consumed by React's useSyncExternalStore. */
export interface MdbaseExternalStore<Snapshot> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Snapshot;
}

/**
 * Adapt an existing SDK session without introducing another cache or state
 * owner. The stable object can be passed directly to useSyncExternalStore.
 */
export function externalStore<Snapshot>(
  source: MdbaseExternalStore<Snapshot>
): MdbaseExternalStore<Snapshot> {
  return {
    subscribe: (listener) => source.subscribe(listener),
    getSnapshot: () => source.getSnapshot()
  };
}
