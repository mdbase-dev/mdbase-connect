import type { StoredConnectionIndex } from "./internal-types.js";
import { parseStored } from "./runtime-utils.js";

export function connectionIds(storage: Storage, storagePrefix: string): string[] {
  const index = parseStored<StoredConnectionIndex>(storage.getItem(`${storagePrefix}:connections`));
  return index?.version === 1 && Array.isArray(index.collectionIds)
    && index.collectionIds.every((collectionId) => typeof collectionId === "string")
    ? index.collectionIds
    : [];
}

export function addConnectionId(storage: Storage, storagePrefix: string, collectionId: string): void {
  writeConnectionIds(storage, storagePrefix, [...connectionIds(storage, storagePrefix), collectionId]);
}

export function removeConnectionId(storage: Storage, storagePrefix: string, collectionId: string): void {
  writeConnectionIds(
    storage,
    storagePrefix,
    connectionIds(storage, storagePrefix).filter((id) => id !== collectionId)
  );
}

function writeConnectionIds(storage: Storage, storagePrefix: string, ids: string[]): void {
  storage.setItem(`${storagePrefix}:connections`, JSON.stringify({
    version: 1,
    collectionIds: [...new Set(ids)]
  } satisfies StoredConnectionIndex));
}
