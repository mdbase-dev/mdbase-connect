import { afterEach, describe, expect, it, vi } from "vitest";
import { AppWebSignInSession } from "../src/app-host/web-sign-in-session.js";
import { AppProtectedInstallationSignIn, AppInstallationSignInError, type AppInstallationSignInView } from "../src/app-host/installation-sign-in.js";
import { AppCollectionSetupError } from "../src/app-host/collection-setup-journal.js";
import { AppCloudCopyHostError } from "../src/app-host/cloud-copy-host.js";
import { MdbaseError } from "../src/errors.js";
import { AppWebCloudCopyHost } from "../src/app-host/cloud-copy-host.js";
import * as ownership from "../src/app-host/owner.js";
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
    listApprovedCollections: vi.fn(async () => [{collectionId, displayName: "My notes", role: "owner" as const}]),
    renewExpiredPairing: vi.fn(async () => {state = "pending"; return view();}),
    close: vi.fn(async () => {trace.push("flow-close");}),
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
  const openPortal = vi.fn(() => {trace.push("open-portal"); return {navigate: navigatePortal, close: closePortal};});
  const options = {appId: "independent-app", appName: "Independent App", origin: "https://notes.example.test", cpOrigin: release.cpOrigin, environment: "production" as const, release, signal: parent.signal, locks: undefined, loadRuntime: async () => Uint8Array.of(1), openPortal, openCollection, autoSelect};
  const session = new AppWebSignInSession(options);
  return {session, options, flow, host, flowOpen, hostOpen, parent, trace, openPortal, navigatePortal, closePortal, openCollection, connection, closeConnection, installationRelease, collectionRelease, selectOnPortal: () => {selectedOnPortal = true;}, approve: (created = false) => {approved = true; newlyCreated = created;}, approveConsent: (confirmed = true) => {consentDone = true; consentConfirmed = confirmed;}, flowSignal: () => flowSignal};
}
describe("shared first-party web sign-in", () => {
  it("offers same-approved-collection Retry only after clean stop of exhausted pre-enrollment challenge work",async()=>{
    const f=fixture("paired","never"); await f.session.start();
    const error=Object.assign(new AppCloudCopyBootstrapError("unavailable"),{retryable:true}); f.openCollection.mockRejectedValueOnce(error);
    await expect(f.session.select(collectionId)).rejects.toBe(error);
    expect(f.session.snapshot()).toMatchObject({status:"unselected",problem:"unavailable",selectedCollectionId:collectionId});
    expect(f.session.connection()).toBeNull(); expect(f.host.close).toHaveBeenCalledOnce(); expect(f.collectionRelease).toHaveBeenCalledOnce();
    expect(f.trace.indexOf("host-close")).toBeLessThan(f.trace.indexOf("collection-release")); expect(f.installationRelease).not.toHaveBeenCalled();
    const receipt=f.flow.view().requestId; await f.session.select(collectionId); expect(f.session.snapshot().status).toBe("ready");
    expect(f.flow.view().requestId).toBe(receipt); expect(f.flowOpen).toHaveBeenCalledOnce(); expect(f.flow.start).toHaveBeenCalledOnce(); expect(f.flow.renewExpiredPairing).not.toHaveBeenCalled(); await f.session.close();
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
  it("starts a protected request but never opens account custody or polls before user sign-in", async () => {
    vi.useFakeTimers(); const f = fixture(), listener = vi.fn(); const stop = f.session.subscribe(listener);
    expect(f.session.getSnapshot().status).toBe("not_started"); await f.session.start();
    expect(f.session.snapshot().status).toBe("signed_out"); await vi.advanceTimersByTimeAsync(20000);
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
    expect(f.flow.view().requestId).toBe(originalRequest); expect(f.flow.start).toHaveBeenCalledTimes(2);
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
    expect(f.flow.exchange).toHaveBeenCalledTimes(2); expect(f.flowOpen).toHaveBeenCalledOnce(); expect(f.flow.start).toHaveBeenCalledTimes(2); expect(f.hostOpen).not.toHaveBeenCalled(); await f.session.close();
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
    expect(b.f.flow.start).toHaveBeenCalledTimes(kind === "pair" ? 2 : 1);
    expect(b.f.host.attestInstallation).not.toHaveBeenCalled(); expect(b.f.openCollection).not.toHaveBeenCalled();
    if (kind === "pair") expect(b.f.hostOpen).not.toHaveBeenCalled();
    await b.f.session.close(); expect(vi.getTimerCount()).toBe(0);
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
