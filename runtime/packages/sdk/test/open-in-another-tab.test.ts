// Stopgap until multi-tab attach: a second tab of the same app gets a typed
// `open_in_another_tab` (with copy), and can wait for the first tab's release.
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppInstallationSignInError, AppProtectedInstallationSignIn } from "../src/app-host/installation-sign-in.js";
import { AppInstallationStorageError, AppInstallationStore } from "../src/app-host/installation-store.js";
import { AppReplicaOwnerError, acquireAppInstallationLease, acquireAppSignInLease, createAppSignInRootGuard, waitForAppSignInRelease } from "../src/app-host/owner.js";
import { webSignInProblem } from "../src/app-host/web-sign-in-problem.js";
import { applicationWorkerProblem } from "../src/application/worker-protocol.js";
import { describeError } from "../src/describe-error.js";
import {signInLocks as locks} from "./support/sign-in-locks.js";

const origin = "https://notes.example.test", cpOrigin = "https://cp.example.test", appId = "44444444-4444-4444-8444-444444444444";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("open in another tab", () => {
  it("a held sign-in slot is a typed open_in_another_tab, not a generic busy", async () => {
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("location", { origin });
    vi.spyOn(AppInstallationStore, "open").mockRejectedValue(new AppInstallationStorageError("busy"));
    await expect(AppProtectedInstallationSignIn.open({ origin, cpOrigin, appId, appName: "Notes", environment: "lab", mode: "open", signal: new AbortController().signal, locks: undefined }))
      .rejects.toMatchObject({ reason: "open_in_another_tab" });
  });
  it("maps to the problem, crosses the Worker boundary and has plain transient copy", () => {
    for (const error of [new AppInstallationSignInError("open_in_another_tab"), new AppReplicaOwnerError("busy")])
      expect(webSignInProblem(error).problem).toBe("open_in_another_tab");
    expect(applicationWorkerProblem(new AppInstallationSignInError("open_in_another_tab"))).toEqual({ code: "open_in_another_tab" });
    const copy = describeError("open_in_another_tab")!;
    expect(copy).toMatchObject({ key: "open_in_another_tab", title: "Open in another tab", transient: true, severity: "info" });
    expect(copy.message).toMatch(/another tab/);
  });
  it("waits for the owning tab's release on the same lock, never owning it", async () => {
    const { port, names, waiting } = locks();
    const owner = await acquireAppSignInLease(port, { cpOrigin, appId });
    await expect(acquireAppSignInLease(port, { cpOrigin, appId })).rejects.toMatchObject({ reason: "busy" });
    let released = false;
    const wait = waitForAppSignInRelease(port, { cpOrigin, appId }, new AbortController().signal).then(() => { released = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(released).toBe(false); expect(waiting.size).toBe(1);
    await owner.release(); await wait;
    expect(released).toBe(true);
    expect(new Set(names.map(n => n.split(":").slice(1).join(":"))).size).toBe(1);
    expect(names.some(n => n.startsWith("shared:"))).toBe(true);
    // The wait took nothing: the next tab acquires normally.
    await (await acquireAppSignInLease(port, { cpOrigin, appId })).release();
  });
  it("an older OWNED v1 root blocks both a new raw owned root and a guarded facade root from the same protected ledger", async () => {
    const key=await webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
    vi.stubGlobal("crypto",webcrypto);vi.stubGlobal("CryptoKey",key.constructor);
    vi.stubGlobal("location",{origin});vi.stubGlobal("indexedDB",new IDBFactory());
    const {port}=locks(), signal=new AbortController().signal;
    const scope={origin,cpOrigin,appId,owner:"bundle:dev.example.notes",signal,locks:port,mode:"existing" as const};
    const initial=await AppInstallationStore.open({...scope,mode:"fresh"},()=>Uint8Array.of(1));await initial.store.close();
    // Older builds ignored owner ONLY for the lease, not for this encrypted DB.
    const old=await acquireAppSignInLease(port,{cpOrigin,appId});
    const guard=createAppSignInRootGuard(port,{cpOrigin,appId},signal);
    const unexpected:AppInstallationStore[]=[];
    const open=async(guarded=false)=>{const result=await AppInstallationStore.open({...scope,locks:guarded?guard.locks:port},()=>Uint8Array.of(9));unexpected.push(result.store);return result;};
    try {
      await expect(open()).rejects.toMatchObject({reason:"busy"});
      await expect(open(true)).rejects.toMatchObject({reason:"busy"});
    } finally {for(const store of unexpected)await store.close();await old.release();}
    // The same facade can retry after old-root release; no cached busy fence.
    const restored=await open(true);expect(restored.plaintext).toEqual(Uint8Array.of(1));
    await restored.store.close();await guard.close();
  });
  it("root and scoped protected stores own separate leases while tabs wait for the root guard", async () => {
    const key=await webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("CryptoKey", key.constructor);
    vi.stubGlobal("location", { origin }); vi.stubGlobal("indexedDB", new IDBFactory());
    const {port,names,waiting}=locks(), signal=new AbortController().signal;
    const guard=createAppSignInRootGuard(port,{cpOrigin,appId},signal);
    const rootScope={origin,cpOrigin,appId,owner:"bundle:dev.example.notes",mode:"fresh" as const,signal,locks:guard.locks};
    const childScope={...rootScope,owner:`${rootScope.owner}:scope:original-reference`};
    const root=await AppInstallationStore.open(rootScope,()=>Uint8Array.of(1));
    let child:Awaited<ReturnType<typeof AppInstallationStore.open>>|undefined;
    let released=false,wait:Promise<void>|undefined;
    try {
      child=await AppInstallationStore.open(childScope,()=>Uint8Array.of(2));
      expect(root.store.isCurrent()).toBe(true); expect(child.store.isCurrent()).toBe(true);
      await expect(AppInstallationStore.open({...rootScope,mode:"existing"},()=>Uint8Array.of(9))).rejects.toMatchObject({reason:"busy"});
      await expect(AppInstallationStore.open({...childScope,mode:"existing"},()=>Uint8Array.of(9))).rejects.toMatchObject({reason:"busy"});
      const rootName=`mdbase-app-sign-in-v1-${appId}-${cpOrigin}`;
      wait=waitForAppSignInRelease(port,{cpOrigin,appId},signal).then(()=>{released=true;});
      await Promise.resolve();await Promise.resolve();
      expect(released).toBe(false);expect(waiting.has(rootName)).toBe(true);
      await child.store.close();
      expect(released).toBe(false);expect(root.store.isCurrent()).toBe(true);
      await expect(AppInstallationStore.open({...rootScope,mode:"existing"},()=>Uint8Array.of(9))).rejects.toMatchObject({reason:"busy"});
      const restored=await AppInstallationStore.open({...childScope,mode:"existing"},()=>Uint8Array.of(9));
      expect(restored.plaintext).toEqual(Uint8Array.of(2));await restored.store.close();
      // The root facade guard outlives any individual store (e.g. sign-out).
      await root.store.close();
      await expect(acquireAppSignInLease(port,{cpOrigin,appId})).rejects.toMatchObject({reason:"busy"});
    } finally {await child?.store.close();await root.store.close();await guard.close();}
    await wait;expect(released).toBe(true);
    const legacy=await acquireAppSignInLease(port,{cpOrigin,appId});
    expect(names.at(-1)).toBe(`exclusive:mdbase-app-sign-in-v1-${appId}-${cpOrigin}`);
    await legacy.release();
  });
  it("a failed borrower drain retains real v1 and a closed guard cannot lend another lease", async () => {
    const {port}=locks(), signal=new AbortController().signal, scope={cpOrigin,appId,owner:"bundle:root"};
    const guard=createAppSignInRootGuard(port,scope,signal);
    const storeLease=await acquireAppSignInLease(guard.locks,scope);
    await expect(guard.close()).rejects.toMatchObject({reason:"shutdown_failed"});
    await expect(acquireAppSignInLease(port,{cpOrigin,appId})).rejects.toMatchObject({reason:"busy"});
    await expect(acquireAppSignInLease(guard.locks,{...scope,owner:"bundle:child"})).rejects.toMatchObject({reason:"unavailable"});
    await storeLease.release();await guard.close();
    await (await acquireAppSignInLease(port,{cpOrigin,appId})).release();
  });
  it("forwards native installation custody to the real locks without weakening exclusion", async () => {
    const {port,held}=locks(), signal=new AbortController().signal, scope={cpOrigin,appId,owner:"bundle:root"};
    const guard=createAppSignInRootGuard(port,scope,signal), storeLease=await acquireAppSignInLease(guard.locks,scope);
    const nativeScope={account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222"};
    const native=await acquireAppInstallationLease(guard.locks,nativeScope);
    try {
      expect(held.has(`mdbase-app-installation-${nativeScope.account}-${nativeScope.installation}`)).toBe(true);
      await expect(acquireAppInstallationLease(port,nativeScope)).rejects.toMatchObject({reason:"busy"});
    } finally {await native.release();await storeLease.release();await guard.close();}
  });
  it("stops waiting when the app closes", async () => {
    const { port } = locks();
    const owner = await acquireAppSignInLease(port, { cpOrigin, appId }), stop = new AbortController();
    const wait = waitForAppSignInRelease(port, { cpOrigin, appId }, stop.signal);
    stop.abort(new Error("closed"));
    await expect(wait).rejects.toThrow("closed");
    await owner.release();
    await expect(waitForAppSignInRelease(port, { cpOrigin: "https://cp.example.test/x", appId }, stop.signal)).rejects.toMatchObject({ reason: "invalid_scope" });
  });
});
