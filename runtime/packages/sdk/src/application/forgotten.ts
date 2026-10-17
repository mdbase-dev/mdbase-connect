/**
 * SDK-3: collections the person hid on this device ("Forget"), per account.
 * Presentation only: forgetting never revokes access or deletes anything, and
 * a later approval of the same collection shows it again. Kept in this
 * browser's localStorage so it survives reloads; signing out removes it.
 */
export interface ApplicationForgottenStore {
  /** The hidden collection IDs for this account. */
  read(account: string | null | undefined): ReadonlySet<string>;
  add(account: string, collectionId: string): void;
  /** Show a collection again (it was approved again). True when it was hidden. */
  remove(account: string, collectionId: string): boolean;
  clear(): void;
}

const MAX = 1024;
const EMPTY: ReadonlySet<string> = Object.freeze(new Set<string>());

export function applicationForgotten(namespace: string, cpOrigin: string): ApplicationForgottenStore {
  const key = `mdbase.${namespace}.forgotten-collections.v1.${encodeURIComponent(cpOrigin)}`;
  const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
  let cached: { raw: string | null; account: string | null; ids: ReadonlySet<string> } | null = null;
  const load = (): { account: string | null; ids: ReadonlySet<string>; raw: string | null } => {
    let raw: string | null = null;
    try { raw = storage()?.getItem(key) ?? null; } catch { /* unavailable: nothing hidden */ }
    if (cached && cached.raw === raw) return cached;
    let account: string | null = null, ids: ReadonlySet<string> = EMPTY;
    try {
      const parsed = raw ? JSON.parse(raw) as { v?: unknown; account?: unknown; ids?: unknown } : null;
      if (parsed?.v === 1 && typeof parsed.account === "string" && parsed.account.length <= 64 && Array.isArray(parsed.ids) && parsed.ids.length <= MAX
        && parsed.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 64)) {
        account = parsed.account; ids = Object.freeze(new Set(parsed.ids as string[]));
      }
    } catch { /* malformed: nothing hidden */ }
    cached = { raw, account, ids };
    return cached;
  };
  const save = (account: string, ids: ReadonlySet<string>) => {
    try {
      if (!ids.size) storage()?.removeItem(key);
      else storage()?.setItem(key, JSON.stringify({ v: 1, account, ids: [...ids].slice(-MAX) }));
    } catch { /* optional: hidden for this page only */ }
    cached = null;
  };
  return Object.freeze({
    read(account: string | null | undefined) {
      const s = load();
      return account && s.account === account ? s.ids : EMPTY;
    },
    add(account: string, collectionId: string) {
      const s = load(), ids = new Set(s.account === account ? s.ids : []);
      if (ids.has(collectionId)) return;
      ids.add(collectionId); save(account, ids);
    },
    remove(account: string, collectionId: string) {
      const s = load();
      if (s.account !== account || !s.ids.has(collectionId)) return false;
      const ids = new Set(s.ids); ids.delete(collectionId); save(account, ids);
      return true;
    },
    clear() { try { storage()?.removeItem(key); } catch { /* optional */ } cached = null; },
  });
}
