import { afterEach, describe, expect, it, vi } from "vitest";
import {ApplicationWorkerHost} from "../src/application/worker-host.js";
import * as WorkerSession from "../src/application/worker-session.js";
import {APPLICATION_WORKER_PROTOCOL} from "../src/application/worker-protocol.js";
import { appServerProblem } from "../src/app-host/cp-problem.js";
import { AppWebSignInSession, type AppWebSignInPortal } from "../src/app-host/web-sign-in-session.js";
import { AppProtectedInstallationSignIn, AppInstallationSignInError, type AppInstallationSignInView } from "../src/app-host/installation-sign-in.js";
import { AppCollectionSetupError } from "../src/app-host/collection-setup-journal.js";
import { AppCloudCopyHostError } from "../src/app-host/cloud-copy-host.js";
import { MdbaseError } from "../src/errors.js";
import { AppWebCloudCopyHost } from "../src/app-host/cloud-copy-host.js";
import * as ownership from "../src/app-host/owner.js";
import * as erasure from "../src/app-host/sign-out-erase.js";
import { AppCloudCopyBootstrapError, type AppBundledReleaseTrust } from "../src/app-host/cloud-copy-bootstrap.js";
const account = "11111111-1111-4111-8111-111111111111", installation = "22222222-2222-4222-8222-222222222222";
const collectionId = "33333333-3333-4333-8333-333333333333";
const release: AppBundledReleaseTrust = {schema: "mdbn-app-trust/release/1", environment: "production", cpOrigin: "https://cp.example.test", logOrigin: "https://log.example.test", assetSha256: "11".repeat(32), source: {repository: "mdbase-dev/mdbase-connect", commit: "22".repeat(20), version: "test"}, trustedRoots: [new Uint8Array(32).fill(3)], policyPins: Uint8Array.of(1)};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(initial: AppInstallationSignInView["state"] = "pending", autoSelect: "only" | "never" = "only", noEmail = false) {
  const trace: string[] = [], parent = new AbortController();
  let state = initial, selectedOnPortal = false, approved = false, newlyCreated = false, consentActive = false, consentDone = false, consentConfirmed = false, flowSignal: AbortSignal | undefined;
  const consentId = "66666666-6666-4666-8666-666666666666";
  const consentView = () => ({requestId: consentId, verificationUri: `${release.cpOrigin}/pair/${consentId}`, state: consentDone ? "scope_updated" as const : "pending" as const, requestedCreateCollections: false, addedCollectionIds: consentDone ? [collectionId] : [], approvedCreateCollections: false, accountSelectionConfirmed: consentConfirmed});
  const view = (): AppInstallationSignInView => ({requestId: "44444444-4444-4444-8444-444444444444", installationId: installation, deviceId: "55555555-5555-4555-8555-555555555555", appId: "independent-app", kind: "app-runtime", verificationUri: `${release.cpOrigin}/pair/44444444-4444-4444-8444-444444444444`, state, accountId: state === "pending" ? null : account, accountEmail: state === "pending" || noEmail ? null : "person@example.test", ...(noEmail && state !== "pending" ? {accountProvider:"github" as const,accountLogin:"fixture-login"} : {}), collectionSelection: state === "paired" ? {requestId: consentDone ? consentId : "44444444-4444-4444-8444-444444444444", selectedCollectionId: collectionId, createdCollectionIds: newlyCreated ? [collectionId] : []} : null, collectionIds: state === "paired" ? [collectionId] : [], createCollections: false, requestedCreateCollections: false});
  const flow = {
    view, isCurrent: () => !flowSignal?.aborted, collectionConsentView: vi.fn(() => consentActive ? consentView() : null),
    startCollectionConsent: vi.fn(async () => {trace.push("consent-start"); consentActive = true; return consentView();}),
    exchangeCollectionConsent: vi.fn(async () => {trace.push("consent-exchange"); return consentView();}), start: vi.fn(async () => { trace.push("start"); return view(); }),
    exchange: vi.fn(async () => { trace.push("exchange"); if (state === "pending" && selectedOnPortal) state = "account_selected"; if (state === "awaiting_approval" && approved) state = "paired"; return view(); }),
    confirmPortalSelectedAccount: vi.fn(async () => { trace.push("portal-confirm"); state = "account_confirmed"; return view(); }),
    confirmedSelection: vi.fn(() => { if (state === "pending" || state === "account_selected") throw new AppInstallationSignInError("account_confirmation_required"); return {accountId: account, installationId: installation}; }),
    listApprovedCollections: vi.fn(async () => [{collectionId, displayName: "My notes", role: "owner" as "owner" | "editor" | "viewer"}]),
    deleteApprovedCollection: vi.fn(async (_installation: unknown, id: string, _name: string) => ({collectionId: id, deleted: true as const})),
    renewExpiredPairing: vi.fn(async () => {state = "pending"; return view();}),
    close: vi.fn(async () => {trace.push("flow-close");}),
    signOutInstallation: vi.fn(async (): Promise<"revoked" | "already_signed_out"> => {trace.push("cp-sign-out"); return "revoked";}),
    hasWebPushChannel: vi.fn(() => false),
  };
  const flowOpen = vi.spyOn(AppProtectedInstallationSignIn, "open").mockImplementation(async p => {
    flowSignal = p.signal; expect(p.mode).toBe("open"); expect(p.appId).toBe("independent-app"); expect(p.origin).toBe("https://notes.example.test"); return flow as unknown as AppProtectedInstallationSignIn;
  });
  const host = {
    attestInstallation: vi.fn(async () => {trace.push("attest"); state = "awaiting_approval"; return view();}),
    completeInstallationSignIn: vi.fn(async () => {trace.push("ack");}),
    close: vi.fn(async () => {trace.push("host-close"); expect(flowSignal?.aborted).toBe(false);}),
  };
  const hostOpen = vi.spyOn(AppWebCloudCopyHost, "openInstallationDevice").mockImplementation(async p => {
    trace.push("host-open"); expect(p.signIn).toBe(flow); expect(p.installation.scope).toEqual({account, installation}); expect(p.installation.isCurrent()).toBe(true); expect(p.signal.aborted).toBe(false); return host as unknown as AppWebCloudCopyHost;
  });
  const installationRelease = vi.fn(async () => {trace.push("installation-release");});
  const collectionRelease = vi.fn(async () => {trace.push("collection-release");});
  vi.spyOn(ownership, "acquireAppInstallationLease").mockImplementation(async (_locks, scope) => {trace.push("installation-lease"); expect(scope).toEqual({account, installation}); return {release: installationRelease};});
  vi.spyOn(ownership, "acquireAppReplicaLease").mockImplementation(async (_locks, scope) => {trace.push("collection-lease"); expect(scope).toEqual({account, installation, collection: collectionId}); return {release: collectionRelease};});
  const connection = {name: "held collection"}, closeConnection = vi.fn(async () => {trace.push("connection-close");});
  const openCollection = vi.fn(async p => {
    trace.push("collection-open"); expect(p.host).toBe(host); expect(p.scope).toEqual({account, installation, collection: collectionId}); expect(p.collection.displayName).toBe("My notes"); expect(p.signal.aborted).toBe(false);
    return {state: "ready" as "ready" | "setup_required", connection, close: closeConnection};
  });
  const navigatePortal = vi.fn(uri => {trace.push("navigate-portal"); expect(new URL(uri).origin).toBe(release.cpOrigin); expect(new URL(uri).pathname.startsWith("/pair/")).toBe(true);}), closePortal = vi.fn();
  const openPortal = vi.fn<() => AppWebSignInPortal>(() => {trace.push("open-portal"); return {navigate: navigatePortal, close: closePortal};});
  const options = {appId: "independent-app", appName: "Independent App", origin: "https://notes.example.test", cpOrigin: release.cpOrigin, environment: "production" as const, release, signal: parent.signal, locks: undefined, loadRuntime: async () => Uint8Array.of(1), openPortal, openCollection, autoSelect};
  const session = new AppWebSignInSession(options);
  return {session, options, flow, host, flowOpen, hostOpen, parent, trace, openPortal, navigatePortal, closePortal, openCollection, connection, closeConnection, installationRelease, collectionRelease, selectOnPortal: () => {selectedOnPortal = true;}, approve: (created = false) => {approved = true; newlyCreated = created;}, approveConsent: (confirmed = true) => {consentDone = true; consentConfirmed = confirmed;}, flowSignal: () => flowSignal,
    /** The stored ledger is gone: the next open creates a fresh pending one. */
    eraseLedger: () => {state = "pending"; selectedOnPortal = false; approved = false; consentActive = false; consentDone = false;}};
}
function workerFixture(f: ReturnType<typeof fixture>) {
  Object.assign(f.connection, {isCurrent: () => true, setForeground: vi.fn()});
  // Real lifecycle session with the fixture's stand-in native/CP composition.
  vi.spyOn(WorkerSession, "applicationWorkerSession").mockReturnValue({session: f.session} as unknown as ReturnType<typeof WorkerSession.applicationWorkerSession>);
  const primary = new MessageChannel(), channel = new MessageChannel(), binding = "foreground_queue_follower";
  const frames: unknown[][] = [];
  channel.port2.onmessage = event => frames.push(event.data);
  const host = new ApplicationWorkerHost(primary.port1, "foreground_queue_primary", {} as never, {} as never, undefined);
  host.attach(channel.port1, binding);
  return {frames, send: (requestId: number, action: "foreground" | "start" | "select", payload: string | boolean | null = null) => channel.port2.postMessage([APPLICATION_WORKER_PROTOCOL, binding, requestId, action, payload]),
    close: async () => {try {await host.stop();} finally {channel.port2.close(); primary.port2.close();}}};
}
async function approvalTick(session: AppWebSignInSession<unknown>): Promise<void> {
  session.setForeground(false);session.setForeground(true);
  await vi.waitFor(()=>expect((session as unknown as {pending:unknown}).pending).toBeNull());
}
describe("opening progress", () => {
  it("explicitly clears a stale stage when the same slot is already opening", async () => {
    const f = fixture("paired"), original = f.openCollection.getMockImplementation()!;
    f.openCollection.mockImplementation(async p => {
      p.onProgress("replaying");
      const slot = Reflect.get(f.session, "slots").get(collectionId);
      const publish = Reflect.get(f.session, "publishSlot").bind(f.session);
      publish(slot, {status: "opening"});
      expect(f.session.getSnapshot().openingProgress).toBe("replaying");
      publish(slot, {status: "opening", openingProgress: null});
      expect(f.session.getSnapshot().openingProgress).toBeNull();
      return original(p);
    });
    await f.session.start(); await f.session.close();
  });
  it("publishes only while the original collection open is pending, then clears and fences late reports", async () => {
    const f = fixture("paired");
    const original = f.openCollection.getMockImplementation()!;
    let report!: (stage: "replaying" | "loading_snapshot") => void;
    let finish!: () => void;
    f.openCollection.mockImplementation(async p => {
      report = p.onProgress; report("loading_snapshot");
      await new Promise<void>(resolve => {finish = resolve;});
      return original(p);
    });
    const work = f.session.start();
    await vi.waitFor(() => expect(f.session.getSnapshot().openingProgress).toBe("loading_snapshot"));
    report("replaying"); expect(f.session.getSnapshot().openingProgress).toBe("replaying");
    finish(); await work;
    expect(f.session.getSnapshot().openingProgress).toBeNull();
    report("loading_snapshot"); expect(f.session.getSnapshot().openingProgress).toBeNull();
    await f.session.close();
  });
});

describe("unified Native choice lifecycle", () => {
  it("keeps ONE original popup through Native completion and ACK without opening a Hosted adapter", async () => {
    const f=fixture("pending","never"), requestId=f.flow.view().requestId, authorizationId="77777777-7777-4777-8777-777777777777";
    let nativeChoice: {requestId:string;authorizationRequestId:string;collectionId:string}|null=null, verified=false;
    const originalView=f.flow.view;
    f.flow.view=()=>({...originalView(),collectionSelection:null,collectionIds:[],nativeSelection:verified?nativeChoice:null});
    const originalExchange=f.flow.exchange.getMockImplementation()!;
    f.flow.exchange.mockImplementation(async()=>{await originalExchange();return f.flow.view();});
    const context={requestId,appId:"independent-app",accountId:account,challenge:"ab".repeat(32)};
    const attach=vi.fn(async()=>{}), complete=vi.fn(async()=>{expect(f.trace).toContain("ack");verified=true;});
    Object.assign(f.flow,{nativeAuthorizationContext:()=>context,attachNativeAuthorization:attach,pendingNativeSelection:()=>nativeChoice,completeNativeAuthorization:complete});
    const prepare=vi.fn(async()=>({authorizationId,applicationId:"independent-app",manifestDigest:"cc".repeat(32)}));
    let finishReply!:(v:never)=>void;
    const finish=vi.fn(()=>new Promise<never>(resolve=>{finishReply=resolve;}));
    const cancel=vi.fn();f.openPortal.mockReturnValue({navigate:f.navigatePortal,close:f.closePortal,nativeAuthorization:{prepare,finish,cancel}} as AppWebSignInPortal);
    f.flow.listApprovedCollections.mockResolvedValue([]);
    await f.session.start();f.selectOnPortal();await f.session.authorize();
    // Fixture's existing attested original device; no replacement actor.
    await Promise.resolve(); await approvalTick(f.session);
    expect(prepare).toHaveBeenCalledOnce();expect(attach).toHaveBeenCalledOnce();
    nativeChoice={requestId,authorizationRequestId:authorizationId,collectionId};f.approve();
    f.session.setForeground(false);f.session.setForeground(true);await vi.waitFor(()=>expect(finish).toHaveBeenCalledOnce());
    expect(f.closePortal).not.toHaveBeenCalled();expect(f.openCollection).not.toHaveBeenCalled();
    finishReply({} as never);await vi.waitFor(()=>expect(complete).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledOnce();expect(f.closePortal).toHaveBeenCalledOnce();expect(f.openPortal).toHaveBeenCalledOnce();
    await f.session.close();
  });
  it("genuine Hosted approval survives optional Native preparation failure, without Private fallback", async()=>{
    const f=fixture("pending","never");
    Object.assign(f.flow,{nativeAuthorizationContext:()=>({requestId:f.flow.view().requestId,appId:"independent-app",accountId:account,challenge:"ab".repeat(32)}),pendingNativeSelection:()=>null});
    const prepare=vi.fn(async()=>{throw new AppInstallationSignInError("unavailable");});
    const finish=vi.fn(),cancel=vi.fn();f.openPortal.mockReturnValue({navigate:f.navigatePortal,close:f.closePortal,nativeAuthorization:{prepare,finish,cancel}} as AppWebSignInPortal);
    await f.session.start();await f.session.authorize();f.selectOnPortal();await approvalTick(f.session);await Promise.resolve();
    f.approve();await approvalTick(f.session);expect(f.session.getSnapshot().status).toBe("unselected");expect(finish).not.toHaveBeenCalled();
    await f.session.close();
  });
});

describe("shared first-party web sign-in", () => {
  it("local Forget and failed inventory reads cannot imply revoked authority; accepted COMPLETE omission can", async () => {
    const f = fixture("paired", "never"); await f.session.start();
    expect(f.session.scopeWasRemoved(collectionId)).toBe(false);
    await f.session.forget(collectionId); await f.session.refreshCollectionList();
    expect(f.session.getSnapshot().collections).toEqual([]);
    expect(f.session.scopeWasRemoved(collectionId)).toBe(false);
    f.flow.listApprovedCollections.mockRejectedValueOnce(new AppInstallationSignInError("unavailable"));
    await expect(f.session.refreshCollectionList()).rejects.toMatchObject({reason: "unavailable"});
    expect(f.session.scopeWasRemoved(collectionId)).toBe(false);
    f.flow.listApprovedCollections.mockResolvedValue([]);
    await f.session.refreshCollectionList(); expect(f.session.scopeWasRemoved(collectionId)).toBe(true);
    await f.session.close();
  });
  it("serializes foreground inventory revalidation with a follower start instead of replying busy", async () => {
    const f = fixture("paired"); await f.session.start();
    const w = workerFixture(f), frames = w.frames;
    const foreground = vi.spyOn(f.session, "setForeground");
    const catalog = [{collectionId, displayName: "My notes", role: "owner" as const}];
    let release!: () => void;
    const held = new Promise<typeof catalog>(resolve => {release = () => resolve(catalog);});
    f.flow.listApprovedCollections.mockReturnValueOnce(held);
    try {
      w.send(0, "foreground", true);
      await vi.waitFor(() => expect(f.flow.listApprovedCollections).toHaveBeenCalledTimes(2));
      w.send(1, "start");
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(frames.some(frame => frame[2] === "reply" && frame[3] === 1)).toBe(false);
      // Repeated visible/focus/online reports wake native transport but coalesce
      // inventory work while the SAME original read is still in progress.
      for(let index = 0; index < 3; index++)w.send(0, "foreground", true);
      await vi.waitFor(() => expect(foreground).toHaveBeenCalledTimes(4));
      expect(f.flow.listApprovedCollections).toHaveBeenCalledTimes(2);
      release();
      await vi.waitFor(() => expect(frames.find(frame => frame[2] === "reply" && frame[3] === 1)?.[4]).toMatchObject({ok: true}));
      w.send(2, "select", collectionId);
      await vi.waitFor(() => expect(frames.find(frame => frame[2] === "reply" && frame[3] === 2)?.[4]).toMatchObject({ok: true}));
      expect(f.session.connection()).toBe(f.connection);
      expect(frames.filter(frame => frame[2] === "reply")).toHaveLength(2);
    } finally {release(); await w.close();}
  });
  it("revalidates the held collection on an online/focus report and fences removed access", async () => {
    const f = fixture("paired"); await f.session.start();
    expect(f.session.connection()).toBe(f.connection);
    const w = workerFixture(f), fencedBeforePublish: boolean[] = [];
    const unsubscribe = f.session.subscribe(() => {if(f.session.snapshot().collections.length === 0)fencedBeforePublish.push(f.closeConnection.mock.calls.length === 1 && f.collectionRelease.mock.calls.length === 1 && f.session.connection() === null);});
    f.flow.listApprovedCollections.mockResolvedValueOnce([]);
    try {
      w.send(0, "foreground", true);
      await vi.waitFor(() => expect(f.session.snapshot().collections).toEqual([]));
      expect(f.closeConnection).toHaveBeenCalledOnce();
      expect(f.session.connection()).toBeNull();
      expect(f.collectionRelease).toHaveBeenCalledOnce();
      expect(fencedBeforePublish.length).toBeGreaterThan(0);
      expect(fencedBeforePublish.every(Boolean)).toBe(true);
    } finally {unsubscribe(); await w.close();}
  });
  it("does not replace an open scope after failed reconnect metadata read", async () => {
    const f = fixture("paired"); await f.session.start();
    const w = workerFixture(f);
    f.flow.listApprovedCollections.mockRejectedValueOnce(new AppInstallationSignInError("unavailable"));
    try {
      w.send(0, "foreground", true);
      await vi.waitFor(() => expect(f.flow.listApprovedCollections).toHaveBeenCalledTimes(2));
      // The next lifecycle turn cannot run until the failed read has drained.
      w.send(1, "start");
      await vi.waitFor(() => expect(w.frames.find(frame => frame[2] === "reply" && frame[3] === 1)?.[4]).toMatchObject({ok: true}));
      expect(f.session.connection()).toBe(f.connection);
      expect(f.closeConnection).not.toHaveBeenCalled();
      expect(f.collectionRelease).not.toHaveBeenCalled();
    } finally {await w.close();}
  });
  it("UX-011: signOut revokes, closes everything, then erases; a fresh start is signed out and Sign in pairs afresh", async () => {
    vi.useFakeTimers(); const f = fixture("paired"); await f.session.start();
    expect(f.session.snapshot()).toMatchObject({status: "ready", selectedCollectionId: collectionId});
    const erase = vi.spyOn(erasure, "eraseAppInstallationData").mockImplementation(async () => {f.trace.push("erase"); f.eraseLedger(); return {ledger: true, complete: true};});
    const signedOut = await f.session.signOut();
    expect(signedOut).toMatchObject({status: "signed_out", signIn: null, collections: [], selectedCollectionId: null, problem: null,
      signOutResult: {server: "revoked", local: "erased", webPush: false}});
    expect(f.session.connection()).toBeNull();
    const order = ["connection-close", "host-close", "collection-release", "cp-sign-out", "flow-close", "installation-release", "erase"].map(step => f.trace.indexOf(step));
    expect(order.every(i => i >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(erase).toHaveBeenCalledOnce();
    expect(erase.mock.calls[0]![0]).toMatchObject({cpOrigin: release.cpOrigin, appId: "independent-app", accountId: account, installationId: installation, collectionIds: [collectionId]});
    // Same storage, next start: no installation is restored.
    await f.session.start(); expect(f.flowOpen).toHaveBeenCalledTimes(2);
    expect(f.session.snapshot()).toMatchObject({status: "signed_out", signIn: {state: "pending"}, signOutResult: null});
    await f.session.authorize(); expect(f.flow.start).toHaveBeenCalledOnce(); expect(f.navigatePortal).toHaveBeenCalledOnce();
    expect(f.session.snapshot().status).toBe("authorizing"); await f.session.close();
  });
  it("UX-011: an unreachable server still signs this device out, reported as a diagnostic; a kept ledger is sign_out_failed", async () => {
    const f = fixture("paired", "never"); await f.session.start();
    f.flow.signOutInstallation.mockRejectedValueOnce(new AppInstallationSignInError("outcome_unknown"));
    vi.spyOn(erasure, "eraseAppInstallationData").mockResolvedValueOnce({ledger: true, complete: false});
    expect(await f.session.signOut()).toMatchObject({status: "signed_out", signIn: null, problem: null, signOutResult: {server: "incomplete", local: "incomplete"}});
    const g = fixture("paired", "never"); await g.session.start();
    vi.spyOn(erasure, "eraseAppInstallationData").mockResolvedValueOnce({ledger: false, complete: false});
    await expect(g.session.signOut()).rejects.toMatchObject({reason: "sign_out_failed"});
    expect(g.session.snapshot()).toMatchObject({status: "blocked", problem: "sign_out_failed"});
    await f.session.close(); await g.session.close();
  });
  it("offers same-approved-collection Retry only after clean stop of exhausted pre-enrollment challenge work",async()=>{
    const f=fixture("paired","never"); await f.session.start();
    const error=Object.assign(new AppCloudCopyBootstrapError("unavailable"),{retryable:true}); f.openCollection.mockRejectedValueOnce(error);
    await expect(f.session.select(collectionId)).rejects.toBe(error);
    expect(f.session.snapshot()).toMatchObject({status:"unselected",problem:"unavailable",selectedCollectionId:collectionId});
    expect(f.session.connection()).toBeNull(); expect(f.host.close).toHaveBeenCalledOnce(); expect(f.collectionRelease).toHaveBeenCalledOnce();
    expect(f.trace.indexOf("host-close")).toBeLessThan(f.trace.indexOf("collection-release")); expect(f.installationRelease).not.toHaveBeenCalled();
    const receipt=f.flow.view().requestId; await f.session.select(collectionId); expect(f.session.snapshot().status).toBe("ready");
    expect(f.flow.view().requestId).toBe(receipt); expect(f.flowOpen).toHaveBeenCalledOnce(); expect(f.flow.start).not.toHaveBeenCalled(); expect(f.flow.renewExpiredPairing).not.toHaveBeenCalled(); await f.session.close();
  });
  it("failed native stop quarantines challenge exhaustion and never releases its lease or offers retryable selection",async()=>{
    const f=fixture("paired","never"); await f.session.start();
    const error=Object.assign(new AppCloudCopyBootstrapError("unavailable"),{retryable:true}); f.openCollection.mockRejectedValueOnce(error);
    f.host.close.mockRejectedValueOnce(new AppCloudCopyHostError("unavailable"));
    await expect(f.session.select(collectionId)).rejects.toMatchObject({reason:"unavailable"});
    expect(f.session.snapshot()).toMatchObject({status:"blocked",problem:"recovery_required"}); expect(f.collectionRelease).not.toHaveBeenCalled(); expect(f.session.connection()).toBeNull(); await f.session.close();
  });
  it.each(["outcome_unknown","response","binding"] as const)("uncertain/permanent %s bootstrap does not become retryable selection",async reason=>{
    const f=fixture("paired","never"); await f.session.start(); f.openCollection.mockRejectedValueOnce(new AppCloudCopyBootstrapError(reason));
    await expect(f.session.select(collectionId)).rejects.toMatchObject({reason}); expect(f.session.snapshot()).toMatchObject({status:"blocked",problem:reason}); expect(f.host.close).not.toHaveBeenCalled(); await f.session.close();
  });

  it("explicit original-target recovery stops the uncertain host before reopening and retains the approval/installation",async()=>{
    const f=fixture("paired","never");await f.session.start();const receipt=f.flow.view().requestId;
    f.openCollection.mockRejectedValueOnce(new AppCloudCopyBootstrapError("outcome_unknown"));await expect(f.session.select(collectionId)).rejects.toMatchObject({reason:"outcome_unknown"});
    expect(f.session.snapshot()).toMatchObject({status:"blocked",problem:"outcome_unknown"});expect(f.host.close).not.toHaveBeenCalled();
    await f.session.select(collectionId);expect(f.session.snapshot().status).toBe("ready");
    const stop=f.trace.indexOf("host-close"),release=f.trace.indexOf("collection-release"),reopen=f.trace.lastIndexOf("host-open");expect(stop).toBeLessThan(release);expect(release).toBeLessThan(reopen);
    expect(f.openCollection.mock.calls.map(call=>call[0].scope)).toEqual([{account,installation,collection:collectionId},{account,installation,collection:collectionId}]);
    expect(f.flow.view().requestId).toBe(receipt);expect(f.flowOpen).toHaveBeenCalledOnce();expect(f.flow.renewExpiredPairing).not.toHaveBeenCalled();await f.session.close();
  });
  it("close awaits challenge-exhaustion cleanup in the original occupied operation",async()=>{
    const f=fixture("paired","never");await f.session.start();let release!:()=>void;
    f.openCollection.mockRejectedValueOnce(Object.assign(new AppCloudCopyBootstrapError("unavailable"),{retryable:true}));
    f.host.close.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});});
    const pending=f.session.select(collectionId).catch(error=>error);await vi.waitFor(()=>expect(f.host.close).toHaveBeenCalledOnce());
    const stopped=f.session.close();await Promise.resolve();expect(f.host.close).toHaveBeenCalledOnce();expect(f.collectionRelease).not.toHaveBeenCalled();
    release();await pending;await stopped;expect(f.host.close).toHaveBeenCalledOnce();expect(f.collectionRelease).toHaveBeenCalledOnce();expect(f.session.snapshot().status).toBe("closed");
  });
  it("prepares sign-in without contacting Connect, opening account custody or polling before user sign-in", async () => {
    vi.useFakeTimers(); const f = fixture(), listener = vi.fn(); const stop = f.session.subscribe(listener);
    expect(f.session.getSnapshot().status).toBe("not_started"); await f.session.start();
    expect(f.session.snapshot().status).toBe("signed_out"); await vi.advanceTimersByTimeAsync(20000);
    // The pairing request is created by the sign-in gesture, not by every page load.
    expect(f.flow.start).not.toHaveBeenCalled();
    expect(f.flow.exchange).not.toHaveBeenCalled(); expect(f.hostOpen).not.toHaveBeenCalled(); expect(f.openPortal).not.toHaveBeenCalled(); expect(listener).toHaveBeenCalled(); stop(); await f.session.close();
  });
  it("one authorize opens Connect synchronously, automatically confirms the portal choice and attests, then opens the approved collection", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); f.selectOnPortal();
    const authorization = f.session.authorize(); expect(f.openPortal).toHaveBeenCalledOnce(); await authorization;
    expect(f.session.snapshot().status).toBe("authorizing"); expect(f.session.snapshot().signIn?.accountEmail).toBe("person@example.test"); expect(f.flow.confirmPortalSelectedAccount).toHaveBeenCalledOnce(); expect(f.host.attestInstallation).toHaveBeenCalledOnce();
    expect(f.trace.indexOf("portal-confirm")).toBeLessThan(f.trace.indexOf("installation-lease")); expect(f.trace.indexOf("installation-lease")).toBeLessThan(f.trace.indexOf("host-open"));
    expect(f.openCollection).not.toHaveBeenCalled(); f.approve(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot().status).toBe("ready"); expect(f.session.connection()).toBe(f.connection); expect(f.hostOpen).toHaveBeenCalledOnce(); expect(f.host.completeInstallationSignIn).toHaveBeenCalledOnce();
    expect(f.trace.indexOf("ack")).toBeLessThan(f.trace.indexOf("collection-open")); await f.session.close();
  });
  it.each(["refused","expired"] as const)("a %s window stops the wait, and the next sign-in renews it from that gesture", async reason => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.authorize();
    expect(f.session.snapshot().status).toBe("authorizing");
    f.flow.exchange.mockRejectedValueOnce(new AppInstallationSignInError(reason)); await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot()).toMatchObject({status: "blocked", problem: reason});
    f.flow.start.mockRejectedValueOnce(new AppInstallationSignInError(reason)); await f.session.authorize();
    expect(f.flow.renewExpiredPairing).toHaveBeenCalledOnce(); expect(f.navigatePortal).toHaveBeenCalledTimes(2);
    expect(f.session.snapshot().status).toBe("authorizing"); await f.session.close();
  });
  it("does not renew a window the flow refuses to renew", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start();
    const refused = new AppInstallationSignInError("refused");
    f.flow.start.mockRejectedValueOnce(refused); f.flow.renewExpiredPairing.mockRejectedValueOnce(new AppInstallationSignInError("recovery_required"));
    await expect(f.session.authorize()).rejects.toBe(refused); expect(f.closePortal).toHaveBeenCalledOnce(); await f.session.close();
  });
  it("retains provider display identity while account UUID alone binds native custody and collection ownership", async () => {
    vi.useFakeTimers();const f=fixture("pending","only",true);await f.session.start();f.selectOnPortal();await f.session.authorize();
    expect(f.session.snapshot().signIn).toMatchObject({accountEmail:null,accountProvider:"github",accountLogin:"fixture-login"});
    expect(f.trace.indexOf("portal-confirm")).toBeLessThan(f.trace.indexOf("installation-lease"));expect(f.hostOpen).toHaveBeenCalledOnce();expect(f.openCollection).not.toHaveBeenCalled();
    f.approve();await vi.advanceTimersByTimeAsync(1000);expect(f.session.snapshot().status).toBe("ready");expect(f.session.snapshot().signIn?.accountId).toBe(account);expect(f.hostOpen).toHaveBeenCalledOnce();await f.session.close();
  });
  it("keeps automatically reading the original receipt after accepted approval is still pending, without a Refresh collections action", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); f.selectOnPortal(); await f.session.authorize();
    // Portal POST202 is acceptance, not paired/receipt readiness. The first
    // receipt read and subsequent 30 seconds all remain awaiting approval.
    const originalRequest = f.flow.view().requestId; await vi.advanceTimersByTimeAsync(30000);
    expect(f.session.snapshot().status).toBe("authorizing"); expect(f.flow.exchange).toHaveBeenCalledTimes(31);
    expect(f.flow.view().requestId).toBe(originalRequest); expect(f.flow.start).toHaveBeenCalledOnce();
    expect(f.flowOpen).toHaveBeenCalledOnce(); expect(f.hostOpen).toHaveBeenCalledOnce(); expect(f.host.attestInstallation).toHaveBeenCalledOnce(); expect(f.flow.renewExpiredPairing).not.toHaveBeenCalled(); expect(f.openCollection).not.toHaveBeenCalled();
    f.approve(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot().status).toBe("ready"); expect(f.session.connection()).toBe(f.connection);
    expect(f.flow.exchange).toHaveBeenCalledTimes(32); expect(f.flow.view().requestId).toBe(originalRequest);
    expect(f.host.completeInstallationSignIn).toHaveBeenCalledOnce(); expect(f.openCollection).toHaveBeenCalledOnce(); expect(f.host.attestInstallation).toHaveBeenCalledOnce();
    await f.session.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("only freshly consumed CP creation provenance enables automatic setup policy", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); f.selectOnPortal(); await f.session.authorize(); f.approve(true); await vi.advanceTimersByTimeAsync(1000);
    expect(f.openCollection.mock.calls[0]![0].setupPolicy).toBe("approved-new-collection"); expect(f.session.snapshot().timing?.readyMs).toBeGreaterThanOrEqual(0); await f.session.close();
    const restored = fixture("paired"); restored.approve(true); await restored.session.start();
    expect(restored.openCollection.mock.calls[0]![0].setupPolicy).toBe("explicit"); expect(restored.session.snapshot().timing).toBeNull(); await restored.session.close();
  });
  it("approved discovery alone stays unselected when the owner has disabled auto-selection", async () => {
    const f = fixture("paired", "never"); await f.session.start(); expect(f.session.snapshot().status).toBe("unselected"); expect(f.session.connection()).toBeNull(); expect(f.openCollection).not.toHaveBeenCalled();
    await f.session.select(collectionId); expect(f.session.snapshot().status).toBe("ready"); await f.session.close();
  });
  it("existing collection requiring setup does not become ready or automatically install", async () => {
    const f = fixture("paired"); f.openCollection.mockImplementationOnce(async () => ({state: "setup_required", connection: f.connection, close: f.closeConnection}));
    await f.session.start(); expect(f.session.snapshot().status).toBe("setup_required"); expect(f.session.connection()).toBe(f.connection); expect(f.flow.exchange).not.toHaveBeenCalled(); expect(f.host.attestInstallation).not.toHaveBeenCalled(); await f.session.close();
  });
  it("pushes actual same-adapter setup assessment and ignores retired generation callbacks", async () => {
    const f = fixture("paired");
    let state: "ready" | "setup_required" = "setup_required", notify: () => void = () => {};
    const stop = vi.fn();
    f.openCollection.mockImplementationOnce(async () => ({get state() {return state;}, connection: f.connection, close: f.closeConnection,
      subscribe(listener: () => void) {notify = listener; return stop;},
    }));
    await f.session.start(); expect(f.session.snapshot().status).toBe("setup_required");
    state = "ready"; notify(); expect(f.session.snapshot().status).toBe("ready");
    expect(f.openCollection).toHaveBeenCalledOnce();
    await f.session.clearSelection(); expect(stop).toHaveBeenCalledOnce();
    notify(); expect(f.session.snapshot().status).toBe("unselected"); expect(f.session.connection()).toBeNull();
    await f.session.close();
  });
  it.each(["collection_migrating","collection_not_yet_migrated"])("shows live %s without replacing the connection, and clears it when it lifts", async code => {
    const f = fixture("paired"); let problem: unknown = null, notify: () => void = () => {};
    f.openCollection.mockImplementationOnce(async () => ({state: "ready", get problem() {return problem;}, connection: f.connection, close: f.closeConnection,
      subscribe(listener: () => void) {notify = listener; return () => {};}}));
    await f.session.start(); expect(f.session.snapshot()).toMatchObject({status: "ready", problem: null});
    const server = appServerProblem(409, {error: {code, details: {retry_after_seconds: 30}}});
    problem = server; notify();
    expect(f.session.snapshot()).toMatchObject({status: "ready", problem: code, problemDetail: {server}});
    expect(f.session.connection()).toBe(f.connection); expect(f.closeConnection).not.toHaveBeenCalled();
    problem = {...server}; notify(); expect(f.session.snapshot().problem).toBeNull(); // only SDK-parsed problems count
    problem = appServerProblem(409, {error: {code: "collection_unavailable", details: {reason: "moved_to_next_runtime"}}}); notify();
    expect(f.session.snapshot().problem).toBe("update_required");
    problem = null; notify(); expect(f.session.snapshot()).toMatchObject({status: "ready", problem: null}); expect(f.session.snapshot().problemDetail).toBeUndefined();
    await f.session.close();
  });
  it("access ended on the log blocks at once (no connection for any tab) and stops the collection; local data is kept", async () => {
    const f = fixture("paired"); let ended: "forbidden" | "gone" | null = null, notify: () => void = () => {};
    f.openCollection.mockImplementationOnce(async () => ({state: "ready", get ended() {return ended;}, connection: f.connection, close: f.closeConnection,
      subscribe(listener: () => void) {notify = listener; return () => {};}}));
    await f.session.start(); expect(f.session.snapshot().status).toBe("ready");
    f.flow.listApprovedCollections.mockResolvedValue([]); // the server removed this account
    ended = "forbidden"; notify();
    expect(f.session.snapshot()).toMatchObject({status: "blocked", problem: "access_removed"});
    expect(f.session.connection()).toBeNull();
    await vi.waitFor(() => expect(f.closeConnection).toHaveBeenCalledOnce());
    // The list is read again, so the removed collection drops out; the block stays.
    await vi.waitFor(() => expect(f.session.snapshot().collections).toEqual([]));
    expect(f.session.snapshot()).toMatchObject({status: "blocked", problem: "access_removed"});
    await f.session.close();
  });
  it("completed restore has no start/exchange/attest HTTP and retains the original installation owner", async () => {
    const f = fixture("paired"); await f.session.start(); expect(f.hostOpen).toHaveBeenCalledOnce(); expect(f.flow.exchange).not.toHaveBeenCalled(); expect(f.host.attestInstallation).not.toHaveBeenCalled(); expect(f.openPortal).not.toHaveBeenCalled(); await f.session.close();
  });
  it("legacy or unconfirmed portal selection blocks before any account-scoped custody", async () => {
    const f = fixture(); await f.session.start(); f.selectOnPortal(); f.flow.confirmPortalSelectedAccount.mockRejectedValueOnce(new AppInstallationSignInError("account_confirmation_required"));
    await expect(f.session.authorize()).rejects.toMatchObject({reason: "account_confirmation_required"}); expect(f.session.snapshot()).toMatchObject({status: "blocked", problem: "account_confirmation_required"}); expect(f.hostOpen).not.toHaveBeenCalled(); expect(f.host.attestInstallation).not.toHaveBeenCalled(); await f.session.close();
  });
  it("attestation lost reply retains original host/proof and retries only from another explicit authorize", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); f.selectOnPortal(); f.host.attestInstallation.mockRejectedValueOnce(new AppInstallationSignInError("outcome_unknown"));
    await expect(f.session.authorize()).rejects.toMatchObject({reason: "outcome_unknown"}); await vi.advanceTimersByTimeAsync(20000); expect(f.flow.exchange).toHaveBeenCalledOnce(); expect(f.hostOpen).toHaveBeenCalledOnce();
    await f.session.authorize(); expect(f.hostOpen).toHaveBeenCalledOnce(); expect(f.host.attestInstallation).toHaveBeenCalledTimes(2); await f.session.close();
  });
  it("transient receipt loss automatically rechecks only the exact existing request", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); f.flow.exchange.mockRejectedValueOnce(new AppInstallationSignInError("outcome_unknown"));
    await f.session.authorize(); expect(f.session.snapshot()).toMatchObject({status: "authorizing", problem: "outcome_unknown"});
    await vi.advanceTimersByTimeAsync(4999); expect(f.flow.exchange).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1);
    expect(f.flow.exchange).toHaveBeenCalledTimes(2); expect(f.flowOpen).toHaveBeenCalledOnce(); expect(f.flow.start).toHaveBeenCalledOnce(); expect(f.hostOpen).not.toHaveBeenCalled(); await f.session.close();
  });
  it("the approval window closes once approval is observed, for sign-in and for added consent", async () => {
    // Regression (LAB 2026-10-12): the approval popup stayed open after approval.
    vi.useFakeTimers();
    {
      const f = fixture(); await f.session.start(); f.selectOnPortal(); await f.session.authorize();
      await vi.advanceTimersByTimeAsync(3000); expect(f.closePortal).not.toHaveBeenCalled();
      f.approve(); await vi.advanceTimersByTimeAsync(1000);
      expect(f.session.snapshot().status).toBe("ready"); expect(f.closePortal).toHaveBeenCalledOnce();
      await f.session.close();
      const g = fixture("paired"); await g.session.start(); await g.session.authorize();
      await vi.advanceTimersByTimeAsync(1000); expect(g.closePortal).not.toHaveBeenCalled();
      g.approveConsent(); await vi.advanceTimersByTimeAsync(1000);
      expect(g.session.snapshot().status).toBe("ready"); expect(g.closePortal).toHaveBeenCalledOnce();
      await g.session.close();
    }
  });
  // Regression (LAB 2026-10-12): closing the Connect popup before approving
  // left the app "Waiting for approval in the mdbase window…" forever.
  function closablePortal(f: ReturnType<typeof fixture>) {
    const window = {gone: false};
    f.openPortal.mockImplementation(() => ({navigate: f.navigatePortal, close: f.closePortal, get closed() {return window.gone;}}));
    return window;
  }
  it("accepts an app popup that reports closed like Window.closed", () => {
    // Apps already wrap their popup as `{readonly closed: boolean}`; the portal
    // contract must keep compiling for them (typecheck covers this file).
    interface AppPopup extends AppWebSignInPortal { readonly closed: boolean }
    let gone = false; const popup: AppPopup = {navigate() {}, close() {gone = true;}, get closed() {return gone;}};
    const portal: AppWebSignInPortal = popup; popup.close(); expect(portal.closed).toBe(true);
  });
  it("a closed approval window gets one final read, then signs out, and Sign in works again", async () => {
    vi.useFakeTimers(); const f = fixture(), popup = closablePortal(f); await f.session.start(); f.selectOnPortal(); await f.session.authorize();
    expect(f.session.snapshot().status).toBe("authorizing"); const reads = f.flow.exchange.mock.calls.length;
    popup.gone = true; await vi.advanceTimersByTimeAsync(1000);
    expect(f.flow.exchange).toHaveBeenCalledTimes(reads + 1);
    expect(f.session.snapshot()).toMatchObject({status: "signed_out", problem: "approval_window_closed"});
    await vi.advanceTimersByTimeAsync(30000); expect(f.flow.exchange).toHaveBeenCalledTimes(reads + 1);
    popup.gone = false; await f.session.authorize();
    expect(f.session.snapshot()).toMatchObject({status: "authorizing", problem: null}); expect(f.flow.start).toHaveBeenCalledTimes(2);
    f.approve(); await vi.advanceTimersByTimeAsync(1000); expect(f.session.snapshot().status).toBe("ready"); await f.session.close();
  });
  it("a window closed after Connect approved pairs instead of signing out", async () => {
    vi.useFakeTimers(); const f = fixture(), popup = closablePortal(f); await f.session.start(); f.selectOnPortal(); await f.session.authorize();
    f.approve(); popup.gone = true; await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot()).toMatchObject({status: "ready", problem: null}); expect(f.closePortal).toHaveBeenCalledOnce(); await f.session.close();
  });
  it("a closed add-collection window keeps the person signed in on their collections", async () => {
    vi.useFakeTimers(); const f = fixture("paired"), popup = closablePortal(f); await f.session.start(); await f.session.authorize();
    expect(f.session.snapshot().status).toBe("authorizing"); const reads = f.flow.exchangeCollectionConsent.mock.calls.length;
    popup.gone = true; await vi.advanceTimersByTimeAsync(1000);
    expect(f.flow.exchangeCollectionConsent).toHaveBeenCalledTimes(reads + 1);
    expect(f.session.snapshot()).toMatchObject({status: "ready", problem: null, selectedCollectionId: collectionId});
    await vi.advanceTimersByTimeAsync(30000); expect(f.flow.exchangeCollectionConsent).toHaveBeenCalledTimes(reads + 1); await f.session.close();
  });
  it("a page that did not start a closed add-collection window keeps showing its collection throughout", async () => {
    vi.useFakeTimers(); const f = fixture("paired"), popup = closablePortal(f); await f.session.start(); await f.session.authorize();
    const seen: string[] = []; f.session.subscribe(() => seen.push(f.session.viewFor(collectionId, {bystander: true}).status));
    popup.gone = true; await vi.advanceTimersByTimeAsync(1000);
    expect(seen.length).toBeGreaterThan(0); expect(seen).not.toContain("authorizing");
    expect(f.session.viewFor(collectionId, {bystander: true})).toMatchObject({status: "ready", selectedCollectionId: collectionId}); await f.session.close();
  });
  it.each(["refused", "expired"] as const)("a re-consent %s in Connect cancels back to the collections, never blocked", async reason => {
    vi.useFakeTimers(); const f = fixture("paired"); await f.session.start(); await f.session.authorize();
    expect(f.session.snapshot().status).toBe("authorizing"); const reads = f.flow.exchangeCollectionConsent.mock.calls.length;
    f.flow.exchangeCollectionConsent.mockRejectedValueOnce(new AppInstallationSignInError(reason));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot()).toMatchObject({status: "ready", problem: null, selectedCollectionId: collectionId, approval: {outcome: "cancelled"}});
    expect(f.closePortal).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000); expect(f.flow.exchangeCollectionConsent).toHaveBeenCalledTimes(reads + 1); await f.session.close();
  });
  it("additional consent reserves a new portal request, auto-detects choice and never repeats keys/attestation", async () => {
    vi.useFakeTimers(); const f = fixture("paired"); await f.session.start(); await f.session.authorize();
    expect(f.navigatePortal.mock.calls[0]![0]).not.toBe(f.flow.view().verificationUri); expect(f.flow.startCollectionConsent).toHaveBeenCalledOnce(); expect(f.host.attestInstallation).not.toHaveBeenCalled();
    f.approveConsent(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot().status).toBe("ready"); expect(f.hostOpen).toHaveBeenCalledOnce(); expect(f.flow.confirmPortalSelectedAccount).not.toHaveBeenCalled(); await f.session.close();
  });
  it("re-approving the still-approved open collection keeps it open on the same adapter", async () => {
    vi.useFakeTimers(); const f = fixture("paired", "never"); await f.session.start(); await f.session.select(collectionId);
    await f.session.authorize(); f.approveConsent(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot()).toMatchObject({status: "ready", selectedCollectionId: collectionId}); expect(f.openCollection).toHaveBeenCalledOnce();
    expect(f.closeConnection).not.toHaveBeenCalled(); expect(f.session.connection()).toBe(f.connection); await f.session.close();
  });
  it("an old scope-only receipt cannot borrow confirmation from the initial request", async () => {
    vi.useFakeTimers(); const f = fixture("paired", "never"); await f.session.start(); await f.session.authorize(); f.approveConsent(false); await vi.advanceTimersByTimeAsync(1000);
    expect(f.session.snapshot()).toMatchObject({status: "blocked", problem: "account_confirmation_required"}); expect(f.openCollection).not.toHaveBeenCalled(); expect(f.host.attestInstallation).not.toHaveBeenCalled(); await f.session.close();
  });
  it("refused storage never falls back fresh or opens native custody", async () => {
    const f = fixture(); f.flowOpen.mockRejectedValueOnce(new AppInstallationSignInError("recovery_required"));
    await expect(f.session.start()).rejects.toMatchObject({reason: "recovery_required"}); expect(f.flowOpen).toHaveBeenCalledOnce(); expect(f.hostOpen).not.toHaveBeenCalled(); expect(f.flow.start).not.toHaveBeenCalled(); await f.session.close();
  });
  it("reports an unexpected original open failure without claiming recovery or retrying automatically", async () => {
    vi.useFakeTimers(); const f = fixture("paired", "never"); await f.session.start();
    const original = new TypeError("private response bearer and body");
    Object.defineProperty(original, "name", {get() {throw Error("private name");}});
    f.openCollection.mockRejectedValueOnce(original);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(f.session.select(collectionId)).rejects.toBe(original);
    expect(f.session.snapshot()).toMatchObject({status: "blocked", problem: "open_failed", selectedCollectionId: collectionId, problemDetail: {name: "TypeError", code: null}});
    expect(f.session.connection()).toBeNull();
    expect(log).toHaveBeenCalledWith("mdbase web sign-in open failed", "TypeError", null);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    await vi.advanceTimersByTimeAsync(30000); expect(f.openCollection).toHaveBeenCalledOnce();
    await f.session.select(collectionId); expect(f.session.snapshot().problem).toBeNull();
    expect(f.session.snapshot()).not.toHaveProperty("problemDetail");
    expect(f.flowOpen).toHaveBeenCalledOnce(); expect(f.flow.renewExpiredPairing).not.toHaveBeenCalled();
    expect(f.openCollection).toHaveBeenCalledTimes(2); await f.session.close();
  });
  it.each([
    new AppCloudCopyHostError("recovery_required"),
    new AppCollectionSetupError("recovery_required"),
    new AppCollectionSetupError("outcome_unknown"),
    new MdbaseError({code: "outcome_unknown", recovery: "resolve_outcome", message: "private", reason: "private"}),
  ])("retains actual typed recovery/unknown predicates and the original rejection", async original => {
    const f = fixture("paired", "never"); await f.session.start(); f.openCollection.mockRejectedValueOnce(original);
    await expect(f.session.select(collectionId)).rejects.toBe(original);
    expect(f.session.snapshot().problem).toBe(original instanceof MdbaseError ? original.code : original.reason);
    expect(JSON.stringify(f.session.snapshot().problemDetail)).not.toContain("private");
    expect(f.session.connection()).toBeNull(); await f.session.close();
  });
  it("logging failures do not replace an unknown thrown value or infer its arbitrary recovery reason", async () => {
    const f = fixture("paired", "never"); await f.session.start();
    const original = {reason: "recovery_required", name: "private", code: "private", body: "private"};
    f.openCollection.mockRejectedValueOnce(original);
    vi.spyOn(console, "error").mockImplementation(() => {throw Error("logger unavailable");});
    await expect(f.session.select(collectionId)).rejects.toBe(original);
    expect(f.session.snapshot()).toMatchObject({problem: "open_failed", problemDetail: {name: "UnknownError", code: null}});
    await f.session.close();
  });
  it("keeps an unmigrated local collection typed and retries only on an explicit selection", async () => {
    vi.useFakeTimers(); const f=fixture("paired","never"); await f.session.start();
    const server={status:409,code:"collection_not_yet_migrated",reason:null,retryAfterMs:null,updateUrl:null};
    f.openCollection.mockRejectedValueOnce(new AppCloudCopyBootstrapError("collection_not_yet_migrated",false,server));
    await expect(f.session.select(collectionId)).rejects.toMatchObject({reason:"collection_not_yet_migrated"});
    expect(f.session.snapshot()).toMatchObject({status:"blocked",problem:"collection_not_yet_migrated",problemDetail:{server}});
    await vi.advanceTimersByTimeAsync(600_000); expect(f.openCollection).toHaveBeenCalledOnce();
    await f.session.select(collectionId);
    expect(f.session.snapshot()).toMatchObject({status:"ready",problem:null,selectedCollectionId:collectionId});
    await f.session.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("reopens the same collection by itself after the server's migration retry delay", async () => {
    vi.useFakeTimers(); const f=fixture("paired","never"); await f.session.start();
    const server={status:409,code:"collection_migrating",reason:null,retryAfterMs:20_000,updateUrl:null};
    f.openCollection.mockRejectedValueOnce(new AppCloudCopyBootstrapError("collection_migrating",false,server));
    await expect(f.session.select(collectionId)).rejects.toMatchObject({reason:"collection_migrating"});
    expect(f.session.snapshot()).toMatchObject({status:"blocked",problem:"collection_migrating",problemDetail:{server}});
    await vi.advanceTimersByTimeAsync(19_999); expect(f.openCollection).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(f.openCollection).toHaveBeenCalledTimes(2);
    expect(f.session.snapshot()).toMatchObject({status:"ready",problem:null,selectedCollectionId:collectionId});
    await f.session.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("polls hidden owners less often and exchanges immediately on foreground resume", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(); await f.session.authorize(); f.session.setForeground(false);
    await vi.advanceTimersByTimeAsync(9999); expect(f.flow.exchange).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1); expect(f.flow.exchange).toHaveBeenCalledTimes(2);
    f.session.setForeground(true); await vi.advanceTimersByTimeAsync(0); expect(f.flow.exchange).toHaveBeenCalledTimes(3); await f.session.close(); expect(vi.getTimerCount()).toBe(0);
  });
  async function busyReceipt(kind: "pair" | "consent" = "pair") {
    vi.useFakeTimers(); const f = fixture(kind === "consent" ? "paired" : "pending", "never");
    await f.session.start(); await f.session.authorize(); f.session.setForeground(false);
    const read = kind === "consent" ? f.flow.exchangeCollectionConsent : f.flow.exchange;
    const original = read.getMockImplementation()!;
    let finish!: () => void, reject!: (error: unknown) => void;
    read.mockImplementationOnce(async () => {
      await new Promise<void>((resolve, fail) => {finish = resolve; reject = fail;});
      return original() as never;
    });
    await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledTimes(2);
    f.session.setForeground(true); f.session.setForeground(true); f.session.setForeground(true);
    expect(read).toHaveBeenCalledTimes(2);
    return {f, read, finish: () => finish(), reject: (error: unknown) => reject(error)};
  }
  it.each(["pair", "consent"] as const)("coalesces %s foreground resume during original receipt READ into one after-drain refresh", async kind => {
    const b = await busyReceipt(kind); b.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(b.read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(0); expect(b.read).toHaveBeenCalledTimes(3);
    expect(b.f.flow.start).toHaveBeenCalledTimes(kind === "pair" ? 1 : 0);
    expect(b.f.host.attestInstallation).not.toHaveBeenCalled(); expect(b.f.openCollection).not.toHaveBeenCalled();
    if (kind === "pair") expect(b.f.hostOpen).not.toHaveBeenCalled();
    await b.f.session.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("a sign-in gesture during a background approval read waits for it and keeps its window open", async () => {
    const b = await busyReceipt(), f = b.f, closeSecond = vi.fn();
    f.openPortal.mockImplementationOnce(() => ({navigate: f.navigatePortal, close: closeSecond}));
    const again = f.session.authorize(); expect(f.openPortal).toHaveBeenCalledTimes(2);
    b.finish(); await vi.advanceTimersByTimeAsync(0); await again;
    // This gesture's window stays open; only the superseded first one closes.
    expect(closeSecond).not.toHaveBeenCalled(); expect(f.closePortal).toHaveBeenCalledOnce(); expect(f.navigatePortal).toHaveBeenCalledTimes(2);
    expect(f.session.snapshot().status).toBe("authorizing"); await f.session.close();
  });
  it.each(["close", "abort", "hidden"] as const)("drops a queued receipt refresh on %s before original reply", async action => {
    const b = await busyReceipt();
    let closed: Promise<void> | undefined;
    if (action === "close") closed = b.f.session.close();
    if (action === "abort") {b.f.parent.abort(); closed = b.f.session.close();}
    if (action === "hidden") b.f.session.setForeground(false);
    b.finish(); await closed; await vi.advanceTimersByTimeAsync(0);
    expect(b.read).toHaveBeenCalledTimes(2); expect(b.f.hostOpen).not.toHaveBeenCalled();
    if (action === "hidden") {
      await vi.advanceTimersByTimeAsync(9999); expect(b.read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1); expect(b.read).toHaveBeenCalledTimes(3);
    }
    await b.f.session.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["retired", "request", "identity", "phase"] as const)("drops queued refresh when the original receipt %s changes", async change => {
    const b = await busyReceipt(), original = b.f.flow.view();
    if (change === "retired") b.f.flow.isCurrent = () => false;
    if (change === "request") b.f.flow.view = () => ({...original, requestId: "99999999-9999-4999-8999-999999999999"});
    if (change === "identity") b.f.flow.view = () => ({...original, installationId: "99999999-9999-4999-8999-999999999999"});
    if (change === "phase") b.f.flow.view = () => ({...original, state: "awaiting_approval"});
    b.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(b.read).toHaveBeenCalledTimes(2); expect(b.f.hostOpen).not.toHaveBeenCalled();
    await b.f.session.close();
  });
  it("does not refresh a replacement consent request after the original receipt returns", async () => {
    const b = await busyReceipt("consent"), original = b.f.flow.collectionConsentView()!;
    b.f.flow.collectionConsentView.mockImplementation(() => ({...original, requestId: "99999999-9999-4999-8999-999999999999"}));
    b.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(b.read).toHaveBeenCalledTimes(2); expect(b.f.host.attestInstallation).not.toHaveBeenCalled();
    await b.f.session.close();
  });
  it("does not refresh again after the original consent completion; an autoSelect never owner opens the fresh pick itself", async () => {
    const b = await busyReceipt("consent"); b.f.approveConsent(); b.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(b.read).toHaveBeenCalledTimes(2); expect(b.f.openCollection).not.toHaveBeenCalled();
    expect(b.f.session.snapshot()).toMatchObject({status: "unselected", selectedCollectionId: null}); expect(b.f.host.attestInstallation).not.toHaveBeenCalled();
    await b.f.session.close();
  });
  it("rechecks original receipt generation before the deferred timer dispatch", async () => {
    const b = await busyReceipt(), timeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 0) b.f.flow.isCurrent = () => false;
      return timeout(callback, delay, ...args);
    }) as typeof setTimeout);
    b.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(b.read).toHaveBeenCalledTimes(2); expect(b.f.hostOpen).not.toHaveBeenCalled();
    await b.f.session.close();
  });
  it("does not turn a busy consent START mutation into an immediate read queue", async () => {
    vi.useFakeTimers(); const f = fixture("paired", "never"); await f.session.start(); f.session.setForeground(false);
    const original = f.flow.startCollectionConsent.getMockImplementation()!; let finish!: () => void;
    f.flow.startCollectionConsent.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {finish = resolve;}); return original();
    });
    const authorizing = f.session.authorize(); await vi.advanceTimersByTimeAsync(0);
    f.session.setForeground(true); finish(); await authorizing; await vi.advanceTimersByTimeAsync(0);
    expect(f.flow.startCollectionConsent).toHaveBeenCalledOnce(); expect(f.flow.exchangeCollectionConsent).toHaveBeenCalledOnce();
    expect(f.host.attestInstallation).not.toHaveBeenCalled(); expect(f.openCollection).not.toHaveBeenCalled();
    await f.session.close();
  });
  it("changed verified receipt advances original confirmation once without an extra queued READ", async () => {
    const b = await busyReceipt(); b.f.selectOnPortal(); b.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(b.read).toHaveBeenCalledTimes(2); expect(b.f.flow.confirmPortalSelectedAccount).toHaveBeenCalledOnce();
    expect(b.f.host.attestInstallation).toHaveBeenCalledOnce(); expect(b.f.openCollection).not.toHaveBeenCalled();
    await b.f.session.close();
  });
  it("unknown receipt reply retains the original 5-second cadence, not a queued hot retry", async () => {
    const b = await busyReceipt(); b.reject(new AppInstallationSignInError("outcome_unknown"));
    await vi.advanceTimersByTimeAsync(0); expect(b.read).toHaveBeenCalledTimes(2);
    expect(b.f.session.snapshot().problem).toBe("outcome_unknown");
    await vi.advanceTimersByTimeAsync(4999); expect(b.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(b.read).toHaveBeenCalledTimes(3);
    await b.f.session.close();
  });
  it("forget is local selection only and closes adapter/native before collection unlock", async () => {
    const f = fixture("paired"); await f.session.start(); await f.session.forget(collectionId);
    expect(f.session.connection()).toBeNull(); expect(f.session.snapshot()).toMatchObject({status: "unselected", collections: [], selectedCollectionId: null});
    expect(f.flow.close).not.toHaveBeenCalled(); expect(f.trace.indexOf("connection-close")).toBeLessThan(f.trace.indexOf("host-close")); expect(f.trace.indexOf("host-close")).toBeLessThan(f.trace.indexOf("collection-release")); await f.session.close();
  });
  it("collection delete is owner-only, and a CP refusal never blocks or closes the open collection", async () => {
    const f = fixture("paired"); await f.session.start();
    f.flow.deleteApprovedCollection.mockRejectedValueOnce(new AppInstallationSignInError("refused", appServerProblem(409, {error: {code: "collection_name_mismatch", message: "server text"}})));
    await expect(f.session.deleteCollection(collectionId, "Wrong")).rejects.toMatchObject({code: "collection_delete_name_mismatch"});
    expect(f.session.snapshot()).toMatchObject({status: "ready", selectedCollectionId: collectionId, problem: null});
    expect(f.session.connection()).not.toBeNull(); expect(f.closeConnection).not.toHaveBeenCalled();
    f.flow.deleteApprovedCollection.mockRejectedValueOnce(new AppInstallationSignInError("outcome_unknown"));
    await expect(f.session.deleteCollection(collectionId, "My notes")).rejects.toMatchObject({code: "collection_delete_outcome_unknown"});
    await f.session.deleteCollection(collectionId, "My notes");
    expect(f.flow.deleteApprovedCollection).toHaveBeenLastCalledWith(expect.anything(), collectionId, "My notes");
    await f.session.close();
    const editor = fixture("paired"); editor.flow.listApprovedCollections.mockResolvedValue([{collectionId, displayName: "My notes", role: "editor"}]);
    await editor.session.start();
    await expect(editor.session.deleteCollection(collectionId, "My notes")).rejects.toMatchObject({code: "collection_delete_not_owner"});
    expect(editor.flow.deleteApprovedCollection).not.toHaveBeenCalled(); await editor.session.close();
  });
  it("close aborts work, drains in-flight acquisition and shuts down native before closing the protected flow/unlocking", async () => {
    const f = fixture("paired"); await f.session.start(); await f.session.close();
    expect(f.flowSignal()?.aborted).toBe(true); expect(f.trace.indexOf("host-close")).toBeLessThan(f.trace.indexOf("flow-close")); expect(f.trace.indexOf("flow-close")).toBeLessThan(f.trace.indexOf("installation-release")); expect(f.session.snapshot().status).toBe("closed"); await f.session.close(); expect(f.installationRelease).toHaveBeenCalledOnce();
  });
  it("failed native shutdown retains the installation/collection leases and original protected flow", async () => {
    const f = fixture("paired"); await f.session.start(); f.host.close.mockRejectedValueOnce(Error("native close failed"));
    await expect(f.session.close()).rejects.toThrow("native close failed"); expect(f.collectionRelease).not.toHaveBeenCalled(); expect(f.installationRelease).not.toHaveBeenCalled(); expect(f.flow.close).not.toHaveBeenCalled(); expect(f.flowSignal()?.aborted).toBe(false);
  });
  it("failed adapter close quarantines the old connection; retry assesses the new actual scope", async () => {
    const f = fixture("paired", "never"), nextId = "77777777-7777-4777-8777-777777777777", nextConnection = {name: "next collection"};
    f.flow.listApprovedCollections.mockResolvedValue([{collectionId, displayName: "My notes", role: "owner"}, {collectionId: nextId, displayName: "Next notes", role: "owner"}]);
    vi.mocked(ownership.acquireAppReplicaLease).mockImplementation(async (_locks, scope) => {expect([collectionId, nextId]).toContain(scope.collection); return {release: f.collectionRelease};});
    f.openCollection.mockImplementation(async p => ({state: "ready", connection: p.scope.collection === collectionId ? f.connection : nextConnection, close: f.closeConnection}));
    await f.session.start(); await f.session.select(collectionId); expect(f.session.connection()).toBe(f.connection);
    f.closeConnection.mockRejectedValueOnce(Error("adapter close failed"));
    await expect(f.session.select(nextId)).rejects.toThrow("adapter close failed");
    expect(f.session.snapshot()).toMatchObject({status: "blocked", selectedCollectionId: nextId}); expect(f.session.connection()).toBeNull();
    expect(f.collectionRelease).not.toHaveBeenCalled(); expect(f.host.close).not.toHaveBeenCalled(); expect(f.installationRelease).not.toHaveBeenCalled(); expect(f.openCollection).toHaveBeenCalledOnce();
    await f.session.select(nextId); expect(f.session.snapshot()).toMatchObject({status: "ready", selectedCollectionId: nextId}); expect(f.session.connection()).toBe(nextConnection);
    expect(f.openCollection).toHaveBeenCalledTimes(2); expect(f.openCollection.mock.calls[1]![0].scope).toEqual({account, installation, collection: nextId});
    await f.session.close();
  });
  it("persistent adapter shutdown failure never publishes either scope or unlocks native authority", async () => {
    const f = fixture("paired"); await f.session.start(); f.closeConnection.mockRejectedValue(Error("adapter stop failed"));
    await expect(f.session.clearSelection()).rejects.toThrow("adapter stop failed"); expect(f.session.connection()).toBeNull();
    expect(f.openCollection.mock.calls[0]![0].signal.aborted).toBe(true);
    await expect(f.session.select(collectionId)).rejects.toThrow("adapter stop failed"); expect(f.session.connection()).toBeNull();
    expect(f.openCollection).toHaveBeenCalledOnce(); expect(f.collectionRelease).not.toHaveBeenCalled(); expect(f.host.close).not.toHaveBeenCalled();
    await expect(f.session.close()).rejects.toThrow("adapter stop failed"); expect(f.installationRelease).not.toHaveBeenCalled(); expect(f.flow.close).not.toHaveBeenCalled();
  });
  it("quarantines a connection and aborts its collection signal before an in-flight close settles", async () => {
    const f = fixture("paired"); await f.session.start(); let finish!: () => void;
    f.closeConnection.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
    const observed: unknown[] = []; f.session.subscribe(() => {observed.push(f.session.connection());});
    const clearing = f.session.clearSelection(); await Promise.resolve(); await Promise.resolve();
    expect(f.session.connection()).toBeNull(); expect(f.openCollection.mock.calls[0]![0].signal.aborted).toBe(true); expect(f.collectionRelease).not.toHaveBeenCalled();
    finish(); await clearing; expect(observed).toEqual([null]); await f.session.close();
  });
  it("duplicate authorize while busy neither opens a second portal nor replaces the flow", async () => {
    const f = fixture(); await f.session.start(); const a = f.session.authorize();
    await expect(f.session.authorize()).rejects.toMatchObject({reason: "busy"}); await a; expect(f.openPortal).toHaveBeenCalledOnce(); expect(f.flowOpen).toHaveBeenCalledOnce(); await f.session.close();
  });
  it("unapproved collection IDs never reach the native/collection adapter", async () => {
    const f = fixture("paired", "never"); await f.session.start(); await expect(f.session.select(installation)).rejects.toMatchObject({reason: "refused"}); expect(f.openCollection).not.toHaveBeenCalled(); await f.session.close();
  });
});
