export interface CollectionCreationIntent {
  accountId: string;
  requestId: string;
  displayName: string;
  timezone: string;
}
const key = (account: string) => `mdbase.connect.collection-creation:${account}`;
/** Only display metadata and a nonce, never credentials or content authority. */
export function readCollectionCreation(account: string): CollectionCreationIntent | null {
  try {
    const raw = localStorage.getItem(key(account));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const intent = value as Partial<CollectionCreationIntent>;
    if (intent.accountId !== account || typeof intent.requestId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(intent.requestId)
      || typeof intent.displayName !== "string" || !intent.displayName.trim() || intent.displayName.length > 200 || typeof intent.timezone !== "string") return null;
    return {accountId:account,requestId:intent.requestId,displayName:intent.displayName,timezone:intent.timezone};
  } catch {return null;}
}
export function keepCollectionCreation(intent: CollectionCreationIntent): void {
  localStorage.setItem(key(intent.accountId), JSON.stringify(intent));
}
export function finishCollectionCreation(intent: CollectionCreationIntent): void {
  const current = readCollectionCreation(intent.accountId);
  if (current?.requestId === intent.requestId) localStorage.removeItem(key(intent.accountId));
}
