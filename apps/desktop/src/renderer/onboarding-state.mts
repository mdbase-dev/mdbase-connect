export const RESUME_AUTHORIZATION_KEY = "mdbase:resume-authorization";
export const POST_PAIRING_KEY = "mdbase:post-pairing";
export const COMPLETION_RECEIPT_KEY = "mdbase:collection-completion";
export const TRANSFER_RECEIPT_KEY = "mdbase:authority-transfer-completion";
export const TRANSFER_PROGRESS_KEY = "mdbase:authority-transfer-progress";

export interface CollectionCompletionReceipt {
  collectionId: string;
  collectionName: string;
  authority: "local" | "hosted";
  path?: string;
}

export interface AuthorityTransferReceipt {
  collectionId: string;
  collectionName: string;
  direction: "local_to_hosted" | "hosted_to_local";
  newMainCopy: string;
  oldAuthority: string;
  applications: string[];
  replicas: string[];
  completedAt: string;
}

export interface AuthorityTransferProgress {
  collectionId: string;
  collectionName: string;
  direction: "local_to_hosted";
  phase: "uploading";
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

export function readTransferReceipt(storage: StorageLike): AuthorityTransferReceipt | null {
  const value = storage.getItem(TRANSFER_RECEIPT_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AuthorityTransferReceipt>;
    if (
      typeof parsed.collectionId !== "string"
      || typeof parsed.collectionName !== "string"
      || (parsed.direction !== "local_to_hosted" && parsed.direction !== "hosted_to_local")
      || typeof parsed.newMainCopy !== "string"
      || typeof parsed.oldAuthority !== "string"
      || !Array.isArray(parsed.applications)
      || parsed.applications.some((name) => typeof name !== "string")
      || !Array.isArray(parsed.replicas)
      || parsed.replicas.some((name) => typeof name !== "string")
      || typeof parsed.completedAt !== "string"
    ) throw new Error("invalid transfer receipt");
    return parsed as AuthorityTransferReceipt;
  } catch {
    storage.removeItem(TRANSFER_RECEIPT_KEY);
    return null;
  }
}

export function writeTransferReceipt(storage: StorageLike, receipt: AuthorityTransferReceipt): void {
  storage.setItem(TRANSFER_RECEIPT_KEY, JSON.stringify(receipt));
}

export function clearTransferReceipt(storage: StorageLike): void {
  storage.removeItem(TRANSFER_RECEIPT_KEY);
}

export function readTransferProgress(storage: StorageLike): AuthorityTransferProgress | null {
  const value = storage.getItem(TRANSFER_PROGRESS_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AuthorityTransferProgress>;
    if (
      typeof parsed.collectionId !== "string"
      || typeof parsed.collectionName !== "string"
      || parsed.direction !== "local_to_hosted"
      || parsed.phase !== "uploading"
    ) throw new Error("invalid transfer progress");
    return parsed as AuthorityTransferProgress;
  } catch {
    storage.removeItem(TRANSFER_PROGRESS_KEY);
    return null;
  }
}

export function writeTransferProgress(storage: StorageLike, progress: AuthorityTransferProgress): void {
  storage.setItem(TRANSFER_PROGRESS_KEY, JSON.stringify(progress));
}

export function clearTransferProgress(storage: StorageLike): void {
  storage.removeItem(TRANSFER_PROGRESS_KEY);
}
