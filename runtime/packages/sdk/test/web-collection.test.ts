import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppWebCollectionAdapter, openAppWebCollectionClient, type AppWebCollectionHandoff } from "../src/app-host/web-collection.js";
import { AppCollectionSetupJournal } from "../src/app-host/collection-setup-journal.js";
import { appCollectionControlClient } from "../src/app-host/collection-control.js";
import { AppCollectionJoinLedger } from "../src/app-host/collection-join-ledger.js";
import type { AppWebSignInSessionOptions } from "../src/app-host/web-sign-in-session.js";
import type { AppWebNativeCollection } from "../src/app-host/web-collection.js";
import { MdbaseClient } from "../src/client.js";
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
describe("real protected native collection composition", () => {
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
  it("holds the handoff until the replica first catches up; once caught up, a later offline open uses local data", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true});
    try {
      const f = fixture(); f.host.initialSync.mockReturnValue("waiting_for_key");
      const opening = f.open();
      await vi.waitFor(() => expect(f.host.driveCollection).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.trace).not.toContain("handoff"); // no setup assessment or empty state on a stalled replica
      expect(f.host.driveCollection.mock.calls.length).toBeGreaterThan(1); // the wait drives the log
      f.host.initialSync.mockReturnValue(null);
      await opening; expect(f.trace.at(-1)).toBe("handoff");
      await vi.waitFor(async () => expect(await new AppCollectionJoinLedger({databaseName: "tasknotes.native-collection-join.v1", scope, isCurrent: () => true})
        .syncedBefore({signal: new AbortController().signal})).toBe(true));
      const g = fixture(); g.host.initialSync.mockReturnValue("offline");
      await g.open(); expect(g.trace.at(-1)).toBe("handoff");
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
