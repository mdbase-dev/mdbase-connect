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
