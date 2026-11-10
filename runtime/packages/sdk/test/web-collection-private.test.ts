import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppWebCollectionAdapter, type AppWebCollectionHandoff, type AppWebNativeCollection } from "../src/app-host/web-collection.js";
import type { AppWebSignInSessionOptions } from "../src/app-host/web-sign-in-session.js";
import type { AppWebCloudCopyHost } from "../src/app-host/cloud-copy-host.js";
import { AppAccountKeyUnlockError, type AppAccountKeySecret } from "../src/app-host/account-key-host.js";
import type { AccountKeyMode } from "../src/private-account.js";
import type { AppLogHealth } from "../src/app-host/log-pump.js";

const scope = {account: "11111111-1111-4111-8111-111111111111", installation: "22222222-2222-4222-8222-222222222222", collection: "33333333-3333-4333-8333-333333333333"};
const journal = {databaseName: "notes.native-model-setup.v1", applicationNamespace: "notes-web", appOrigin: "https://app.example.test", cpOrigin: "https://cp.example.test"};
const JOIN = "notes.native-collection-join.v1";
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

function fixture(key: "keyed" | "locked" = "locked", mode: AccountKeyMode = "password", people = false) {
  const parent = new AbortController(), trace: string[] = [];
  const handoffs: AppWebCollectionHandoff[] = [];
  const host = {
    bootstrapCloudCopy: vi.fn(async () => {trace.push("join");}),
    bootstrapPrivateDevice: vi.fn(async (_input: {scope: typeof scope; collectionCurrent(): boolean; signal: AbortSignal}) => {trace.push("enrol");}),
    settlePrivateKey: vi.fn(async (_input: {signal: AbortSignal}): Promise<"keyed" | "locked"> => {trace.push("settle"); return key;}),
    accountKeyMode: vi.fn(async (_input: {signal: AbortSignal}): Promise<AccountKeyMode> => {trace.push("mode"); return mode;}),
    unlockAccountKey: vi.fn(async (_secret: AppAccountKeySecret, _input: {signal: AbortSignal; onMode?(mode: AccountKeyMode): void}) => {trace.push("unlock");}),
    registeredReceipt: () => ({installationId: scope.installation, deviceId: scope.account}),
    openCollectionSql: vi.fn(async () => {trace.push("sql");}), startCollectionLog: vi.fn(async () => {trace.push("log");}),
    waitForVerifiedRead: vi.fn(async () => {trace.push("read");}), openTimersPort: vi.fn<AppWebCloudCopyHost["openTimersPort"]>(() => null),
    attachDataFacade: vi.fn(() => {trace.push("facade");}), detachDataFacade: vi.fn((_port: MessagePort) => {}),
    driveCollection: vi.fn(async () => {trace.push("drive");}), wakeCollectionLog: vi.fn(async () => {trace.push("wake");}),
    pendingWrites: vi.fn(() => 0), initialSync: vi.fn((): string | null => null), transportHealth: vi.fn((): AppLogHealth | null => null), serverProblem: vi.fn(() => null),
    close: vi.fn(async () => {trace.push("host-close");}),
    peopleAuthority: vi.fn(() => {throw new Error("People is not admitted for a Private device");}),
  };
  const adapter = createAppWebCollectionAdapter({joinDatabaseName: JOIN, setupJournal: journal,
    sql: {wasmSha256: "00".repeat(32), maxWasmBytes: 1100000, loadWasm: async () => new Uint8Array(1), initialize: async () => ({})},
    handoff(value) {trace.push("handoff"); handoffs.push(value);}, people,
  });
  type Context = Parameters<AppWebSignInSessionOptions<AppWebNativeCollection>["openCollection"]>[0];
  const stages: string[] = [];
  const context: Context = {host: host as unknown as Context["host"], installation: {scope: {account: scope.account, installation: scope.installation}, isCurrent: () => !parent.signal.aborted}, scope: {...scope},
    collection: {collectionId: scope.collection, displayName: "Journal", role: "owner", mode: "private"}, setupPolicy: "explicit", signal: parent.signal, onProgress: stage => {stages.push(stage);}};
  const open = async () => {const result = await adapter(context); cleanup.push(async () => {parent.abort(); await result.close();}); return result;};
  return {context, open, host, parent, trace, stages, handoffs};
}
const joinMarkers = () => new Promise<number>((resolve, reject) => {
  const request = indexedDB.open(JOIN);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("original-join")) {db.close(); resolve(0); return;}
    const count = db.transaction("original-join").objectStore("original-join").count();
    count.onsuccess = () => {db.close(); resolve(count.result);}; count.onerror = () => {db.close(); reject(count.error);};
  };
});

describe("Private (e2e) collection on a first-party installation device", () => {
  it("opens an already-keyed device straight through the shared tail, with no cloud-copy bootstrap and no secret", async () => {
    const f = fixture("keyed");
    const opened = await f.open();
    expect(f.trace.slice(0, 5)).toEqual(["enrol", "sql", "log", "settle", "read"]);
    expect(f.host.bootstrapCloudCopy).not.toHaveBeenCalled();
    expect(f.host.accountKeyMode).not.toHaveBeenCalled();
    expect(f.host.unlockAccountKey).not.toHaveBeenCalled();
    expect(f.handoffs).toHaveLength(1);
    expect(opened.state).toBe("setup_required");
    expect(opened.locked).toBeNull();
    expect(f.stages).toEqual(["joining", "opening_store", "connecting_log", "syncing", "syncing", "checking_setup"]);
    // The cloud-copy join marker is neither written nor consulted: the enrol marker decides.
    expect(await joinMarkers()).toBe(1); // only the "synced" hint of the completed first catch-up
  });
  it("binds the private bootstrap to the exact scope and the adapter's own currentness", async () => {
    const f = fixture("keyed");
    await f.open();
    const input = f.host.bootstrapPrivateDevice.mock.calls[0]![0];
    expect(input.scope).toEqual(scope);
    expect(input.collectionCurrent()).toBe(true);
    f.parent.abort();
    expect(input.collectionCurrent()).toBe(false);
  });
  it("never requests People for a Private device, even when the app enables it", async () => {
    const f = fixture("keyed", "password", true);
    await f.open();
    expect(f.host.peopleAuthority).not.toHaveBeenCalled();
    expect(f.handoffs[0]!.people).toBeUndefined();
    // The handoff says why: the application layer admits it as a Private device scope.
    expect(f.handoffs[0]!.privateDevice).toBe(true);
  });
  it.each(["password", "strict", "none"] as const)("an enrolled but unkeyed device reads needs_unlock (%s) without waiting on a verified read", async mode => {
    const f = fixture("locked", mode);
    const opened = await f.open();
    expect(opened.state).toBe("needs_unlock");
    expect(opened.locked).toEqual({mode, unlocking: false, problem: null});
    expect(typeof opened.unlock).toBe("function");
    expect(f.trace).toEqual(["enrol", "sql", "log", "settle", "mode"]);
    expect(f.host.waitForVerifiedRead).not.toHaveBeenCalled();
    expect(f.handoffs).toHaveLength(0);
    // No data facade, extra tab ports, log drive or push while locked.
    expect(opened.connection.attach?.()).toBeNull();
    opened.connection.setForeground(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.host.driveCollection).not.toHaveBeenCalled();
    expect(f.host.wakeCollectionLog).not.toHaveBeenCalled();
    expect(f.host.attachDataFacade).not.toHaveBeenCalled();
  });
  it("fails the open when the account-key mode cannot be read: no mode is assumed", async () => {
    const f = fixture("locked"), error = new AppAccountKeyUnlockError("unavailable", "network");
    f.host.accountKeyMode.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.handoffs).toHaveLength(0);
  });
  it("a failed key check fails the open and never falls through to the cloud-copy path", async () => {
    const f = fixture("locked"), error = new Error("stalled");
    f.host.settlePrivateKey.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.host.bootstrapCloudCopy).not.toHaveBeenCalled();
    expect(f.host.waitForVerifiedRead).not.toHaveBeenCalled();
  });
  it("unlock continues the SAME open to ready: one handoff, no second enrolment, no reload", async () => {
    const f = fixture("locked");
    const opened = await f.open(), seen: unknown[] = [];
    opened.subscribe!(() => {seen.push([opened.state, opened.locked]);});
    let release!: () => void;
    f.host.unlockAccountKey.mockImplementationOnce(async () => {f.trace.push("unlock"); await new Promise<void>(resolve => {release = resolve;});});
    const secret = {password: "correct horse battery staple"};
    const work = opened.unlock!(secret);
    expect(opened.locked).toEqual({mode: "password", unlocking: true, problem: null});
    // A second unlock while one runs is refused, not queued.
    await expect(opened.unlock!(secret)).rejects.toMatchObject({reason: "binding"});
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release(); await work;
    expect(f.host.unlockAccountKey).toHaveBeenCalledOnce();
    expect(f.host.unlockAccountKey.mock.calls[0]![0]).toBe(secret);
    expect(f.trace).toEqual(["enrol", "sql", "log", "settle", "mode", "unlock", "read", "facade", "handoff"]);
    expect(f.host.bootstrapPrivateDevice).toHaveBeenCalledOnce();
    expect(f.host.openCollectionSql).toHaveBeenCalledOnce();
    expect(opened.state).toBe("setup_required");
    expect(opened.locked).toBeNull();
    expect(opened.unlock).toBeTypeOf("function");
    // Locked (unlocking) until the handoff was delivered, then open.
    expect(seen[0]).toEqual(["needs_unlock", {mode: "password", unlocking: true, problem: null}]);
    expect(seen.at(-1)).toEqual(["setup_required", null]);
    expect(opened.connection.attach?.()).not.toBeNull();
    // Unlocking an open collection is refused.
    await expect(opened.unlock!(secret)).rejects.toMatchObject({reason: "binding"});
  });
  it.each(["wrong_secret", "invalid_recovery_key", "rate_limited", "unlock_strict", "no_account_key", "unlock_unavailable", "unlock_failed", "unavailable"] as const)(
    "a typed unlock refusal (%s) returns to needs_unlock with the problem, and another attempt can succeed", async reason => {
      const f = fixture("locked");
      const opened = await f.open();
      f.host.unlockAccountKey.mockRejectedValueOnce(new AppAccountKeyUnlockError(reason));
      await opened.unlock!({password: "not the password"});
      expect(opened.state).toBe("needs_unlock");
      expect(opened.locked).toEqual({mode: "password", unlocking: false, problem: reason});
      expect(f.host.close).not.toHaveBeenCalled();
      expect(f.host.waitForVerifiedRead).not.toHaveBeenCalled();
      expect(f.handoffs).toHaveLength(0);
      await opened.unlock!({recoveryKey: "AAAA-BBBB"});
      expect(opened.state).toBe("setup_required");
      expect(f.handoffs).toHaveLength(1);
    });
  it("shows the account-key mode the unlock itself read", async () => {
    const f = fixture("locked", "password");
    const opened = await f.open();
    f.host.unlockAccountKey.mockImplementationOnce(async (_secret, input) => {input.onMode?.("strict"); throw new AppAccountKeyUnlockError("unlock_strict");});
    await opened.unlock!({password: "anything at all"});
    expect(opened.locked).toEqual({mode: "strict", unlocking: false, problem: "unlock_strict"});
  });
  it("any other unlock failure closes this adapter and rejects: it is not reported as a wrong secret", async () => {
    const f = fixture("locked");
    const opened = await f.open(), error = new Error("owner lost");
    f.host.unlockAccountKey.mockRejectedValueOnce(error);
    await expect(opened.unlock!({password: "correct horse battery staple"})).rejects.toBe(error);
    expect(opened.state).toBe("setup_required");
    expect(opened.locked).toBeNull();
    expect(opened.connection.isCurrent()).toBe(false);
    expect(f.handoffs).toHaveLength(0);
  });
  it("a failed open after a successful unlock closes the adapter instead of reading unlocked", async () => {
    const f = fixture("locked");
    const opened = await f.open(), error = new Error("no verified read");
    f.host.waitForVerifiedRead.mockRejectedValueOnce(error);
    await expect(opened.unlock!({password: "correct horse battery staple"})).rejects.toBe(error);
    expect(opened.connection.isCurrent()).toBe(false);
    expect(f.handoffs).toHaveLength(0);
  });
  it("a typed refusal that arrives after the owner ended is not shown as a retryable problem", async () => {
    const f = fixture("locked");
    const opened = await f.open(), error = new AppAccountKeyUnlockError("wrong_secret");
    f.host.unlockAccountKey.mockImplementationOnce(async () => {f.parent.abort(); throw error;});
    await expect(opened.unlock!({password: "correct horse battery staple"})).rejects.toBe(error);
    expect(opened.locked).toBeNull();
  });
  it("a cloud copy entry is unchanged: no private call, no unlock action", async () => {
    const f = fixture("keyed");
    (f.context as {collection: unknown}).collection = {collectionId: scope.collection, displayName: "Journal", role: "owner"};
    const opened = await f.open();
    expect(f.trace.slice(0, 4)).toEqual(["join", "sql", "log", "read"]);
    expect(f.host.bootstrapPrivateDevice).not.toHaveBeenCalled();
    expect(f.host.settlePrivateKey).not.toHaveBeenCalled();
    expect(opened.unlock).toBeUndefined();
    expect(opened.locked).toBeNull();
  });
});
