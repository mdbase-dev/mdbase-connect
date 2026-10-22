import {webcrypto} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {AppScopedSignInSession} from "../src/app-host/scoped-sign-in-session.js";
import {AppInstallationStore} from "../src/app-host/installation-store.js";
import {AppWebCloudCopyHost} from "../src/app-host/cloud-copy-host.js";
import type {AppWebSignInSessionOptions} from "../src/app-host/web-sign-in-session.js";
import type {AppWasmRuntime} from "../src/app-host/wasm-runtime.js";
import type {AppBundledReleaseTrust} from "../src/app-host/cloud-copy-bootstrap.js";
import * as ownership from "../src/app-host/owner.js";
import * as erasure from "../src/app-host/sign-out-erase.js";
import {signInLocks} from "./support/sign-in-locks.js";

// Real scoped facade, protected-flow state machine and browser lifecycle.
// Storage, CP transport and native host are explicit unit-test seams, not a
// claim of real CP transactions, native key delivery or live acceptance.
const A="11111111-1111-4111-8111-111111111111", B="22222222-2222-4222-8222-222222222222";
const target="33333333-3333-4333-8333-333333333333", sibling="44444444-4444-4444-8444-444444444444";
const appId="55555555-5555-4555-8555-555555555555", origin="https://notes.example.test", cpOrigin="https://cp.example.test";
const rootOwner="bundle:scoped-unit";
const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");
const release:AppBundledReleaseTrust={schema:"mdbn-app-trust/release/1",environment:"production",cpOrigin,logOrigin:"https://log.example.test",assetSha256:"11".repeat(32),source:{repository:"mdbase-dev/mdbase-connect",commit:"22".repeat(20),version:"test"},trustedRoots:[new Uint8Array(32).fill(3)],policyPins:Uint8Array.of(1)};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
async function fixture() {
  vi.useFakeTimers();vi.stubGlobal("crypto",webcrypto);vi.stubGlobal("location",{origin});
  const trace:string[]=[], ledgers=new Map<string,Uint8Array>(), parent=new AbortController(), locks=signInLocks();
  const legacyName=`mdbase-app-sign-in-v1-${appId}-${cpOrigin}`;
  const guardHeld=async()=>{
    expect(locks.held.has(legacyName)).toBe(true);
    expect(locks.events.filter(e=>e.name===legacyName&&e.kind==="release")).toHaveLength(0);
    await expect(ownership.acquireAppSignInLease(locks.port,{cpOrigin,appId})).rejects.toMatchObject({reason:"busy"});
  };
  const rootKeys={signPublicKey:new Uint8Array(32).fill(3),kemPublicKey:new Uint8Array(32).fill(4),noisePublicKey:new Uint8Array(32).fill(5)};
  const root={version:3,requestId:crypto.randomUUID(),installationId:crypto.randomUUID(),deviceId:crypto.randomUUID(),secret:`pair_${"r".repeat(43)}`,renewal:null,
    requestedCreateCollections:false,collectionIds:[target,sibling],createCollections:false,consentRequest:null,appId,kind:"app-runtime",owner:rootOwner,origin,cpOrigin,environment:"production",
    selection:{accountId:A,connectorId:crypto.randomUUID(),challenge:"ab".repeat(32),approvalMode:"password-ak1",accountEmail:"a@example.test",portalConfirmed:true},confirmed:true,nativeStarted:true,
    proof:{sign_pk:hex(rootKeys.signPublicKey),kem_pk:hex(rootKeys.kemPublicKey),noise_pk:hex(rootKeys.noisePublicKey),sig:"ab".repeat(64)},token:`idev_${"r".repeat(43)}`,
    collectionSelection:{requestId:"",selectedCollectionId:target,createdCollectionIds:[] as string[]}};
  root.collectionSelection.requestId=root.requestId;
  ledgers.set(rootOwner,new TextEncoder().encode(JSON.stringify(root)));
  const read=(owner=rootOwner)=>JSON.parse(new TextDecoder().decode(ledgers.get(owner)!));
  vi.spyOn(AppInstallationStore,"open").mockImplementation(async(p,initial)=>{
    const lease=await ownership.acquireAppSignInLease(p.locks,p,p.signal);
    try {
      const owner=p.owner!;let bytes=ledgers.get(owner);
      if(p.mode==="fresh"&&bytes)throw Error("existing fresh slot");
      if(!bytes){if(p.mode==="existing")throw Error("missing original slot");bytes=initial();ledgers.set(owner,bytes);trace.push(`new:${owner}`);}
      let current=true;
      const store={isCurrent:()=>current&&!p.signal.aborted,commit:async(value:Uint8Array)=>{if(!current||p.signal.aborted)throw Error("fenced");ledgers.set(owner,new Uint8Array(value));trace.push(`commit:${owner}`);},close:async()=>{if(current){current=false;trace.push(`close:${owner}`);await lease.release();}}};
      return {store:store as unknown as AppInstallationStore,plaintext:new Uint8Array(bytes)};
    } catch(error) {await lease.release();throw error;}
  });
  type InstallationRequest={request_id:string;installation_id:string;device_id:string;pairing_secret:string;recovery_collection_id:string;renewal?:Record<string,string>};
  type Row={request:InstallationRequest;account:string|null;connector:string;proof:Record<string,string>|null;token:string};
  const rows=new Map<string,Row>(), starts:InstallationRequest[]=[], requests:{path:string;body:unknown}[]=[];
  let portalAccount=B, failure:"none"|"429"|"unknown"="none", eraseFailure=false,partialErase=false;
  const respond=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers});
  const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
    requests.push({path,body});trace.push(`http:${path}`);
    if(path==="/v1/pairing-requests"){
      const r=body.installation as InstallationRequest;starts.push({...r});
      if(failure==="429")return respond({error:{code:"rate_limited",message:"limited"}},429,{"retry-after":"30"});
      if(!rows.has(r.request_id)){
        // Match CP's ALL-prior-IDs rule. A new window on either old ID cannot
        // make this test pass; renewed wrong-account windows are not used.
        if([...rows.values()].some(old=>old.request.installation_id===r.installation_id||old.request.device_id===r.device_id))return respond({error:{code:"installation_original_window_required",message:"original window required"}},409);
        rows.set(r.request_id,{request:r,account:null,connector:crypto.randomUUID(),proof:null,token:`idev_${String.fromCharCode(97+rows.size).repeat(43)}`});
      }
      if(failure==="unknown")throw Error("lost START response");
      return respond({pairing_id:r.request_id,pairing_secret:r.pairing_secret,verification_uri:`${cpOrigin}/pair/${r.request_id}`,expires_in:600,installation_device:true,app_id:appId,app_origin:origin,app_name:"Scoped notes",recovery_collection_id:r.recovery_collection_id},201);
    }
    if(path==="/v1/next/collections"){
      const token=(init?.headers as Record<string,string>).authorization;
      const ids=token===`Bearer ${root.token}`?[sibling]:[target];
      return respond({collections:ids.map(id=>({collection_id:id,display_name:id===target?"Target":"Sibling",role:"owner"}))});
    }
    const id=path.split("/")[3]!,row=rows.get(id)!;
    if(path.endsWith("/attest")){row.proof=body;trace.push(`attest:${row.account}`);return respond({ok:true});}
    if(!row.account)return respond({status:"pending"},202);
    const selected={request_id:id,account_id:row.account,connector_id:row.connector,device_id:row.request.device_id,installation_id:row.request.installation_id,kind:"app-runtime",challenge:"ab".repeat(32),approval_mode:"password-ak1",app_id:appId,app_origin:origin,expires_at:Date.now()+600000,account_email:row.account===A?"a@example.test":"b@example.test",account_selection_confirmed:true,recovery_collection_id:target};
    if(!row.proof)return respond({status:"account_selected",...selected},202);
    return respond({status:"paired",...selected,connector:{id:row.connector,name:"Scoped notes"},token:row.token,registration:{device_id:row.request.device_id,sign_pk:row.proof.sign_pk,kem_pk:row.proof.kem_pk,noise_pk:row.proof.noise_pk},collection_ids:[target],create_collections:false,selected_collection_id:target,created_collection_ids:[]});
  });
  const windows:{closed:boolean;navigate:ReturnType<typeof vi.fn>;close:ReturnType<typeof vi.fn>}[]=[];
  const openPortal=vi.fn(()=>{
    const window={closed:false,navigate:vi.fn((uri:string)=>{const id=new URL(uri).pathname.split("/")[2]!;rows.get(id)!.account=portalAccount;trace.push(`portal:${portalAccount}`);}),close:vi.fn(()=>{window.closed=true;trace.push("window-close");})};windows.push(window);return window;
  });
  vi.spyOn(ownership,"acquireAppInstallationLease").mockImplementation(async()=>({release:vi.fn(async()=>{})}));
  vi.spyOn(ownership,"acquireAppReplicaLease").mockImplementation(async()=>({release:vi.fn(async()=>{})}));
  const hostOpen=vi.spyOn(AppWebCloudCopyHost,"openInstallationDevice").mockImplementation(async p=>{
    const flow=p.signIn!,view=flow.view();trace.push(`native:${view.installationId}`);
    const keys=view.installationId===root.installationId?rootKeys:{signPublicKey:crypto.getRandomValues(new Uint8Array(32)),kemPublicKey:crypto.getRandomValues(new Uint8Array(32)),noisePublicKey:crypto.getRandomValues(new Uint8Array(32))};
    const custody={...keys,envelope:new Uint8Array([1])},runtime={deviceCustodyCurrent:()=>p.installation.isCurrent(),signCpEnrol:()=>({...keys,signature:new Uint8Array(64).fill(8)}),acknowledgeDeviceRegistration:()=>{trace.push(`ack:${view.installationId}`);}} as unknown as AppWasmRuntime;
    const persistence={pending:vi.fn(async()=>{}),registered:vi.fn(async()=>{})};
    if(view.state!=="paired")await flow.prepareOriginalDevice(p.installation);
    return {attestInstallation:()=>flow.attest({runtime,custody,persistence,installation:p.installation}),completeInstallationSignIn:()=>flow.acknowledge({runtime,custody,persistence,installation:p.installation}),close:async()=>{trace.push(`host-close:${view.installationId}`);}} as unknown as AppWebCloudCopyHost;
  });
  const erase=vi.spyOn(erasure,"eraseAppInstallationData").mockImplementation(async p=>{
    trace.push(`erase:${p.owner}`);expect(p.isolated).toBe(true);
    if(eraseFailure)return {ledger:false,complete:false};ledgers.delete(p.owner!);return {ledger:true,complete:!partialErase};
  });
  vi.spyOn(erasure,"eraseAppCollectionAccess").mockResolvedValue(true);
  const openCollection=vi.fn(async (p:Parameters<AppWebSignInSessionOptions<{id:string;isCurrent():boolean}>["openCollection"]>[0])=>({state:"ready" as const,connection:{id:p.scope.collection,isCurrent:()=>!p.signal.aborted},close:async()=>{}}));
  const sessionOptions:AppWebSignInSessionOptions<{id:string;isCurrent():boolean}>={appId,appName:"Scoped notes",origin,cpOrigin,environment:"production",release,owner:rootOwner,signal:parent.signal,fetch:fetcher,locks:locks.port,autoSelect:"never",loadRuntime:async()=>new Uint8Array([1]),openPortal,openCollection};
  const session=new AppScopedSignInSession(sessionOptions);
  await session.start();
  return {session,parent,read,ledgers,root,rows,starts,requests,trace,windows,hostOpen,erase,openCollection,fetcher,guardHeld,locks,options:sessionOptions,setAccount:(value:string)=>{portalAccount=value;},setFailure:(value:typeof failure)=>{failure=value;},failErase:()=>{eraseFailure=true;},failPartialErase:()=>{partialErase=true;}};
}
describe("composed scoped browser recovery",()=>{
  it("definite wrong B stops before authority, then an explicit gesture completes A on BOTH fresh IDs",async()=>{
    const f=await fixture();await f.session.openCollection(sibling);const heldSibling=f.session.connection(sibling),rootBefore=f.read(),hostCount=f.hostOpen.mock.calls.length;
    await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({reason:"recovery_account_mismatch"});
    const first=f.starts[0]!,firstRef=f.read().collectionRecoveries[target],oldOwner=`${rootOwner}:scope:${firstRef}`,old=f.read(oldOwner);
    expect(old).toMatchObject({selection:null,confirmed:false,nativeStarted:false,proof:null,token:null});
    expect(f.hostOpen).toHaveBeenCalledTimes(hostCount);expect(f.requests.some(r=>r.path.endsWith("/attest"))).toBe(false);
    expect(f.session.getSnapshot()).toMatchObject({problem:"recovery_account_mismatch",recoveryAccountLabel:"a@example.test"});
    await f.guardHeld();
    f.setAccount(A);await f.session.authorize({collectionHint:target});await vi.advanceTimersByTimeAsync(1000);
    const next=f.starts[1]!,newRef=f.read().collectionRecoveries[target];
    expect(newRef).not.toBe(firstRef);expect(next.installation_id).not.toBe(first.installation_id);expect(next.device_id).not.toBe(first.device_id);expect(next).not.toHaveProperty("renewal");
    expect(f.windows[0]!.closed).toBe(true);expect(f.ledgers.has(oldOwner)).toBe(false);
    await f.guardHeld();
    expect(f.rows.get(first.request_id)).toMatchObject({account:B,proof:null}); // abandoned CP row is not reset or revived
    const completed=f.read(`${rootOwner}:scope:${newRef}`);expect(completed).toMatchObject({selection:{accountId:A},confirmed:true,nativeStarted:true,collectionIds:[target]});expect(completed.token).toMatch(/^idev_/);
    expect(f.trace.indexOf(`close:${oldOwner}`)).toBeLessThan(f.trace.indexOf(`new:${rootOwner}:scope:${newRef}`));
    const rootAfter=f.read(),rootExpected={...rootBefore};delete rootAfter.collectionRecoveries;delete rootAfter.collectionListing;delete rootExpected.collectionListing;expect(rootAfter).toEqual(rootExpected);
    await f.session.openCollection(target);expect(f.session.connection(target)?.isCurrent()).toBe(true);
    expect(f.session.connection(sibling)).toBe(heldSibling);expect(heldSibling?.isCurrent()).toBe(true);await f.session.close();
  });
  it("restore selects only the original completed child ledger; a missing child fails closed without allocating another actor",async()=>{
    const f=await fixture();f.setAccount(A);await f.session.authorize({collectionHint:target});await vi.advanceTimersByTimeAsync(1000);
    const ref=f.read().collectionRecoveries[target],owner=`${rootOwner}:scope:${ref}`,completed=f.read(owner),starts=f.starts.length;
    await f.session.close();const resumed=new AppScopedSignInSession(f.options);await resumed.start();
    expect(f.read(owner)).toEqual(completed);expect(f.starts).toHaveLength(starts);await resumed.openCollection(target);expect(resumed.connection(target)?.isCurrent()).toBe(true);await resumed.close();
    f.ledgers.delete(owner);const missing=new AppScopedSignInSession(f.options);await missing.start();
    expect(f.starts).toHaveLength(starts);expect(f.ledgers.has(owner)).toBe(false);expect(missing.connection(target)).toBeNull();
    await expect(missing.authorize({collectionHint:target})).rejects.toBeDefined();expect(f.read().collectionRecoveries[target]).toBe(ref);await missing.close();
  });
  it("aggregate sign-out cannot report success when a child ledger could not be erased",async()=>{
    const f=await fixture();await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({reason:"recovery_account_mismatch"});
    f.failPartialErase();await expect(f.session.signOut()).rejects.toMatchObject({reason:"recovery_required"});
    expect(f.ledgers.has(rootOwner)).toBe(true);expect(f.session.getSnapshot().signOutResult?.local).not.toBe("erased");await f.session.close();
  });
  it("unknown START repeats the SAME slot, installation/device and request instead of allocating another actor",async()=>{
    const f=await fixture();f.setFailure("unknown");await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({reason:"outcome_unknown"});
    const first=f.starts[0]!,ref=f.read().collectionRecoveries[target];await f.guardHeld();
    f.setFailure("none");f.setAccount(A);await f.session.authorize({collectionHint:target});await vi.advanceTimersByTimeAsync(1000);
    expect(f.starts[1]).toEqual(first);expect(f.read().collectionRecoveries[target]).toBe(ref);expect(f.erase).not.toHaveBeenCalled();await f.session.close();
  });
  it("429 retains the fresh attempt, closes its window and honours backoff without any automatic slot loop",async()=>{
    const f=await fixture();await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({reason:"recovery_account_mismatch"});
    f.setAccount(A);f.setFailure("429");await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({server:{status:429}});
    const ref=f.read().collectionRecoveries[target],attempt=f.starts[1]!,windows=f.windows.length;
    expect(f.windows.at(-1)!.closed).toBe(true);
    await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({server:{status:429}});
    expect(f.starts).toHaveLength(2);expect(f.windows).toHaveLength(windows);expect(f.read().collectionRecoveries[target]).toBe(ref);
    await vi.advanceTimersByTimeAsync(31_000);expect(f.starts).toHaveLength(2);
    f.setFailure("none");await f.session.authorize({collectionHint:target});await vi.advanceTimersByTimeAsync(1000);
    expect(f.starts[2]).toEqual(attempt);expect(f.read().collectionRecoveries[target]).toBe(ref);
    expect(f.read(`${rootOwner}:scope:${ref}`).token).toMatch(/^idev_/);await f.session.close();
  });
  it("closing during a held late receipt cannot ACK, publish Ready or allocate another slot",async()=>{
    const f=await fixture();f.setAccount(A);await f.session.authorize({collectionHint:target});
    const ref=f.read().collectionRecoveries[target],attempt=f.starts[0]!,owner=`${rootOwner}:scope:${ref}`,tokenBefore=f.read(owner).token;
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
    const request=f.requests.find(r=>r.path.endsWith("/attest"))!;expect(request).toBeDefined();
    // The next poll reaches the same flow's original fetch, then holds the
    // receipt delivery while the composed owner closes.
    const fetcher=f.fetcher,ordinary=fetcher.getMockImplementation()!;
    fetcher.mockImplementationOnce(async(input,init)=>{const result=await ordinary(input,init);await held;return result;});
    const published:string[]=[];f.session.subscribe(()=>published.push(f.session.getSnapshot().status));
    const tick=vi.advanceTimersByTimeAsync(1000);await vi.waitFor(()=>expect(fetcher.mock.calls.at(-1)?.[0]).toContain(`${attempt.request_id}/exchange`));
    const closed=f.session.close();release();await tick;await closed;
    expect(f.trace).not.toContain(`ack:${attempt.installation_id}`);expect(published).not.toContain("ready");expect(f.starts).toHaveLength(1);
    expect(f.session.connection(target)).toBeNull();expect(tokenBefore).toBeNull();
  });
  it("failed isolated cleanup quarantines the old slot and never allocates new IDs",async()=>{
    const f=await fixture();await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({reason:"recovery_account_mismatch"});
    const ref=f.read().collectionRecoveries[target];f.failErase();f.setAccount(A);
    await expect(f.session.authorize({collectionHint:target})).rejects.toBeDefined();
    expect(f.starts).toHaveLength(1);expect(f.read().collectionRecoveries[target]).toBe(ref);
    await expect(f.session.authorize({collectionHint:target})).rejects.toMatchObject({reason:"recovery_required"});await f.guardHeld();await f.session.close();
  });
});
