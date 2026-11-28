/** IPC snapshots contain JSON values. Keep React's identity when the data is unchanged. */
export function retainSnapshot<T>(previous: T, next: T): T {
  return Object.is(previous, next) || JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export function retainCollections(previous: DaemonCollection[], next: DaemonCollection[]): DaemonCollection[] {
  const byId = new Map(previous.map((collection) => [collection.id, collection]));
  const rows = next.map((collection) => {
    const existing = byId.get(collection.id);
    return existing ? retainSnapshot(existing, collection) : collection;
  });
  return previous.length === rows.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
