/** UX-011 sign-out erasure: this browser's local data for ONE installation of
 * one app. Every name is derived from the known scope (CP origin, local slot
 * owner, appId, account, connector, device, installation, collections), the
 * same derivations the stores use; nothing outside that scope is touched. */
import { LOG_TOKEN_DATABASE, eraseAppLogTokens } from "./log-token-cache.js";
import { uuidToBytes } from "../codec.js";

export interface AppSignOutEraseScope {
  readonly cpOrigin: string;
  readonly appId: string;
  /** Local slot owner (installation-store `owner`); absent for unlabelled slots. */
  readonly owner?: string;
  readonly storageNamespace?: string;
  /** Null when the ledger never reached that step (no account confirmed yet). */
  readonly accountId: string | null;
  readonly connectorId: string | null;
  readonly installationId: string | null;
  readonly deviceId: string | null;
  /** Collections this installation knew (approved or listed). */
  readonly collectionIds: readonly string[];
  /** App-scoped databases its collections use (join ledger, setup journal). */
  readonly databases: readonly string[];
  /** Fresh single-collection recovery actors cannot erase an earlier/global
   * slot, shared journals or other installations' token cache. */
  readonly isolated?: boolean;
}
export interface AppSignOutEraseResult {
  /** The installation ledger is gone: a reload starts signed out. */
  readonly ledger: boolean;
  /** Every other store was removed too. False leaves a leftover (a store in
   * use or a browser refusal); it is a diagnostic, never a reason to stay signed in. */
  readonly complete: boolean;
}

/** Bound for each deletion. A blocked IndexedDB delete stays queued in the
 * browser and completes when the last connection closes; sign-out only stops
 * waiting for it and reports it as incomplete. */
export const SIGN_OUT_ERASE_TIMEOUT_MS = 5_000;

const hex = (id: string) => Array.from(uuidToBytes(id), b => b.toString(16).padStart(2, "0")).join("");
const lower = (id: string) => { uuidToBytes(id); return id.toLowerCase(); };

function bounded<T>(work: Promise<T>, fallback: T, ms = SIGN_OUT_ERASE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work.catch(() => fallback), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); })])
    .finally(() => clearTimeout(timer));
}

/** True once deleted (or never existed). Every SDK store closes its own
 * connection on `versionchange`, so a delete is only blocked by a connection
 * that did not close (another tab of an older build): bounded, then false. */
function deleteDatabase(name: string): Promise<boolean> {
  return bounded(new Promise<boolean>(resolve => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    // onblocked: keep waiting (the delete stays queued) until the bound.
  }), false);
}

/** Exact database names for this scope, plus (where `indexedDB.databases()`
 * exists) collection-scoped stores of the same installation whose collection
 * is no longer listed, matched by the full account/connector/device/installation prefix. */
/** installation-store database names: [current slot, unlabelled v1 slot]. */
function ledgerNames(scope: AppSignOutEraseScope): readonly [string, string] {
  const cp = encodeURIComponent(scope.cpOrigin), unlabelled = `mdbase.app.installation.v1.${cp}.${scope.appId}`;
  return [scope.owner === undefined ? unlabelled : `mdbase.app.installation.v2.${cp}.${encodeURIComponent(scope.owner)}.${scope.appId}`, unlabelled];
}
async function otherDatabaseNames(scope: AppSignOutEraseScope, ledger: string, unlabelled: string): Promise<string[]> {
  const others = new Set<string>(scope.isolated ? [] : scope.databases);
  if (!scope.isolated && scope.storageNamespace === undefined) others.add(unlabelled); // an earlier unlabelled slot of this app (removed below when it is the current one)
  const { accountId: account, connectorId: connector, deviceId: device, installationId: installation } = scope;
  if (account && connector && device && installation) {
    const keyIds = [account, connector, device, installation].map(hex).join(".");
    others.add(`mdbase.app.device-key-kek.v1.${keyIds}`);
    others.add(`mdbase.app.device-keys.v1.${keyIds}`);
    others.add(`mdbase.app.noise.v1.${lower(installation)}.${lower(connector)}.${lower(device)}`);
    const prefix = [account, connector, device, installation].map(lower).join(".");
    const scoped = [`mdbase.app.cloud-copy-outcome.v1.${prefix}.`, `mdbase.app.private-bootstrap.v1.${prefix}.`];
    for (const collection of scope.collectionIds) {
      const id = lower(collection);
      for (const purpose of ["create", "join"]) others.add(`${scoped[0]}${id}.${purpose}`);
      for (const purpose of ["create", "enrol"]) others.add(`${scoped[1]}${id}.${purpose}`);
    }
    const list = (indexedDB as { databases?: () => Promise<readonly { name?: string }[]> }).databases;
    if (typeof list === "function") {
      const found = await bounded(list.call(indexedDB), [] as readonly { name?: string }[]);
      for (const { name } of found) if (name && scoped.some(p => name.startsWith(p))) others.add(name);
    }
  }
  others.delete(ledger);
  return [...others];
}

interface OpfsDirectory {
  keys(): AsyncIterable<string>;
  removeEntry(name: string, options: { recursive: true }): Promise<void>;
}
/** OPFS replica pools `.mdbase-app-<account>-<installation>-<collection>`
 * (app-storage `appPoolNames`). Their SQLite handles close with the native host. */
async function removeReplicas(account: string, installation: string): Promise<boolean> {
  const storage = (globalThis.navigator as { storage?: { getDirectory?: () => Promise<unknown> } } | undefined)?.storage;
  if (typeof storage?.getDirectory !== "function") return true; // no OPFS: nothing was stored there
  return bounded((async () => {
    const root = await storage.getDirectory!() as OpfsDirectory;
    const prefix = `.mdbase-app-${lower(account)}-${lower(installation)}-`, names: string[] = [];
    for await (const name of root.keys()) if (name.startsWith(prefix)) names.push(name);
    let ok = true;
    for (const name of names) { try { await root.removeEntry(name, { recursive: true }); } catch { ok = false; } }
    return ok;
  })(), false);
}

/** Forget one retired hosted scope's replica keys/data and bootstrap outcomes.
 * The original installation signing custody, other scopes, shared journals and
 * token cache remain untouched. Call only after that scope's native/SQL stop. */
export async function eraseAppCollectionAccess(scope: AppSignOutEraseScope, collectionId: string): Promise<boolean> {
  try {
    if (!globalThis.indexedDB || !scope.accountId || !scope.connectorId || !scope.deviceId || !scope.installationId) return false;
    const collection = lower(collectionId), prefix = [scope.accountId, scope.connectorId, scope.deviceId, scope.installationId].map(lower).join(".");
    const names = ["create", "join"].map(purpose => `mdbase.app.cloud-copy-outcome.v1.${prefix}.${collection}.${purpose}`);
    names.push(...["create", "enrol"].map(purpose => `mdbase.app.private-bootstrap.v1.${prefix}.${collection}.${purpose}`));
    const results = await Promise.all(names.map(deleteDatabase));
    const storage = (globalThis.navigator as {storage?: {getDirectory?: () => Promise<unknown>}} | undefined)?.storage;
    if (typeof storage?.getDirectory === "function") {
      const root = await storage.getDirectory() as OpfsDirectory;
      try { await root.removeEntry(`.mdbase-app-${lower(scope.accountId)}-${lower(scope.installationId)}-${collection}`, {recursive: true}); }
      catch (error) {if (!(error instanceof DOMException && error.name === "NotFoundError")) return false;}
    }
    return results.every(Boolean);
  } catch {return false;}
}

/** Run only after every connection/handle of this installation was closed and
 * the server sign-out was attempted. Never throws. */
export async function eraseAppInstallationData(scope: AppSignOutEraseScope): Promise<AppSignOutEraseResult> {
  if (!globalThis.indexedDB) return Object.freeze({ ledger: false, complete: false });
  const [current, unlabelled] = ledgerNames(scope);
  // The ledger first: it alone decides whether a reload restores the session.
  const ledger = await deleteDatabase(current);
  let others: string[] | null = null;
  try { others = await otherDatabaseNames(scope, current, unlabelled); } catch { /* malformed scope: leftovers reported below */ }
  // Preserve legacy default erasure. Namespace callers share the cache DB,
  // so they remove only their CP/connector/device records below.
  const results = others ? await Promise.all([...others, ...(scope.isolated || scope.storageNamespace !== undefined ? [] : [LOG_TOKEN_DATABASE])].map(deleteDatabase)) : [false];
  const tokens = scope.storageNamespace === undefined ? true : await bounded(eraseAppLogTokens(scope), false);
  const replicas = scope.accountId && scope.installationId ? await removeReplicas(scope.accountId, scope.installationId).catch(() => false) : true;
  return Object.freeze({ ledger, complete: ledger && tokens && replicas && results.every(Boolean) });
}
