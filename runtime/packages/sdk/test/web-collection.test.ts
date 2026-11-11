import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppWebCollectionAdapter, openAppWebCollectionClient, type AppWebCollectionHandoff } from "../src/app-host/web-collection.js";
import { AppCollectionSetupJournal } from "../src/app-host/collection-setup-journal.js";
import { appCollectionControlClient } from "../src/app-host/collection-control.js";
import { AppCollectionJoinLedger } from "../src/app-host/collection-join-ledger.js";
import type { AppWebSignInSessionOptions } from "../src/app-host/web-sign-in-session.js";
import type { AppWebNativeCollection } from "../src/app-host/web-collection.js";
import { MdbaseClient } from "../src/client.js";
import { AppCpAuthorityError } from "../src/app-host/cp-authority.js";
import { appServerProblem } from "../src/app-host/cp-problem.js";
import { attachAppTimerReceiver } from "../src/app-host/timer-port.js";
import type { AppLogHealth } from "../src/app-host/log-pump.js";
import type { AppWebCloudCopyHost } from "../src/app-host/cloud-copy-host.js";
const scope = {account: "11111111-1111-4111-8111-111111111111", installation: "22222222-2222-4222-8222-222222222222", collection: "33333333-3333-4333-8333-333333333333"};
const options = {databaseName: "tasknotes.native-model-setup.v1", applicationNamespace: "tasknotes-web", appOrigin: "https://app.example.test", cpOrigin: "https://cp.example.test"};
const hash = "sha256:" + "ab".repeat(32);
const plan = {pack: {id: "sample", version: "1", digest: hash}, assessmentDigest: hash, ops: [{kind: "resource_put" as const, path: "_types/sample.md", doc: "original source", mustNotExist: true}], readback: [{path: "_types/sample.md", doc: "original source"}]};
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
function fixture(policy: "explicit" | "approved-new-collection" = "explicit", people = false) {
  const parent = new AbortController(), ui = new AbortController(), trace: string[] = [];
  let handoff: AppWebCollectionHandoff | undefined;
  const host = {
    bootstrapCloudCopy: vi.fn(async (_input: {purpose: string; outcomeMode: string; scope: typeof scope; reconcile?: string}) => {trace.push("join");}), registeredReceipt: () => ({installationId: scope.installation, deviceId: scope.account}),
    openCollectionSql: vi.fn(async () => {trace.push("sql");}), startCollectionLog: vi.fn(async () => {trace.push("log");}),
    waitForVerifiedRead: vi.fn(async () => {trace.push("read");}), openTimersPort: vi.fn<AppWebCloudCopyHost["openTimersPort"]>(()=>null), attachDataFacade: vi.fn(() => {trace.push("facade");}), detachDataFacade: vi.fn((_port: MessagePort) => {}),
    driveCollection: vi.fn(async () => {}), wakeCollectionLog: vi.fn(async () => {}),
    pendingWrites: vi.fn(() => 0), initialSync: vi.fn((): string | null => null), transportHealth: vi.fn((): AppLogHealth | null => null), serverProblem: vi.fn(() => null), close: vi.fn(async () => {trace.push("host-close");}),
    peopleAuthority: vi.fn(() => Object.freeze({collection: scope.collection, isCurrent: () => !parent.signal.aborted,
      request: vi.fn(async (resource: "identity" | "members") => resource === "identity" ?
        {issuer: "https://issuer.example", subject: "original-subject", name: "Original person", person_settings_url: "https://cp.example/settings", private_token: "must-not-cross"} : {members: []}),
    })),
  };
  const adapter = createAppWebCollectionAdapter({joinDatabaseName: "tasknotes.native-collection-join.v1", setupJournal: options,
    sql: {wasmSha256: "00".repeat(32), maxWasmBytes: 1100000, loadWasm: async () => new Uint8Array(1), initialize: async () => ({})},
    handoff(value) {trace.push("handoff"); handoff = value;}, people,
  });
  type Context = Parameters<AppWebSignInSessionOptions<AppWebNativeCollection>["openCollection"]>[0];
  const context: Context = {host: host as unknown as Context["host"], installation: {scope: {account: scope.account, installation: scope.installation}, isCurrent: () => !parent.signal.aborted}, scope: {...scope},
    collection: {collectionId: scope.collection, displayName: "My collection", role: "owner"}, setupPolicy: policy, signal: parent.signal};
  const open = async () => {const result = await adapter(context); cleanup.push(async () => {parent.abort(); await result.close(); ui.abort();}); return result;};
  return {adapter, context, open, host, parent, ui, trace, handoff: () => handoff!};
}
/** Leave the join ledger saying this replica completed a sync before. */
async function syncedBefore() {
  const f = fixture(); await f.open();
  await vi.waitFor(async () => expect(await new AppCollectionJoinLedger({databaseName: "tasknotes.native-collection-join.v1", scope, isCurrent: () => true})
    .syncedBefore({signal: new AbortController().signal})).toBe(true));
  for (const close of cleanup.splice(0)) await close();
}
describe("a replica that synced before opens from this device", () => {
  it("hands off without waiting for the log token, then binds the log in its first turn", async () => {
    await syncedBefore();
    const f = fixture(), stages: string[] = [];
    f.context.onProgress = stage => stages.push(stage);
    let minted!: () => void;
    f.host.startCollectionLog.mockImplementationOnce(() => new Promise<void>(resolve => {minted = () => {f.trace.push("log"); resolve();};}));
    const result = await f.open();
    expect(f.trace).toEqual(["join", "sql", "read", "facade", "handoff"]);
    expect(stages).toEqual(["joining", "opening_store", "checking_setup"]);
    expect(f.host.waitForVerifiedRead).toHaveBeenCalledOnce();
    // A shorter budget than a waited read: a replica that does not answer falls back sooner.
    expect(f.host.waitForVerifiedRead).toHaveBeenCalledWith({signal: expect.any(AbortSignal), local: true, timeoutMs: 5_000, onProgress: expect.any(Function)});
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce(); // started alongside, not awaited
    expect(result.state).toBe("setup_required"); expect(result.failure).toBeNull(); expect(result.health).toBeNull(); expect(result.live).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.host.driveCollection).not.toHaveBeenCalled(); // nothing drives an unbound log
    minted();
    await vi.waitFor(() => expect(f.host.driveCollection).toHaveBeenCalled());
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce(); // the first turn took the request already under way
    expect(result.live).toBe(false); // this host has no push socket: paused once bound
  });
  it("offline: stays open on its replica, shows offline, and binds when a tab reports it is back", async () => {
    await syncedBefore();
    vi.stubGlobal("navigator", {onLine: false});
    const f = fixture();
    let fail!: (error: unknown) => void;
    f.host.startCollectionLog.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {fail = reject;}));
    const result = await f.open(), seen = vi.fn(); result.subscribe!(seen);
    expect(f.trace.at(-1)).toBe("handoff");
    fail(new AppCpAuthorityError("unavailable")); // answered once someone is listening
    await vi.waitFor(() => expect(result.health).toEqual({kind: "offline"}));
    expect(seen).toHaveBeenCalled(); expect(result.failure).toBeNull(); expect(result.connection.isCurrent()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce(); // offline waits for an event, not a timer
    vi.stubGlobal("navigator", {onLine: true});
    result.connection.setForeground(true);
    await vi.waitFor(() => expect(f.host.driveCollection).toHaveBeenCalled());
    expect(f.host.startCollectionLog).toHaveBeenCalledTimes(2);
    expect(result.health).toBeNull();
  });
  it("unreachable or busy: retries with the drive loop's backoff", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      await syncedBefore();
      const f = fixture();
      f.host.startCollectionLog.mockRejectedValueOnce(new AppCpAuthorityError("unavailable", appServerProblem(503, {error: {code: "busy"}})))
        .mockRejectedValueOnce(new AppCpAuthorityError("unavailable", appServerProblem(429, {error: {code: "rate_limited"}})));
      const result = await f.open();
      await vi.waitFor(() => expect(result.health).toEqual({kind: "server_busy", retryAfterMs: null}));
      await vi.advanceTimersByTimeAsync(2_500);
      expect(result.health).toEqual({kind: "rate_limited", retryAfterMs: null});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.host.startCollectionLog).toHaveBeenCalledTimes(3);
      expect(f.host.driveCollection).toHaveBeenCalled(); expect(result.failure).toBeNull(); expect(result.health).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it.each([400, 401, 403, 404, 409])("a log refusal (HTTP %s) is reported for the session to block, and nothing retries", async status => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      await syncedBefore();
      const f = fixture(), error = new AppCpAuthorityError("unavailable", appServerProblem(status, {error: {code: status === 409 ? "not_enrolled" : "invalid_proof"}}));
      let fail!: (error: unknown) => void;
      f.host.startCollectionLog.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {fail = reject;}));
      const result = await f.open(), seen = vi.fn(); result.subscribe!(seen);
      fail(error); // answered once someone is listening
      await vi.waitFor(() => expect(result.failure).toBe(error));
      expect(seen).toHaveBeenCalled(); expect(result.health).toBeNull(); expect(result.problem).toBeNull();
      result.connection.setForeground(true);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
      expect(f.host.driveCollection).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("a reply that is not Connect's (a network sign-in page) is unreachable, not a refusal", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      await syncedBefore();
      const f = fixture();
      f.host.startCollectionLog.mockRejectedValueOnce(new AppCpAuthorityError("response"));
      const result = await f.open();
      await vi.waitFor(() => expect(result.health).toEqual({kind: "unreachable"}));
      expect(result.failure).toBeNull(); expect(result.connection.isCurrent()).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.host.startCollectionLog).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(f.host.driveCollection).toHaveBeenCalled());
      expect(result.health).toBeNull(); expect(result.failure).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("a replica whose keys do not come back from the log is refused as a waited open refuses it", async () => {
    await syncedBefore();
    const f = fixture(), keyringSettled = vi.fn<() => "pending" | "failed" | "settled">(() => "pending");
    Object.assign(f.host, {keyringSettled});
    const result = await f.open();
    await vi.waitFor(() => expect(keyringSettled).toHaveBeenCalled());
    expect(result.failure).toBeNull();
    keyringSettled.mockReturnValue("failed");
    result.connection.setForeground(true);
    await vi.waitFor(() => expect(result.failure).toMatchObject({name: "AppCloudCopyHostError", reason: "recovery_required"}));
  });
  it("stops asking about the keys once they are back", async () => {
    await syncedBefore();
    const f = fixture(), keyringSettled = vi.fn<() => "pending" | "failed" | "settled">(() => "settled");
    Object.assign(f.host, {keyringSettled});
    const result = await f.open();
    await vi.waitFor(() => expect(keyringSettled).toHaveBeenCalledOnce());
    const turns = f.host.driveCollection.mock.calls.length + f.host.wakeCollectionLog.mock.calls.length;
    result.connection.setForeground(true);
    await vi.waitFor(() => expect(f.host.driveCollection.mock.calls.length + f.host.wakeCollectionLog.mock.calls.length).toBeGreaterThan(turns));
    expect(keyringSettled).toHaveBeenCalledOnce(); expect(result.failure).toBeNull();
  });
  it("a waited open never asks: its read gate already settled the keys", async () => {
    const f = fixture(), keyringSettled = vi.fn(() => "failed" as const);
    Object.assign(f.host, {keyringSettled});
    const result = await f.open();
    await vi.waitFor(() => expect(f.host.driveCollection).toHaveBeenCalled());
    expect(keyringSettled).not.toHaveBeenCalled(); expect(result.failure).toBeNull();
  });
  it("work queued before the log is bound binds it at once, in a hidden tab too", async () => {
    await syncedBefore();
    const f = fixture(); let work: (() => void) | null = null;
    Object.assign(f.host, {onLogWork: vi.fn((kick: (() => void) | null) => {work = kick;})});
    f.host.startCollectionLog.mockRejectedValueOnce(new AppCpAuthorityError("unavailable"));
    vi.stubGlobal("navigator", {onLine: false});
    const result = await f.open();
    await vi.waitFor(() => expect(result.health).toEqual({kind: "offline"}));
    result.connection.setForeground(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce(); // hidden and offline: nothing asks again
    vi.stubGlobal("navigator", {onLine: true});
    work!(); // a write: the host has log work
    await vi.waitFor(() => expect(f.host.driveCollection).toHaveBeenCalled());
    expect(f.host.startCollectionLog).toHaveBeenCalledTimes(2);
  });
  // Before the first turn has taken the request, and after: close waits for a
  // turn under way, which ends when the host's request honours the abort.
  it.each([0, 20])("closing while the token request is still out neither binds nor reports a failure (%i ms in)", async wait => {
    await syncedBefore();
    const f = fixture(); let refuse!: (error: unknown) => void;
    f.host.startCollectionLog.mockImplementationOnce(((options: {signal: AbortSignal}) => new Promise<void>((_resolve, reject) => {
      refuse = reject; options.signal.addEventListener("abort", () => reject(options.signal.reason), {once: true});
    })) as () => Promise<void>);
    const result = await f.open(), seen = vi.fn(); result.subscribe!(seen);
    await new Promise(resolve => setTimeout(resolve, wait));
    await result.close(); seen.mockClear();
    refuse(new AppCpAuthorityError("unavailable", appServerProblem(403, {error: {code: "invalid_proof"}})));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen).not.toHaveBeenCalled(); expect(result.failure).toBeNull();
    expect(f.host.driveCollection).not.toHaveBeenCalled(); expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
  });
  it("a collection being upgraded stays open with that live problem and is asked again later", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      await syncedBefore();
      const f = fixture(), server = appServerProblem(503, {error: {code: "collection_migrating"}}, new Headers({"retry-after": "7"}));
      f.host.startCollectionLog.mockRejectedValueOnce(new AppCpAuthorityError("unavailable", server));
      const result = await f.open();
      await vi.waitFor(() => expect(result.problem).toBe(server));
      expect(result.failure).toBeNull(); expect(result.health).toBeNull();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(f.host.startCollectionLog).toHaveBeenCalledOnce(); // the server's delay, not the turn's
      await vi.advanceTimersByTimeAsync(4_000);
      expect(f.host.startCollectionLog).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(f.host.driveCollection).toHaveBeenCalled());
      expect(result.problem).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("a replica that cannot answer by itself takes the ordinary path: log, verified read, warm wait", async () => {
    await syncedBefore();
    const f = fixture();
    f.host.waitForVerifiedRead.mockRejectedValueOnce(new Error("needs the log"));
    await f.open();
    expect(f.trace).toEqual(["join", "sql", "log", "read", "facade", "handoff"]);
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
    expect(f.host.waitForVerifiedRead).toHaveBeenLastCalledWith({signal: expect.any(AbortSignal), cold: false, onProgress: expect.any(Function)});
  });
  it("the ordinary path still fails the open when the log is refused", async () => {
    await syncedBefore();
    const f = fixture(), error = new AppCpAuthorityError("unavailable", appServerProblem(403, {error: {code: "invalid_proof"}}));
    f.host.waitForVerifiedRead.mockRejectedValueOnce(new Error("needs the log"));
    f.host.startCollectionLog.mockRejectedValue(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.trace).not.toContain("handoff");
  });
  it("a Private device keeps the wait for its log", async () => {
    await syncedBefore();
    const f = fixture();
    Object.assign(f.host, {bootstrapPrivateDevice: vi.fn(async () => {f.trace.push("enrol");}), settlePrivateKey: vi.fn(async () => {f.trace.push("key"); return "keyed";})});
    f.context.collection = {...f.context.collection, mode: "private"};
    await f.open();
    expect(f.trace).toEqual(["enrol", "sql", "log", "key", "read", "facade", "handoff"]);
    expect(f.host.waitForVerifiedRead).toHaveBeenCalledWith({signal: expect.any(AbortSignal), cold: false, onProgress: expect.any(Function)});
  });
});
describe("real protected native collection composition", () => {
  it("reports actual opening boundaries without changing the single bootstrap or READ gate", async () => {
    const f = fixture(), stages: string[] = [];
    f.context.onProgress = stage => stages.push(stage);
    await f.open();
    expect(stages).toEqual(["joining", "opening_store", "connecting_log", "syncing", "checking_setup"]);
    expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
    expect(f.host.waitForVerifiedRead).toHaveBeenCalledOnce();
  });
  it("display callback failure cannot interrupt opening or authorize another bootstrap", async () => {
    const f = fixture(); f.context.onProgress = () => {throw Error("observer");};
    await f.open();
    expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
    expect(f.trace).toContain("handoff");
  });
  it("retries an initial busy mint on the SAME host without repeating device enrollment", async () => {
    const f = fixture();
    f.host.startCollectionLog.mockRejectedValueOnce(new AppCpAuthorityError("unavailable",
      appServerProblem(503, {error: {code: "busy"}}, new Headers({"retry-after": "1"}))));
    const outcome = await f.open().then(result => ({kind: "opened", result}), error => ({kind: error.reason, error}));
    expect(outcome.kind).toBe("opened");
    expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
    expect(f.host.openCollectionSql).toHaveBeenCalledOnce();
    expect(f.host.startCollectionLog).toHaveBeenCalledTimes(2);
    expect(f.host.close).not.toHaveBeenCalled();
    expect(f.trace.filter(x => x === "handoff")).toHaveLength(1);
  }, 15_000);
  it.each([400,401,403,404,409,429,500,502,504])("does not retry bare unavailable from auth/identity/invariant HTTP %s", async status => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable",
      appServerProblem(status, {error: {code: status===409 ? "not_enrolled" : "invalid_proof"}}));
    f.host.startCollectionLog.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
    expect(f.trace).not.toContain("handoff");
  });
  it.each(["unavailable", "not_ready", "invalid_proof"])("does not retry unknown 503 code %s", async code => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable", appServerProblem(503, {error: {code}}));
    f.host.startCollectionLog.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
    expect(f.trace).not.toContain("handoff");
  });
  it("does not infer retry authority from a forged busy detail or a bare unavailable error", async () => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable",
      {...appServerProblem(503, {error: {code: "busy"}})});
    f.host.startCollectionLog.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
  });
  it("does not retry generic unavailable without a parsed busy response", async () => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable");
    f.host.startCollectionLog.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
  });
  it("stops when a second busy Retry-After cannot fit the remaining scheduling window", async () => {
    const f = fixture();
    const first = new AppCpAuthorityError("unavailable", appServerProblem(503, {error: {code: "busy"}}, new Headers({"retry-after": "10"})));
    const second = new AppCpAuthorityError("unavailable", appServerProblem(503, {error: {code: "busy"}}, new Headers({"retry-after": "6"})));
    let rejectFirst!: (error: unknown) => void;
    f.host.startCollectionLog.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectFirst = reject;})).mockRejectedValueOnce(second);
    const work = f.open(), rejected = expect(work).rejects.toBe(second);
    await vi.waitFor(() => expect(f.host.startCollectionLog).toHaveBeenCalledOnce());
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    try {
      rejectFirst(first); await vi.advanceTimersByTimeAsync(10_000); await rejected;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.host.startCollectionLog).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
      expect(f.trace).not.toContain("handoff");
    } finally {vi.useRealTimers();}
  });
  it("does not shorten a server busy wait that exceeds the initial retry window", async () => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable",
      appServerProblem(503, {error: {code: "busy"}}, new Headers({"retry-after": "60"})));
    f.host.startCollectionLog.mockRejectedValueOnce(error);
    await expect(f.open()).rejects.toBe(error);
    expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
  });
  it("bounds repeated initial busy refusals to three SAME-host attempts and releases the retry timer", async () => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable", appServerProblem(503, {error: {code: "busy"}}));
    let rejectFirst!: (error: unknown) => void;
    f.host.startCollectionLog.mockRejectedValue(error).mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectFirst = reject;}));
    const work = f.open(), rejected = expect(work).rejects.toBe(error);
    await vi.waitFor(() => expect(f.host.startCollectionLog).toHaveBeenCalledOnce());
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    try {
      rejectFirst(error);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_001); await rejected;
      expect(f.host.startCollectionLog).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.host.startCollectionLog).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
      expect(f.host.openCollectionSql).toHaveBeenCalledOnce();
      expect(f.host.waitForVerifiedRead).not.toHaveBeenCalled();
      expect(f.trace).not.toContain("handoff");
    } finally {vi.useRealTimers();}
  });
  it("aborts initial busy backoff without another mint, enrollment or data handoff", async () => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable", appServerProblem(503, {error: {code: "busy"}}));
    let rejectFirst!: (error: unknown) => void;
    f.host.startCollectionLog.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectFirst = reject;}));
    const work = f.open(), rejected = expect(work).rejects.toBeDefined();
    await vi.waitFor(() => expect(f.host.startCollectionLog).toHaveBeenCalledOnce());
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    try {
      rejectFirst(error); await vi.advanceTimersByTimeAsync(100);
      f.parent.abort(); await rejected;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
      expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
      expect(f.trace).not.toContain("handoff");
    } finally {vi.useRealTimers();}
  });
  it("honors the sanitized busy Retry-After before retrying or handing off data", async () => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable",
      appServerProblem(503, {error: {code: "busy"}}, new Headers({"retry-after": "1"})));
    let rejectFirst!: (error: unknown) => void;
    f.host.startCollectionLog.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectFirst = reject;}));
    const work = f.open();
    await vi.waitFor(() => expect(f.host.startCollectionLog).toHaveBeenCalledOnce());
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    try {
      rejectFirst(error); await vi.advanceTimersByTimeAsync(4_999);
      expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
      expect(f.trace).not.toContain("handoff");
      await vi.advanceTimersByTimeAsync(251);
      const result = await work;
      expect(f.host.startCollectionLog).toHaveBeenCalledTimes(2);
      expect(f.host.bootstrapCloudCopy).toHaveBeenCalledOnce();
      expect(f.trace.filter(value => value === "handoff")).toHaveLength(1);
      await result.close(); expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
  it.each(["host", "scope", "installation"])("fences %s drift during initial busy backoff without borrowing a new host", async variant => {
    const f = fixture(), error = new AppCpAuthorityError("unavailable", appServerProblem(503, {error: {code: "busy"}}));
    let rejectFirst!: (error: unknown) => void;
    f.host.startCollectionLog.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectFirst = reject;}));
    const work = f.open(), rejected = expect(work).rejects.toMatchObject({reason: "fenced"});
    await vi.waitFor(() => expect(f.host.startCollectionLog).toHaveBeenCalledOnce());
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    try {
      rejectFirst(error); await vi.advanceTimersByTimeAsync(100);
      if (variant === "host") f.context.host = {} as typeof f.context.host;
      if (variant === "scope") f.context.scope = {...scope, collection: scope.account};
      if (variant === "installation") f.context.installation = {...f.context.installation};
      await vi.advanceTimersByTimeAsync(1_000); await rejected;
      expect(f.host.startCollectionLog).toHaveBeenCalledOnce();
      expect(f.host.openCollectionSql).toHaveBeenCalledOnce();
      expect(f.trace).not.toContain("handoff");
      expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
  it("configured people crosses original CONTROL only, reusing SAME UI client and no host/authority loan", async () => {
    const f = fixture("explicit", true), result = await f.open();
    expect(f.handoff().people).toBe(true); expect(f.host.peopleAuthority).toHaveBeenCalledOnce();
    expect("peopleAuthority" in f.handoff()).toBe(false); expect("private_token" in f.handoff()).toBe(false);
    const stop = vi.fn(), original = {close: stop} as unknown as MdbaseClient;
    const handoff = {...f.handoff()}; // Worker structured-clone DTO isn't frozen on delivery.
    const connect = vi.spyOn(MdbaseClient, "connect").mockImplementation(async () => {Reflect.set(handoff, "people", false); return original;});
    const ui = await openAppWebCollectionClient(handoff, {app: {name: "sample", version: "1"}, signal: f.ui.signal});
    expect(ui.client).toBe(original); expect(connect).toHaveBeenCalledOnce();
    const people = ui.people!;
    expect(await people.current({signal: f.ui.signal})).toEqual({issuer: "https://issuer.example", subject: "original-subject", name: "Original person", personSettingsUrl: "https://cp.example/settings"});
    expect(await people.members({signal: f.ui.signal})).toEqual([]);
    await result.close(); await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await expect(people.current()).rejects.toMatchObject({reason: "people_fenced"});
  });
  it("absent people configuration exposes no unsupported directory stub or inferred authority", async () => {
    const f = fixture(); await f.open(); expect(f.handoff().people).toBeUndefined(); expect(f.host.peopleAuthority).not.toHaveBeenCalled();
    vi.spyOn(MdbaseClient, "connect").mockResolvedValue({close: vi.fn()} as unknown as MdbaseClient);
    const ui = await openAppWebCollectionClient(f.handoff(), {app: {name: "sample", version: "1"}, signal: f.ui.signal});
    expect(ui.people).toBeUndefined(); ui.close();
  });
  it("joins CP-existing collection, adopts SQL, verifies native READ before ONE data-port handoff, never assumes setup READY", async () => {
    const f = fixture("approved-new-collection"), result = await f.open();
    expect(f.trace).toEqual(["join", "sql", "log", "read", "facade", "handoff"]);
    expect(f.host.bootstrapCloudCopy.mock.calls[0]![0]).toMatchObject({purpose: "join", outcomeMode: "fresh", scope});
    expect(f.handoff().setupMode).toBe("approved-new"); expect(result.state).toBe("setup_required");
    expect("host" in f.handoff()).toBe(false); expect("sql" in f.handoff()).toBe(false); expect("key" in f.handoff()).toBe(false);
    const control = appCollectionControlClient(f.handoff().controlPort, f.handoff(), {signal: f.ui.signal, isCurrent: () => !f.ui.signal.aborted, onClose() {}});
    const listener = vi.fn(), stop = result.subscribe!(listener);
    await control.assess("ready", f.ui.signal); expect(result.state).toBe("ready"); expect(listener).toHaveBeenCalledOnce();
    stop(); control.close();
  });
  it("combines people on original CONTROL with scoped timer handoff, ONE UI client and timer drain before host stop",async()=>{
    const f=fixture("explicit",true),channel=new MessageChannel(),timerParent=new AbortController();let owner:ReturnType<typeof attachAppTimerReceiver>|undefined;
    const request=vi.fn(async()=>Response.json({namespace:"reminders",timers:[]}));
    f.host.openTimersPort.mockImplementation(options=>{
      expect(options.scope).toEqual(scope);expect(options.signal).not.toBe(f.parent.signal);
      owner=attachAppTimerReceiver(channel.port1,{...options,grantId:"44444444-4444-4444-8444-444444444444",cpOrigin:"https://cp.example.test",isCurrent:()=>!timerParent.signal.aborted,bearer:async()=>`idev_${"a".repeat(43)}`,fetch:request});
      return {port:channel.port2,close:async()=>{await owner!.close();f.trace.push("timer-drained");}};
    });
    const result=await f.open();expect(f.handoff().timerPort).toBe(channel.port2);expect(f.handoff().people).toBe(true);
    const original={close:vi.fn()},connect=vi.spyOn(MdbaseClient,"connect").mockResolvedValue(original as unknown as MdbaseClient);
    const ui=await openAppWebCollectionClient(f.handoff(),{app:{name:"One",version:"1"},signal:f.ui.signal});
    expect(connect).toHaveBeenCalledOnce();expect(ui.client).toBe(original);
    expect(await ui.people!.current({signal:f.ui.signal})).toMatchObject({subject:"original-subject",name:"Original person"});
    expect(await ui.timers!.list("reminders")).toEqual({namespace:"reminders",timers:[]});
    await result.close();await f.host.close();expect(f.trace.indexOf("timer-drained")).toBeLessThan(f.trace.indexOf("host-close"));
    await expect(ui.timers!.list("reminders")).rejects.toMatchObject({code:"cancelled"});ui.close();
  });
  it.each(["prepared", "attempted", "confirmed", "verified"] as const)("restore original %s uses same sealed MID and never prepares/submits anything", async phase => {
    const journal = new AppCollectionSetupJournal({...options, scope, isCurrent: () => true}), signal = new AbortController().signal;
    let original = await journal.prepare(plan, signal);
    if (phase !== "prepared") original = await journal.recordAttempt(original.mutationId, signal);
    if (phase === "confirmed" || phase === "verified") original = await journal.recordConfirmed(original.mutationId, signal);
    if (phase === "verified") original = await journal.recordVerified(original.mutationId, signal);
    const uuid = vi.spyOn(crypto, "randomUUID");
    const f = fixture(), result = await f.open();
    expect(f.handoff().setupMode).toBe(phase === "attempted" || phase === "confirmed" ? "reconcile-original" : "inspect");
    expect(result.state).toBe("setup_required"); expect(await journal.load(signal)).toEqual(original);
    expect(uuid).toHaveBeenCalledOnce(); // ONLY public channel generation, not a new MID/source UUID
    journal.close();
  });
  it("absent restore needs inspection, not automatic new setup from discovery/old receipt", async () => {
    const f = fixture(); await f.open(); expect(f.handoff().setupMode).toBe("inspect");
    const journal = new AppCollectionSetupJournal({...options, scope, isCurrent: () => true});
    expect(await journal.load(new AbortController().signal)).toBeNull(); journal.close();
  });
  it("original attempted join selects EXISTING protected reconciliation, never fresh rePOST", async () => {
    const ledger = new AppCollectionJoinLedger({databaseName: "tasknotes.native-collection-join.v1", scope, isCurrent: () => true});
    await ledger.prepare({signal: new AbortController().signal});
    const f = fixture(); await f.open();
    expect(f.host.bootstrapCloudCopy.mock.calls[0]![0]).toMatchObject({purpose: "join", outcomeMode: "existing", reconcile: "explicit-unknown-outcome"});
  });
  it("failed native READ never delivers ports, client, journal proxy or READY", async () => {
    const f = fixture(); f.host.waitForVerifiedRead.mockRejectedValue(Error("unreadable"));
    await expect(f.open()).rejects.toThrow("unreadable"); expect(f.handoff()).toBeUndefined(); expect(f.host.attachDataFacade).not.toHaveBeenCalled();
    expect(f.host.close).not.toHaveBeenCalled(); // session, not adapter, owns host shutdown
  });
  it.each(["host", "installation", "signal", "policy", "scope"])("fences changed %s after bootstrap without opening SQL on a replacement", async variant => {
    const f = fixture();
    f.host.bootstrapCloudCopy.mockImplementation(async () => {
      if (variant === "host") f.context.host = {} as typeof f.context.host;
      if (variant === "installation") f.context.installation = {...f.context.installation};
      if (variant === "signal") f.context.signal = new AbortController().signal;
      if (variant === "policy") f.context.setupPolicy = "approved-new-collection";
      if (variant === "scope") f.context.scope = {...scope, collection: scope.account};
    });
    await expect(f.open()).rejects.toMatchObject({reason: "fenced"});
    expect(f.host.openCollectionSql).not.toHaveBeenCalled(); expect(f.handoff()).toBeUndefined();
  });
  it("failed adapter stop remains quarantined, memoized and cannot acquire another scope", async () => {
    const f = fixture(); const result = await f.open(); cleanup.pop();
    const port = f.handoff().dataPort, originalClose = port.close.bind(port);
    const stop = vi.spyOn(port, "close").mockImplementation(() => {throw Error("failed port stop");});
    const failed = result.close(); await expect(failed).rejects.toMatchObject({reason: "unavailable"});
    expect(result.close()).toBe(failed); expect(result.connection.isCurrent()).toBe(false); expect(result.state).toBe("setup_required");
    await expect(f.adapter(f.context)).rejects.toMatchObject({reason: "fenced"}); expect(stop).toHaveBeenCalledOnce();
    stop.mockRestore(); originalClose(); f.parent.abort(); f.ui.abort();
  });
  it("holds handoff behind the cold progress gate; a previously synced offline open reads its own replica", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      const f = fixture();
      let synced!: () => void;
      f.host.waitForVerifiedRead.mockImplementationOnce(() => new Promise(resolve => {synced = resolve;}));
      const opening = f.open();
      await vi.waitFor(() => expect(f.host.waitForVerifiedRead).toHaveBeenCalledWith({signal: expect.any(AbortSignal), cold: true, onProgress: expect.any(Function)}));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.trace).not.toContain("handoff"); // genuine host gate owns cold progress and READ
      expect(f.host.driveCollection).not.toHaveBeenCalled(); // no second competing cold pump
      synced();
      await opening; expect(f.trace.at(-1)).toBe("handoff");
      await vi.waitFor(async () => expect(await new AppCollectionJoinLedger({databaseName: "tasknotes.native-collection-join.v1", scope, isCurrent: () => true})
        .syncedBefore({signal: new AbortController().signal})).toBe(true));
      const g = fixture(); g.host.initialSync.mockReturnValue("offline");
      await g.open(); expect(g.trace.at(-1)).toBe("handoff");
      expect(g.host.waitForVerifiedRead).toHaveBeenCalledWith({signal: expect.any(AbortSignal), local: true, timeoutMs: 5_000, onProgress: expect.any(Function)});
    } finally { vi.useRealTimers(); }
  });
  it("never polls the log head on a timer; a foreground event wakes it once; a failed turn does not stop the loop", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      const f = fixture(); const result = await f.open();
      f.host.driveCollection.mockRejectedValueOnce(new Error("offline"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.host.wakeCollectionLog).not.toHaveBeenCalled();
      expect(f.host.driveCollection.mock.calls.length).toBeGreaterThan(1); // the rejected turn did not stop the loop
      result.connection.setForeground(false); result.connection.setForeground(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(f.host.wakeCollectionLog).toHaveBeenCalledOnce(); // shown again: catch up once, without push
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.host.wakeCollectionLog).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("hidden: drives only while writes are pending, for at most two minutes; offline waits for an event", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      const f = fixture(); const result = await f.open();
      await vi.advanceTimersByTimeAsync(1_000);
      f.host.pendingWrites.mockReturnValue(1);
      result.connection.setForeground(false);
      f.host.driveCollection.mockClear(); f.host.wakeCollectionLog.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.host.driveCollection.mock.calls.length).toBeGreaterThan(5); // flushing
      expect(f.host.wakeCollectionLog).not.toHaveBeenCalled(); // never a head wake while hidden
      f.host.pendingWrites.mockReturnValue(0);
      await vi.advanceTimersByTimeAsync(1_000); f.host.driveCollection.mockClear();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.host.driveCollection).not.toHaveBeenCalled(); // nothing pending: idle
      result.connection.setForeground(true); result.connection.setForeground(false);
      f.host.pendingWrites.mockReturnValue(3);
      result.connection.setForeground(true); result.connection.setForeground(false);
      await vi.advanceTimersByTimeAsync(121_000); f.host.driveCollection.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.host.driveCollection).not.toHaveBeenCalled(); // the flush ends after two minutes
      // Offline: no retry timer at all until the page reports online/focus/visible.
      f.host.transportHealth.mockReturnValue({kind: "offline"});
      result.connection.setForeground(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(result.health).toEqual({kind: "offline"});
      f.host.driveCollection.mockClear(); f.host.wakeCollectionLog.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.host.driveCollection.mock.calls.length + f.host.wakeCollectionLog.mock.calls.length).toBe(0);
      f.host.transportHealth.mockReturnValue(null);
      result.connection.setForeground(true); // e.g. the online event
      await vi.advanceTimersByTimeAsync(300);
      expect(f.host.wakeCollectionLog).toHaveBeenCalledOnce();
      expect(result.health).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("publishes offline recovery after the next accepted turn, not merely a foreground/online event", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    let finish: (() => void) | undefined;
    try {
      const f = fixture(), result = await f.open();
      const published: (AppLogHealth | null)[] = [];
      result.subscribe!(() => published.push(result.health ?? null));
      f.host.transportHealth.mockReturnValue({kind: "offline"});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(published.at(-1)).toEqual({kind: "offline"});
      published.length = 0;
      f.host.wakeCollectionLog.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
      result.connection.setForeground(true); // visible online event, SAME original collection
      await vi.advanceTimersByTimeAsync(300);
      expect(f.host.wakeCollectionLog).toHaveBeenCalledOnce();
      expect(result.health).toEqual({kind: "offline"}); // online alone is not accepted I/O
      expect(published).toEqual([]);
      f.host.transportHealth.mockReturnValue(null); // original pump accepted its reply
      finish!();
      await vi.advanceTimersByTimeAsync(0);
      expect(result.health).toBeNull();
      expect(published).toEqual([null]); // consumers must hear the recovery
    } finally { finish?.(); vi.useRealTimers(); }
  });
  it("notifies subscribed views when an offline pump accepts a reply after an online wake", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      const f = fixture(), result = await f.open();
      const published: (AppLogHealth | null)[] = [];
      result.subscribe!(() => published.push(result.health ?? null));
      f.host.transportHealth.mockReturnValue({kind: "offline"});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(published.at(-1)).toEqual({kind: "offline"});
      published.length = 0;
      f.host.wakeCollectionLog.mockImplementationOnce(async () => {
        f.host.transportHealth.mockReturnValue(null); // original transport accepted its reply
      });
      result.connection.setForeground(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(f.host.wakeCollectionLog).toHaveBeenCalledOnce();
      expect(result.health).toBeNull();
      expect(published).toEqual([null]); // a recovered getter alone leaves UI stale
    } finally { vi.useRealTimers(); }
  });
  it("probes offline recovery even when the push socket still claims to be live", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      const f = fixture();
      Object.assign(f.host, {openLogPush: () => ({available: true, live: true, suspended: false, start() {}, close() {}, resume() {}, suspend() {}})});
      const result = await f.open();
      f.host.transportHealth.mockReturnValue({kind: "offline"});
      await vi.advanceTimersByTimeAsync(1_000);
      const listener = vi.fn(); result.subscribe!(listener);
      f.host.wakeCollectionLog.mockImplementationOnce(async () => {f.host.transportHealth.mockReturnValue(null);});
      result.connection.setForeground(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(f.host.wakeCollectionLog).toHaveBeenCalledOnce();
      expect(result.health).toBeNull();
      expect(listener).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("keeps known offline state after an online wake fails and waits for another event", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      const f = fixture(), result = await f.open();
      f.host.transportHealth.mockReturnValue({kind: "offline"});
      await vi.advanceTimersByTimeAsync(1_000);
      const listener = vi.fn(); result.subscribe!(listener);
      f.host.wakeCollectionLog.mockRejectedValueOnce(new Error("connection still unavailable"));
      result.connection.setForeground(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(result.health).toEqual({kind: "offline"});
      expect(listener).not.toHaveBeenCalled();
      f.host.wakeCollectionLog.mockClear(); f.host.driveCollection.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.host.wakeCollectionLog).not.toHaveBeenCalled();
      expect(f.host.driveCollection).not.toHaveBeenCalled();
      f.host.wakeCollectionLog.mockImplementationOnce(async () => {f.host.transportHealth.mockReturnValue(null);});
      result.connection.setForeground(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(result.health).toBeNull();
      expect(listener).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("the opening tab leaving releases its own facade, control and timers while another tab keeps the collection", async () => {
    const f = fixture(), timerCloses: string[] = [];
    f.host.openTimersPort.mockImplementation(() => {const channel = new MessageChannel(), name = `timers-${timerCloses.length}`;
      return {port: channel.port2, close: async () => {timerCloses.push(name); channel.port1.close();}} as unknown as ReturnType<AppWebCloudCopyHost["openTimersPort"]>;});
    const result = await f.open(), opener = f.handoff(), other = result.connection.attach!()!;
    expect(f.host.attachDataFacade).toHaveBeenCalledTimes(2);
    const [openerFacade, otherFacade] = f.host.attachDataFacade.mock.calls.map(call => (call as unknown as [MessagePort])[0]);
    result.connection.detach!(opener);
    await vi.waitFor(() => expect(timerCloses).toHaveLength(1));
    expect(f.host.detachDataFacade.mock.calls.map(call => call[0])).toEqual([openerFacade]);
    // The other tab still has its own ports onto the open collection.
    expect(result.connection.isCurrent()).toBe(true);
    const control = appCollectionControlClient(other.controlPort, other, {signal: f.ui.signal, isCurrent: () => !f.ui.signal.aborted, onClose() {}});
    await control.assess("ready", f.ui.signal); expect(result.state).toBe("ready");
    // Detaching the same ports again is a no-op; the other tab's go when it leaves.
    result.connection.detach!(opener);
    expect(f.host.detachDataFacade).toHaveBeenCalledTimes(1);
    result.connection.detach!(other);
    await vi.waitFor(() => expect(timerCloses).toHaveLength(2));
    expect(f.host.detachDataFacade.mock.calls.map(call => call[0])).toEqual([openerFacade, otherFacade]);
    control.close(); await result.close();
  });
  it("adapter close drains own log drive; native/SQL/lease close stays with original session HOST", async () => {
    const f = fixture(); const result = await f.open();
    const close = result.close(); expect(result.close()).toBe(close); await close;
    expect(result.connection.isCurrent()).toBe(false); expect(result.state).toBe("setup_required"); expect(f.host.close).not.toHaveBeenCalled();
  });
  it("preserves ONE UI MdbaseClient for setup+repository, no Worker client consumes its port", async () => {
    const f = fixture(); const result = await f.open();
    const stop = vi.fn(); const connect = vi.spyOn(MdbaseClient, "connect").mockResolvedValue({close: stop} as unknown as MdbaseClient);
    const ui = await openAppWebCollectionClient(f.handoff(), {app: {name: "sample-app", version: "1"}, signal: f.ui.signal});
    expect(connect).toHaveBeenCalledOnce(); expect(ui.scope).toEqual(scope); expect(ui.setupMode).toBe("inspect");
    await ui.assess("ready", f.ui.signal); expect(result.state).toBe("ready");
    await expect(openAppWebCollectionClient(f.handoff(), {app: {name: "sample-app", version: "1"}, signal: f.ui.signal})).rejects.toMatchObject({reason: "binding"});
    await result.close(); await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });
});
