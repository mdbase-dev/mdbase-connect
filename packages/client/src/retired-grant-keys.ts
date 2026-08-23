import type { StoredToken } from "./internal-types.js";
import type { GrantKeyStore } from "./crypto.js";
import {
  pendingMutationKeyHandles,
  pendingMutationsUseKey
} from "./pending-recovery-transports.js";
import { parseStored } from "./runtime-utils.js";

export function storedTokenKeyHandles(token: StoredToken | null, additional?: string): Set<string> {
  const handles = new Set<string>();
  if (additional) handles.add(additional);
  if (token?.keyHandle) handles.add(token.keyHandle);
  if (Array.isArray(token?.retiredKeyHandles)) {
    for (const handle of token.retiredKeyHandles) {
      if (typeof handle === "string" && handle.length > 0) handles.add(handle);
    }
  }
  return handles;
}

export function planRetiredGrantKeys(
  storage: Storage,
  pendingMutationKey: string,
  previous: StoredToken | null,
  current?: string,
  leased: Iterable<string> = [],
  retainAll = false
): { retained: string[]; disposable: string[] } {
  const retained: string[] = [];
  const disposable: string[] = [];
  const candidates = storedTokenKeyHandles(previous);
  for (const handle of pendingMutationKeyHandles(storage, pendingMutationKey)) {
    candidates.add(handle);
  }
  const leasedHandles = new Set(leased);
  for (const handle of leasedHandles) candidates.add(handle);
  for (const handle of candidates) {
    if (handle === current) continue;
    (retainAll || leasedHandles.has(handle) || pendingMutationsUseKey(storage, pendingMutationKey, handle)
      ? retained
      : disposable).push(handle);
  }
  return { retained, disposable };
}

export function removeRetiredGrantKeyMetadata(
  storage: Storage,
  tokenKey: string,
  handle: string
): void {
  const token = parseStored<StoredToken>(storage.getItem(tokenKey));
  if (!token || !Array.isArray(token.retiredKeyHandles)) return;
  const retiredKeyHandles = token.retiredKeyHandles.filter((candidate) => candidate !== handle);
  if (retiredKeyHandles.length === token.retiredKeyHandles.length) return;
  if (retiredKeyHandles.length > 0) token.retiredKeyHandles = retiredKeyHandles;
  else delete token.retiredKeyHandles;
  storage.setItem(tokenKey, JSON.stringify(token));
}

export async function deleteUnusedGrantKey(
  storage: Storage,
  keyStore: GrantKeyStore,
  pendingMutationKey: string,
  tokenKey: string,
  handle: string
): Promise<void> {
  const current = parseStored<StoredToken>(storage.getItem(tokenKey));
  if (current?.keyHandle === handle
      || pendingMutationsUseKey(storage, pendingMutationKey, handle)) return;
  await keyStore.delete(handle);
  removeRetiredGrantKeyMetadata(storage, tokenKey, handle);
}
