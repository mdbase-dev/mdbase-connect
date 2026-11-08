/** The app's unsynced collection: work before connecting (see
 * docs/architecture/work-before-connecting.md). A local-only replica in this
 * Worker, over the same SQL store, facade and setup journal as a synced
 * collection. No account, sign-in, log, control plane or stored keys: its
 * identifiers are random, kept in one IndexedDB row, and never leave this
 * browser. One per app storage scope; it is never listed as a collection. */
import { createAppCollectionSql, type AppCollectionSqlOptions, type AppLedgerRows } from "../app-storage/collection-sql.js";
import { AppCollectionSetupJournal, type AppCollectionSetupJournalOptions } from "./collection-setup-journal.js";
import { attachAppCollectionControl, type AppCollectionSetupTurn } from "./collection-control.js";
import { attachAppLocalFacade } from "./local-facade.js";
import { acquireAppReplicaLease, type AppLockPort, type AppReplicaLease, type AppReplicaScope } from "./owner.js";
import { AppWasmRuntime } from "./wasm-runtime.js";
import type { AppWebCollectionHandoff, AppWebNativeCollection } from "./web-collection.js";

const STORE = "unsynced", KEY = "current", WORK = "work";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** Tabs that may show the unsynced collection at once (as for a synced one). */
const MAX_TABS = 32;

export class AppUnsyncedCollectionError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "unavailable") {
    super(`app unsynced collection: ${reason}`); this.name = "AppUnsyncedCollectionError";
  }
}
const fail = (reason: AppUnsyncedCollectionError["reason"] = "unavailable") => new AppUnsyncedCollectionError(reason);

/** The row that names this browser's unsynced collection. */
export interface AppUnsyncedIdentity {
  readonly version: 1;
  /** Local placeholders: not an mdbase account or installation. */
  readonly account: string;
  readonly installation: string;
  readonly collection: string;
  readonly replica: string;
  readonly device: string;
}
/** Set once something has been saved in the unsynced collection: the app may
 * then offer to connect it. A marker, not a count; it is never cleared by
 * deleting records, only by discarding the collection. */
export interface AppUnsyncedWork {
  readonly version: 1;
  /** When the first change was saved (ms since the epoch). */
  readonly since: number;
}
export interface AppUnsyncedCollectionOptions {
  /** This app storage scope's own database (declaration storage). */
  readonly databaseName: string;
  readonly setupJournal: Omit<AppCollectionSetupJournalOptions, "scope" | "isCurrent">;
  readonly sql: AppCollectionSqlOptions;
  readonly locks: AppLockPort | undefined;
  loadRuntime(options: { signal: AbortSignal }): Promise<Uint8Array>;
}
/** An open unsynced collection. Every tab, the first included, takes its
 * ports with `attach`. */
export interface AppUnsyncedConnection extends AppWebNativeCollection {
  /** The latest semantic assessment a tab reported. */
  readonly state: "ready" | "setup_required";
  /** Null until the first change is submitted here. */
  readonly work: AppUnsyncedWork | null;
  attach(): AppWebCollectionHandoff | null;
  detach(handoff: AppWebCollectionHandoff): void;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

function identity(value: unknown): AppUnsyncedIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join() !== "account,collection,device,installation,replica,version") throw fail();
  const row = value as AppUnsyncedIdentity;
  const ids = [row.account, row.installation, row.collection, row.replica, row.device];
  if (row.version !== 1 || ids.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length) throw fail();
  return Object.freeze({...row});
}
function work(value: unknown): AppUnsyncedWork {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "since,version") throw fail();
  const row = value as AppUnsyncedWork;
  if (row.version !== 1 || !Number.isSafeInteger(row.since) || row.since < 0) throw fail();
  return Object.freeze({version: 1, since: row.since});
}
function database(name: string, signal: AbortSignal): Promise<IDBDatabase> {
  signal.throwIfAborted(); if (!globalThis.indexedDB) throw fail();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let abandoned = false;
    const finish = () => signal.removeEventListener("abort", stop);
    const stop = () => { abandoned = true; finish(); try { request.transaction?.abort(); } catch { /* already settled */ } reject(fail("fenced")); };
    signal.addEventListener("abort", stop, {once: true});
    request.onblocked = request.onerror = stop;
    request.onupgradeneeded = () => {
      try { if (abandoned || request.result.objectStoreNames.length) throw fail(); request.result.createObjectStore(STORE); }
      catch { try { request.transaction?.abort(); } catch { /* preserve */ } }
    };
    request.onsuccess = () => {
      finish();
      if (abandoned || request.result.objectStoreNames.length !== 1 || !request.result.objectStoreNames.contains(STORE)) { request.result.close(); reject(fail()); return; }
      resolve(request.result);
    };
  });
}
/** Read one row, adding `make()` first when it is absent and `make` is given
 * (one transaction, so racing Workers agree on one value). */
async function row<T>(databaseName: string, key: string, parse: (value: unknown) => T, make: (() => T) | null, signal: AbortSignal): Promise<T | null> {
  const db = await database(databaseName, signal);
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, make ? "readwrite" : "readonly", {durability: "strict"});
      let result: T | null = null, problem: unknown = null;
      tx.onabort = tx.onerror = () => reject(problem ?? fail());
      tx.oncomplete = () => resolve(result);
      const rows = tx.objectStore(STORE), read = rows.get(key);
      read.onsuccess = () => {
        try {
          if (read.result !== undefined) { result = parse(read.result); return; }
          if (!make) return;
          const made = parse(make());
          rows.add(made, key); result = made;
        } catch (error) { problem = error; tx.abort(); }
      };
    });
  } finally { db.close(); }
}
/** Read this scope's identity; with `create`, make it first. */
export function appUnsyncedIdentity(databaseName: string, create: boolean, signal: AbortSignal): Promise<AppUnsyncedIdentity | null> {
  return row(databaseName, KEY, identity, create ? () => ({version: 1, account: crypto.randomUUID(), installation: crypto.randomUUID(),
    collection: crypto.randomUUID(), replica: crypto.randomUUID(), device: crypto.randomUUID()}) : null, signal);
}
/** Whether this scope's unsynced collection holds work, without opening it or
 * creating its database. Null where the browser cannot list databases. */
export async function appUnsyncedWork(databaseName: string, signal: AbortSignal): Promise<AppUnsyncedWork | null> {
  const list = globalThis.indexedDB?.databases;
  if (typeof list !== "function") return null;
  const names = await list.call(globalThis.indexedDB);
  signal.throwIfAborted();
  if (!names.some(entry => entry.name === databaseName)) return null;
  return row(databaseName, WORK, work, null, signal);
}

/** Open (creating if needed) this scope's unsynced collection. Busy (another
 * Worker holds it) rejects with the replica owner's `busy`. */
export async function openAppUnsyncedCollection(options: AppUnsyncedCollectionOptions, displayName: string, parent: AbortSignal): Promise<AppUnsyncedConnection> {
  if (typeof options.loadRuntime !== "function" || typeof displayName !== "string" || !displayName.trim()) throw fail("binding");
  const openSql = createAppCollectionSql(options.sql);
  const id = await appUnsyncedIdentity(options.databaseName, true, parent);
  if (!id) throw fail();
  const scope: Readonly<AppReplicaScope> = Object.freeze({account: id.account, installation: id.installation, collection: id.collection});
  const life = new AbortController(), signal = AbortSignal.any([parent, life.signal]);
  let closed = false, closing: Promise<void> | null = null, lease: AppReplicaLease | null = null;
  let runtime: AppWasmRuntime | null = null, sqlClose: (() => Promise<void>) | null = null, fence: (() => void) | null = null;
  let journal: AppCollectionSetupJournal | null = null, ledger: AppLedgerRows | null = null;
  let assessment: "ready" | "setup_required" = "setup_required";
  let saved: AppUnsyncedWork | null = null, marking = false;
  let mode: AppWebCollectionHandoff["setupMode"] = "approved-new";
  const generation = crypto.randomUUID(), setupTurn: AppCollectionSetupTurn = {owner: null};
  const listeners = new Set<() => void>();
  const tabs = new Map<MessagePort, {data: MessageChannel; command: MessageChannel; facade: ReturnType<typeof attachAppLocalFacade>; control: ReturnType<typeof attachAppCollectionControl>}>();
  const current = () => !closed && !signal.aborted;
  const changed = () => { for (const listener of [...listeners]) try { listener(); } catch { /* observers do not own the replica */ } };
  // Commits confirm locally on a tick; a write ticks at once instead of on the timer.
  let ticking = false;
  const tick = () => {
    if (ticking || !current()) return; ticking = true;
    queueMicrotask(() => { ticking = false; try { if (current()) runtime?.tick(); } catch { void close().catch(() => {}); } });
  };
  // The first submit marks the collection as holding work (once per scope).
  const submitted = (method?: string) => {
    tick();
    if (method !== "submit" || saved || marking || !current()) return;
    marking = true;
    void row(options.databaseName, WORK, work, () => ({version: 1 as const, since: Date.now()}), signal)
      .then(value => { if (value && current()) { saved = value; changed(); } })
      .catch(() => { /* retried on the next submit */ })
      .finally(() => { marking = false; });
  };
  const drop = (handoff: AppWebCollectionHandoff) => {
    const tab = tabs.get(handoff.dataPort); if (!tab) return;
    tabs.delete(handoff.dataPort);
    try { tab.facade.close(); } catch { /* closed with the runtime */ }
    void tab.control.close().catch(() => {});
    for (const port of [tab.data.port1, tab.command.port1]) try { port.close(); } catch { /* already closed */ }
  };
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true; life.abort(); changed();
    let failed = false;
    for (const tab of [...tabs.values()]) {
      try { await tab.control.close(); } catch { failed = true; }
      try { tab.facade.close(); } catch { failed = true; }
      try { tab.data.port1.postMessage([1, JSON.stringify([scope.account, scope.installation, scope.collection]), "close"]); } catch { failed = true; }
      for (const port of [tab.data.port1, tab.data.port2, tab.command.port1, tab.command.port2]) try { port.close(); } catch { failed = true; }
    }
    tabs.clear();
    try { journal?.close(); } catch { failed = true; }
    try { const clean = await runtime?.close(); if (runtime && clean !== true) fence?.(); } catch { failed = true; fence?.(); }
    try { await sqlClose?.(); } catch { failed = true; }
    try { await lease?.release(); } catch { failed = true; }
    listeners.clear();
    if (failed) throw fail();
  })();
  try {
    lease = await acquireAppReplicaLease(options.locks, scope, signal);
    journal = new AppCollectionSetupJournal({...options.setupJournal, scope, isCurrent: current});
    const artifact = await options.loadRuntime({signal});
    if (!current()) throw fail("fenced");
    const sql = await openSql({scope, signal});
    sqlClose = () => sql.close(); fence = () => sql.sql.fence(); ledger = sql.ledger ?? null;
    if (!current()) throw fail("fenced");
    runtime = await AppWasmRuntime.create(new Uint8Array(artifact), sql.sql);
    if (!current()) throw fail("fenced");
    runtime.openUnsyncedConsuming({collection: id.collection, replicaId: id.replica, deviceId: id.device, opened: sql.opened, sqliteVersion: sql.sqliteVersion});
    // As for a synced collection: an interrupted setup is reconciled, never redone.
    const intent = await journal.load(signal);
    if (!current()) throw fail("fenced");
    saved = await row(options.databaseName, WORK, work, null, signal);
    if (!current()) throw fail("fenced");
    if (intent && intent.version !== 1 && (intent.phase === "attempted" || intent.phase === "confirmed")) mode = "reconcile-original";
    const native = runtime, local = Object.freeze({...scope, isCurrent: current});
    const attach = (): AppWebCollectionHandoff | null => {
      if (!current() || tabs.size >= MAX_TABS) return null;
      const data = new MessageChannel(), command = new MessageChannel();
      let control: ReturnType<typeof attachAppCollectionControl> | null = null, facade: ReturnType<typeof attachAppLocalFacade> | null = null;
      try {
        facade = attachAppLocalFacade(native, data.port1, local, submitted);
        let value: AppWebCollectionHandoff | null = null;
        control = attachAppCollectionControl(command.port1, {scope, generation}, {journal: journal!, resourceSetup: facade.resourceSetup, signal, isCurrent: current,
          ledger: () => current() ? ledger : null, setupTurn,
          assess(state) { if (!current()) return; if (assessment !== state) { assessment = state; changed(); } },
          // Nothing syncs, so visibility changes nothing here.
          foreground() {},
          onProtocolFailure() { if (value) drop(value); }});
        // Configured from the declaration with nothing to review: the collection
        // is this app's own and starts empty. Once configured, tabs only inspect.
        value = Object.freeze({schema: "mdbn-app-collection/1" as const, scope, generation, displayName,
          setupMode: mode === "reconcile-original" ? mode : assessment === "ready" ? "inspect" as const : "approved-new" as const,
          dataPort: data.port2, controlPort: command.port2, people: true as const});
        tabs.set(data.port2, {data, command, facade, control});
        return value;
      } catch {
        try { facade?.close(); } catch { /* not attached */ }
        void control?.close().catch(() => {});
        for (const port of [data.port1, data.port2, command.port1, command.port2]) port.close();
        return null;
      }
    };
    return Object.freeze({scope, generation, isCurrent: current, setForeground() {}, attach, detach: drop, close,
      get state() { return current() ? assessment : "setup_required" as const; },
      get work() { return saved; },
      subscribe(listener: () => void) { if (!current()) throw fail("fenced"); listeners.add(listener); return () => { listeners.delete(listener); }; },
    });
  } catch (error) { await close().catch(() => {}); throw error; }
}
