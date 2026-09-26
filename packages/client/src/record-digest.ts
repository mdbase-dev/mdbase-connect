/**
 * An equality token for one record in one collection. Stored with a pending
 * update so an editing session can find its own interrupted write after a
 * reload without the record path ever being persisted.
 */
export async function recordDigest(collectionId: string, path: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${collectionId}\n${path}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The digest a new pending mutation stores: only updates name a record. */
export async function updatedRecordDigest(
  collectionId: string,
  operation: string,
  input: unknown
): Promise<string | undefined> {
  const path = (input as { path?: unknown } | undefined)?.path;
  return operation === "update" && typeof path === "string" ? recordDigest(collectionId, path) : undefined;
}

/** The request ID of a stored interrupted update to one record, if any. */
export async function interruptedUpdate(
  pending: readonly { operation: string; requestId: string; recordDigest?: string }[],
  collectionId: string,
  path: string
): Promise<string | null> {
  const digest = await recordDigest(collectionId, path);
  return pending.find((entry) => entry.operation === "update" && entry.recordDigest === digest)?.requestId ?? null;
}
