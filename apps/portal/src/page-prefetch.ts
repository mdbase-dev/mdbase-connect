import type { AccountData, ConnectManagementClient } from "@mdbase/connect-management";

let account: { client: ConnectManagementClient; at: number; promise: Promise<AccountData> } | undefined;
let sharing: { client: ConnectManagementClient; id: string; at: number; promise: ReturnType<typeof loadSharing> } | undefined;
let mode: { client: ConnectManagementClient; id: string; at: number; promise: ReturnType<ConnectManagementClient["collectionModeStatus"]> } | undefined;

function loadSharing(client: ConnectManagementClient, id: string) {
  return Promise.all([client.collectionMembers(id), client.collectionInvitations(id)]);
}

export function prefetchAccount(client: ConnectManagementClient): void {
  if (account?.client === client && Date.now() - account.at < 5_000) return;
  account = { client, at: Date.now(), promise: client.account() };
  void account.promise.catch(() => {});
}

export function takeAccountPrefetch(client: ConnectManagementClient) {
  const pending = account;
  account = undefined;
  return pending?.client === client && Date.now() - pending.at < 5_000 ? pending.promise : undefined;
}

export function prefetchSharing(client: ConnectManagementClient, id: string): void {
  if (sharing?.client === client && sharing.id === id && Date.now() - sharing.at < 5_000) return;
  sharing = { client, id, at: Date.now(), promise: loadSharing(client, id) };
  void sharing.promise.catch(() => {});
}

export function takeSharingPrefetch(client: ConnectManagementClient, id: string) {
  const pending = sharing;
  sharing = undefined;
  return pending?.client === client && pending.id === id && Date.now() - pending.at < 5_000 ? pending.promise : undefined;
}

export function prefetchMode(client: ConnectManagementClient, id: string): void {
  if (mode?.client === client && mode.id === id && Date.now() - mode.at < 5_000) return;
  mode = { client, id, at: Date.now(), promise: client.collectionModeStatus(id) };
  void mode.promise.catch(() => {});
}

export function takeModePrefetch(client: ConnectManagementClient, id: string) {
  const pending = mode;
  mode = undefined;
  return pending?.client === client && pending.id === id && Date.now() - pending.at < 5_000 ? pending.promise : undefined;
}

export function clearPagePrefetch(): void { account = undefined; sharing = undefined; mode = undefined; }
