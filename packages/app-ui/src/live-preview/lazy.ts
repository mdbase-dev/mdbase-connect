/** A module loaded on first use and shared by every caller. A failed load is retried by the next call rather than cached. */
export function lazily<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= load().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
}
