import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireAppReplicaLease, acquireAppInstallationLease, appReplicaLockName, appInstallationLockName, openOwnedAppWorker, type AppLockPort, type AppInstallationCustodyAuthority } from "../src/app-host/index.js";
const scope = { account: "00000000-0000-4000-8000-000000000001", installation: "00000000-0000-4000-8000-000000000002", collection: "00000000-0000-4000-8000-000000000003" };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function lockPort() {
  const held = new Set<string>();
  const request = vi.fn<AppLockPort["request"]>(async (name, _options, callback) => {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { await callback({}); } finally { held.delete(name); }
  });
  return { held, port: { request } };
}
function worker() { return { stop: vi.fn(async () => {}), terminate: vi.fn() }; }
afterEach(() => vi.useRealTimers());

describe("app ownership lease", () => {
  it("canonical namespace includes all three validated IDs", () => {
    expect(appReplicaLockName(scope)).toBe(`mdbase-app-${scope.account}-${scope.installation}-${scope.collection}`);
    expect(appReplicaLockName({ ...scope, account: scope.account.toUpperCase() })).toBe(appReplicaLockName(scope));
    for (const key of ["account", "installation", "collection"] as const) {
      expect(() => appReplicaLockName({ ...scope, [key]: "../other" })).toThrow("invalid_scope");
    }
  });
  it("busy is immediate, and release is idempotent and awaits actual unlock", async () => {
    const { port, held } = lockPort();
    const first = await acquireAppReplicaLease(port, scope);
    expect(held.size).toBe(1);
    await expect(acquireAppReplicaLease(port, scope)).rejects.toMatchObject({ reason: "busy" });
    const release = first.release();
    expect(first.release()).toBe(release);
    await release;
    expect(held.size).toBe(0);
    await (await acquireAppReplicaLease(port, scope)).release();
    expect(port.request).toHaveBeenCalledWith(appReplicaLockName(scope), { mode: "exclusive", ifAvailable: true }, expect.any(Function));
  });
  it("different accounts/installations don't share a collection lock", async () => {
    const { port, held } = lockPort();
    const first = await acquireAppReplicaLease(port, scope);
    const other = await acquireAppReplicaLease(port, { ...scope, account: scope.installation });
    expect(held.size).toBe(2);
    await first.release(); await other.release();
  });
  it("missing Web Locks and pre-abort never fall back to unlocked storage", async () => {
    await expect(acquireAppReplicaLease(undefined, scope)).rejects.toMatchObject({ reason: "unavailable" });
    const abort = new AbortController(); abort.abort("private reason");
    const { port } = lockPort();
    await expect(acquireAppReplicaLease(port, scope, abort.signal)).rejects.toMatchObject({ reason: "aborted" });
    expect(port.request).not.toHaveBeenCalled();
  });
  it("abort before a delayed callback cannot accidentally acquire ownership", async () => {
    const delayed = deferred();
    const { port, held } = lockPort();
    const original = port.request;
    const late: AppLockPort = { request: async (...args) => { await delayed.promise; return original(...args); } };
    const abort = new AbortController();
    const result = acquireAppReplicaLease(late, scope, abort.signal);
    abort.abort();
    await expect(result).rejects.toMatchObject({ reason: "aborted" });
    delayed.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.size).toBe(0);
  });
  it("acquisition signal does not release an already acquired live owner", async () => {
    const abort = new AbortController();
    const { port } = lockPort();
    const lease = await acquireAppReplicaLease(port, scope, abort.signal);
    abort.abort();
    await expect(acquireAppReplicaLease(port, scope)).rejects.toMatchObject({ reason: "busy" });
    await lease.release();
  });
  it("request errors omit private browser messages", async () => {
    await expect(acquireAppReplicaLease({ request: async () => { throw new Error("private origin"); } }, scope)).rejects.toMatchObject({ reason: "unavailable", message: "app replica owner: unavailable" });
  });
});

describe("owned Worker lifecycle", () => {
  it("custody callback binds actual original installation ownership and retires before unlock", async () => {
    const {port,held}=lockPort(),w=worker();let authority:AppInstallationCustodyAuthority|null=null;
    const owner=await openOwnedAppWorker({locks:port,scope,create:()=>w,initialize:async(_w,_signal,s,a)=>{authority=a;expect(a.scope).toEqual({account:scope.account,installation:scope.installation});expect(a.isCurrent()).toBe(true);expect(held.has(appInstallationLockName(s))).toBe(true);expect(held.size).toBe(2);}});
    expect(authority!.isCurrent()).toBe(true);w.terminate.mockImplementation(()=>{expect(authority!.isCurrent()).toBe(false);expect(held.size).toBe(2);throw Error("private stop failure");});
    await expect(owner.close()).rejects.toMatchObject({reason:"shutdown_failed"});expect(authority!.isCurrent()).toBe(false);expect(held.size).toBe(2);
  });
  it("captures original lifetime signal before installation await, never adopts a replacement",async()=>{
    const {port,held}=lockPort(),delay=deferred(),old=new AbortController(),replacement=new AbortController(),w=worker();
    const locks:AppLockPort={request:async(...args)=>{await delay.promise;return port.request(...args);}};
    const initialize=vi.fn(async(_w:ReturnType<typeof worker>,signal:AbortSignal|undefined)=>{expect(signal).toBe(old.signal);});
    const options={locks,scope,create:()=>w,initialize,signal:old.signal};const pending=openOwnedAppWorker(options);options.signal=replacement.signal;delay.resolve();const owner=await pending;
    replacement.abort();expect(held.size).toBe(2);old.abort();await owner.close();expect(held.size).toBe(0);expect(w.terminate).toHaveBeenCalledTimes(1);
  });
  it("installation ownership is separate and excludes another collection before unwrap", async () => {
    const { port, held } = lockPort();
    expect(appInstallationLockName(scope)).not.toBe(appReplicaLockName(scope));
    const first = await openOwnedAppWorker({ locks: port, scope, create: worker, initialize: async () => {} });
    const create = vi.fn(worker);
    await expect(openOwnedAppWorker({ locks: port, scope: { ...scope, collection: scope.account }, create, initialize: async () => {} })).rejects.toMatchObject({ reason: "busy" });
    expect(create).not.toHaveBeenCalled();
    expect(held.size).toBe(2);
    await first.close();
    const second = await openOwnedAppWorker({ locks: port, scope: { ...scope, collection: scope.account }, create, initialize: async () => {} });
    await second.close();
    expect(held.size).toBe(0);
  });
  it("failed collection acquisition releases its temporary installation lease", async () => {
    const { port } = lockPort(), collection = await acquireAppReplicaLease(port, scope);
    await expect(openOwnedAppWorker({ locks: port, scope, create: worker, initialize: async () => {} })).rejects.toMatchObject({ reason: "busy" });
    const installation = await acquireAppInstallationLease(port, scope);
    await installation.release(); await collection.release();
  });
  it("pins immutable scope before async acquisition for factory and initializer", async () => {
    const delayed = deferred(), { port } = lockPort(), current = { ...scope };
    const late: AppLockPort = { request: async (...args) => { await delayed.promise; return port.request(...args); } };
    const create = vi.fn(worker), initialize = vi.fn(async () => {});
    const opening = openOwnedAppWorker({ locks: late, scope: current, create, initialize });
    current.collection = scope.account;
    delayed.resolve();
    const owned = await opening;
    expect(owned.scope.collection).toBe(scope.collection);
    expect(create).toHaveBeenCalledWith(owned.scope);
    expect(initialize).toHaveBeenCalledWith(owned.worker, undefined, owned.scope, {scope:{account:scope.account,installation:scope.installation},isCurrent:expect.any(Function)});
    await owned.close();
  });
  it("creates and initializes only while holding the lease", async () => {
    const { port, held } = lockPort(); const w = worker();
    const initialize = vi.fn(async () => { expect(held.size).toBe(2); });
    const owned = await openOwnedAppWorker({ locks: port, scope, create: () => { expect(held.size).toBe(2); return w; }, initialize });
    expect(owned.worker).toBe(w);
    expect(owned.scope).toEqual(scope);
    expect(Object.isFrozen(owned.scope)).toBe(true);
    expect(initialize).toHaveBeenCalledWith(w, undefined, owned.scope, {scope:{account:scope.account,installation:scope.installation},isCurrent:expect.any(Function)});
    await owned.close();
    expect(w.stop).toHaveBeenCalledOnce(); expect(w.terminate).toHaveBeenCalledOnce(); expect(held.size).toBe(0);
  });
  it("never creates a second Worker when Busy", async () => {
    const { port } = lockPort(); const first = await acquireAppReplicaLease(port, scope);
    const create = vi.fn(worker);
    await expect(openOwnedAppWorker({ locks: port, scope, create, initialize: async () => {} })).rejects.toMatchObject({ reason: "busy" });
    expect(create).not.toHaveBeenCalled(); await first.release();
  });
  it("factory failure releases ownership without leaking exception text", async () => {
    const { port, held } = lockPort();
    await expect(openOwnedAppWorker({ locks: port, scope, create: () => { throw new Error("private path"); }, initialize: async () => {} })).rejects.toMatchObject({ reason: "initialization_failed", message: "app replica owner: initialization_failed" });
    expect(held.size).toBe(0);
  });
  it("initialization failure drains and terminates before unlocking", async () => {
    const { port, held } = lockPort(); const w = worker();
    w.terminate.mockImplementation(() => { expect(held.size).toBe(2); });
    await expect(openOwnedAppWorker({ locks: port, scope, create: () => w, initialize: async () => { throw new Error("private keys must not leak"); } })).rejects.toMatchObject({ reason: "initialization_failed" });
    expect(w.stop).toHaveBeenCalledOnce(); expect(w.terminate).toHaveBeenCalledOnce(); expect(held.size).toBe(0);
  });
  it("graceful stop failure still fail-stops before unlock", async () => {
    const { port, held } = lockPort(); const w = worker();
    w.stop.mockRejectedValue(new Error("uncertain commit"));
    w.terminate.mockImplementation(() => { expect(held.size).toBe(2); });
    const owned = await openOwnedAppWorker({ locks: port, scope, create: () => w, initialize: async () => {} });
    await owned.close(); expect(held.size).toBe(0);
  });
  it("keeps the lease until graceful stop finishes and close is idempotent", async () => {
    const { port, held } = lockPort(); const w = worker(); const stopped = deferred();
    w.stop.mockReturnValue(stopped.promise);
    const owned = await openOwnedAppWorker({ locks: port, scope, create: () => w, initialize: async () => {} });
    const closing = owned.close(); expect(owned.close()).toBe(closing);
    await expect(acquireAppReplicaLease(port, scope)).rejects.toMatchObject({ reason: "busy" });
    expect(w.terminate).not.toHaveBeenCalled(); stopped.resolve(); await closing;
    expect(w.terminate).toHaveBeenCalledOnce(); expect(held.size).toBe(0);
  });
  it("bounded shutdown terminates a hung Worker before unlock", async () => {
    vi.useFakeTimers(); const { port, held } = lockPort(); const w = worker();
    w.stop.mockReturnValue(new Promise(() => {}));
    const owned = await openOwnedAppWorker({ locks: port, scope, create: () => w, initialize: async () => {}, closeTimeoutMs: 25 });
    const closing = owned.close();
    await vi.advanceTimersByTimeAsync(24); expect(held.size).toBe(2); expect(w.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await closing;
    expect(w.terminate).toHaveBeenCalledOnce(); expect(held.size).toBe(0);
  });
  it("termination failure fences ownership rather than enabling a second writer", async () => {
    const { port, held } = lockPort(); const w = worker();
    w.terminate.mockImplementation(() => { throw new Error("can't terminate"); });
    const owned = await openOwnedAppWorker({ locks: port, scope, create: () => w, initialize: async () => {} });
    await expect(owned.close()).rejects.toMatchObject({ reason: "shutdown_failed" });
    expect(held.size).toBe(2);
    await expect(acquireAppReplicaLease(port, scope)).rejects.toMatchObject({ reason: "busy" });
    await expect(acquireAppInstallationLease(port, scope)).rejects.toMatchObject({ reason: "busy" });
  });
  it("abort during a hung opening stops/terminates rather than returning a host", async () => {
    const abort = new AbortController(); const { port, held } = lockPort(); const w = worker(); const entered = deferred();
    const opening = openOwnedAppWorker({ locks: port, scope, signal: abort.signal, create: () => w, initialize: async (_w, signal) => { expect(signal).toBe(abort.signal); entered.resolve(); await new Promise(() => {}); } });
    await entered.promise; abort.abort("private reason");
    await expect(opening).rejects.toMatchObject({ reason: "aborted" });
    expect(w.terminate).toHaveBeenCalledOnce(); expect(held.size).toBe(0);
  });
  it("lifetime abort drains before releasing a ready host", async () => {
    const abort = new AbortController(); const { port, held } = lockPort(); const w = worker(); const stopped = deferred();
    w.stop.mockReturnValue(stopped.promise);
    const owned = await openOwnedAppWorker({ locks: port, scope, signal: abort.signal, create: () => w, initialize: async () => {} });
    abort.abort();
    await expect(acquireAppReplicaLease(port, scope)).rejects.toMatchObject({ reason: "busy" });
    stopped.resolve(); await owned.close(); expect(held.size).toBe(0);
  });
  it.each([0, -1, NaN, Infinity, 1.5, 30001])("rejects shutdown bound %s before opening", async (closeTimeoutMs) => {
    const { port } = lockPort();
    await expect(openOwnedAppWorker({ locks: port, scope, create: worker, initialize: async () => {}, closeTimeoutMs })).rejects.toThrow(RangeError);
    expect(port.request).not.toHaveBeenCalled();
  });
});
