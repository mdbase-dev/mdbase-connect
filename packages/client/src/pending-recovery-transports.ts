import type {
  CollectionOperation,
  OperationTransportProtocolVersion
} from "@mdbase-dev/connect-protocol";
import {
  isSupportedOperationTransport,
  OPERATION_TRANSPORT_PROTOCOL_VERSION
} from "@mdbase-dev/connect-protocol";
import type { PendingMutation } from "./internal-types.js";
import { parseStored } from "./runtime-utils.js";

export function pendingRecoveryTransports(
  storage: Storage,
  storagePrefix: string,
  operations: readonly CollectionOperation[],
  collectionId?: string
): OperationTransportProtocolVersion[] {
  const prefix = `${storagePrefix}:pending-mutation:`;
  const versions = new Set<OperationTransportProtocolVersion>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const pending = parseStored<PendingMutation>(storage.getItem(key));
    if (
      !pending
      || !operations.includes(pending.operation)
      || (collectionId && pending.collectionId !== collectionId)
    ) continue;
    const version = pending.envelope?.protocol_version ?? pending.request?.protocol_version;
    if (
      version !== undefined
      && version !== OPERATION_TRANSPORT_PROTOCOL_VERSION
      && isSupportedOperationTransport(version)
    ) {
      versions.add(version);
    }
  }
  return [...versions].sort((left, right) => right - left);
}

export function pendingMutationsUseKey(
  storage: Storage,
  baseKey: string,
  keyHandle: string
): boolean {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== baseKey && !key?.startsWith(`${baseKey}:`)) continue;
    const pending = parseStored<{ keyHandle?: string }>(storage.getItem(key));
    if (pending?.keyHandle === keyHandle) return true;
  }
  return false;
}

export function removePendingMutations(
  storage: Storage,
  baseKey: string,
  removeKey: (keyHandle: string) => void
): void {
  const keys = [baseKey];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${baseKey}:`)) keys.push(key);
  }
  for (const key of keys) {
    const pending = parseStored<{ keyHandle?: string }>(storage.getItem(key));
    if (pending?.keyHandle) removeKey(pending.keyHandle);
    storage.removeItem(key);
  }
}
