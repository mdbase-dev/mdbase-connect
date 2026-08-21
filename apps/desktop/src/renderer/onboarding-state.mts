export const RESUME_AUTHORIZATION_KEY = "mdbase:resume-authorization";
export const POST_PAIRING_KEY = "mdbase:post-pairing";
export const COMPLETION_RECEIPT_KEY = "mdbase:collection-completion";

export interface CollectionCompletionReceipt {
  collectionId: string;
  collectionName: string;
  authority: "local" | "hosted";
  path?: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readAuthorizationTarget(storage: StorageLike): string | null {
  return storage.getItem(RESUME_AUTHORIZATION_KEY);
}

export function markPairingCompleted(storage: StorageLike): void {
  storage.setItem(POST_PAIRING_KEY, "completed");
}

export function consumePairingCompleted(storage: StorageLike): boolean {
  if (storage.getItem(POST_PAIRING_KEY) !== "completed") return false;
  storage.removeItem(POST_PAIRING_KEY);
  return true;
}

export function readCompletionReceipt(storage: StorageLike): CollectionCompletionReceipt | null {
  const value = storage.getItem(COMPLETION_RECEIPT_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CollectionCompletionReceipt>;
    if (
      typeof parsed.collectionId !== "string"
      || typeof parsed.collectionName !== "string"
      || (parsed.authority !== "local" && parsed.authority !== "hosted")
      || (parsed.path !== undefined && typeof parsed.path !== "string")
    ) throw new Error("invalid receipt");
    return parsed as CollectionCompletionReceipt;
  } catch {
    storage.removeItem(COMPLETION_RECEIPT_KEY);
    return null;
  }
}

export function writeCompletionReceipt(storage: StorageLike, receipt: CollectionCompletionReceipt): void {
  storage.setItem(COMPLETION_RECEIPT_KEY, JSON.stringify(receipt));
}

export function clearCompletionReceipt(storage: StorageLike): void {
  storage.removeItem(COMPLETION_RECEIPT_KEY);
}
