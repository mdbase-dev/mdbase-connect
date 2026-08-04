import {
  isCollectionOperation,
  mutationOperationIdentifier,
  type MutationOperationIdentifier
} from "@mdbase-dev/connect-protocol";
import type { PendingMutation } from "./internal-types.js";
import { parseStored } from "./runtime-utils.js";

export class PendingMutationStore {
  constructor(
    private readonly storage: Storage,
    private readonly baseKey: string
  ) {}

  list(collectionId: string | null): PendingMutation[] {
    if (!collectionId) return [];
    const legacy = parseStored<PendingMutation>(this.storage.getItem(this.baseKey));
    if (validPendingMutation(legacy) && legacy.collectionId === collectionId) {
      const migratedKey = this.key(legacy.requestId);
      if (!this.storage.getItem(migratedKey)) {
        this.storage.setItem(migratedKey, JSON.stringify(legacy));
      }
      this.storage.removeItem(this.baseKey);
    }
    const keys: string[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(`${this.baseKey}:`)) keys.push(key);
    }
    return keys
      .map((key) => parseStored<PendingMutation>(this.storage.getItem(key)))
      .filter((pending): pending is PendingMutation =>
        validPendingMutation(pending) && pending.collectionId === collectionId)
      .sort((left, right) => left.createdAt - right.createdAt
        || left.requestId.localeCompare(right.requestId));
  }

  find(collectionId: string | null, requestId: string): PendingMutation | null {
    return this.list(collectionId)
      .find((pending) => pending.requestId === requestId) ?? null;
  }

  identifier(pending: PendingMutation): MutationOperationIdentifier {
    return pending.mutation ?? mutationOperationIdentifier(
      pending.operation,
      pending.request?.input ?? (pending.operation === "sync" ? { action: "mutate" } : {})
    ) ?? (pending.operation === "sync" ? "sync:mutate" : pending.operation) as MutationOperationIdentifier;
  }

  store(pending: PendingMutation): void {
    this.storage.setItem(this.key(pending.requestId), JSON.stringify(pending));
  }

  take(requestId: string): PendingMutation | null {
    const key = this.key(requestId);
    const pending = parseStored<PendingMutation>(this.storage.getItem(key));
    this.storage.removeItem(key);
    return pending;
  }

  private key(requestId: string): string {
    return `${this.baseKey}:${encodeURIComponent(requestId)}`;
  }
}

function validPendingMutation(pending: PendingMutation | null): pending is PendingMutation {
  return Boolean(
    pending
    && typeof pending.collectionId === "string"
    && typeof pending.requestId === "string"
    && pending.requestId.length > 0
    && isCollectionOperation(pending.operation)
    && typeof pending.inputFingerprint === "string"
    && Number.isFinite(pending.createdAt)
    && pending.createdAt > 0
    && (pending.envelope || pending.request)
    && (pending.operation === "sync" || mutationOperationIdentifier(
      pending.operation,
      pending.request?.input ?? {}
    ) !== null)
  );
}
