import {webcrypto} from "node:crypto";
import {IDBFactory} from "fake-indexeddb";
import {afterEach,expect,it,vi} from "vitest";
import {AppInstallationStore} from "../src/app-host/installation-store.js";
import {AppProtectedInstallationSignIn} from "../src/app-host/installation-sign-in.js";
import {AppIndexedDbDeviceKeyProvider} from "../src/app-host/device-key-provider.js";
import {AppIndexedDbDeviceKeyProtectedStore} from "../src/app-host/device-key-idb.js";
import {AppIndexedDbNoiseProtectedStore} from "../src/app-host/noise-idb.js";
import {AppIndexedDbCloudCopyOutcomeStore} from "../src/app-host/cloud-copy-persistence-idb.js";
import {AppIndexedDbPrivateBootstrapStore} from "../src/app-host/private-persistence-idb.js";
import {AppWebSignInSession} from "../src/app-host/web-sign-in-session.js";
import {selectAppEnvironment} from "../src/app-host/app-environment.js";
import type {AppLockPort} from "../src/app-host/owner.js";
import type {AppBundledReleaseTrust} from "../src/app-host/cloud-copy-bootstrap.js";

const origin="http://127.0.0.1:49152",cpOrigin="https://cp.test",logOrigin="https://log.test";
const appId="55555555-5555-4555-8555-555555555555";
const source={accountId:"11111111-1111-4111-8111-111111111111",connectorId:"22222222-2222-4222-8222-222222222222",
  deviceId:"33333333-3333-4333-8333-333333333333",installationId:"44444444-4444-4444-8444-444444444444",
  collection:"66666666-6666-4666-8666-666666666666",purpose:"create" as const,approvalMode:"password-ak1" as const,
  cpOrigin,logOrigin,assetSha256:"a".repeat(64),rootPublicKey:new Uint8Array(32).fill(1),
  isCurrent:()=>true,installationOwned:()=>true,connectorBearer:async()=>"unused"};
const release:AppBundledReleaseTrust={schema:"mdbn-app-trust/release/1",environment:"production",cpOrigin,logOrigin,
  assetSha256:source.assetSha256,source:{repository:"mdbase-dev/mdbase-connect",commit:"b".repeat(40),version:"test.1"},
  trustedRoots:[source.rootPublicKey],policyPins:Uint8Array.of(1)};
const locks:AppLockPort={request:async(_name,_options,hold)=>{await hold({});}};
async function browser(appOrigin=origin){
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("crypto",webcrypto);vi.stubGlobal("location",{origin:appOrigin});
  const key=await webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  vi.stubGlobal("CryptoKey",key.constructor);
}
const options=(appOrigin=origin)=>({origin:appOrigin,source,mode:"fresh" as const,signal:new AbortController().signal});
const stores=[
  ["installation",async(p:ReturnType<typeof options>&{allowLoopbackHttp?:boolean;allowNativeLoopbackHttp?:boolean})=>(await AppInstallationStore.open({...p,appId,cpOrigin,locks},()=>Uint8Array.of(1))).store],
  ["device KEK",AppIndexedDbDeviceKeyProvider.open.bind(AppIndexedDbDeviceKeyProvider)],
  ["device keys",AppIndexedDbDeviceKeyProtectedStore.open.bind(AppIndexedDbDeviceKeyProtectedStore)],
  ["Noise",AppIndexedDbNoiseProtectedStore.open.bind(AppIndexedDbNoiseProtectedStore)],
  ["cloud outcome",AppIndexedDbCloudCopyOutcomeStore.open.bind(AppIndexedDbCloudCopyOutcomeStore)],
  ["private outcome",AppIndexedDbPrivateBootstrapStore.open.bind(AppIndexedDbPrivateBootstrapStore)],
] as const;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it.each(stores)("%s storage admits native IPv4 without the LAB flag",async(_name,open)=>{
  await browser();const p=options();
  await expect(open(p)).rejects.toBeDefined();
  const store=await open({...p,allowNativeLoopbackHttp:true});await store.close();
});
it.each(stores)("%s storage refuses other native HTTP hosts before IDB",async(_name,open)=>{
  for(const other of ["http://localhost:49152","http://[::1]:49152","http://127.0.0.2:49152","http://127.1:49152","http://evil.test:49152"]){
    await browser(other);const spy=vi.spyOn(indexedDB,"open");
    await expect(open({...options(other),allowNativeLoopbackHttp:true})).rejects.toBeDefined();expect(spy).not.toHaveBeenCalled();
  }
});
it.each(stores)("%s storage keeps explicit LAB localhost and IPv6 support",async(_name,open)=>{
  for(const other of ["http://localhost:49152","http://[::1]:49152"]){
    await browser(other);const store=await open({...options(other),allowLoopbackHttp:true});await store.close();
  }
});
it("native storage permission does not permit HTTP control-plane origins",async()=>{
  await browser();const spy=vi.spyOn(indexedDB,"open");
  await expect(AppInstallationStore.open({...options(),cpOrigin:origin,appId,locks,allowNativeLoopbackHttp:true},()=>Uint8Array.of(1))).rejects.toBeDefined();
  expect(spy).not.toHaveBeenCalled();
});
it("native selection cannot enable the LAB flag or use a copied selection",async()=>{
  await browser();const spy=vi.spyOn(indexedDB,"open");
  const selection=selectAppEnvironment({environment:"production",appOrigin:origin,platform:"native",release});
  const p={origin,cpOrigin,appId,appName:"Notes",environment:"production" as const,mode:"fresh" as const,signal:new AbortController().signal,locks,
    allowNativeLoopbackHttp:true,environmentSelection:selection};
  await expect(AppProtectedInstallationSignIn.open({...p,allowLoopbackHttp:true})).rejects.toThrow("binding");
  await expect(AppProtectedInstallationSignIn.open({...p,environmentSelection:{...selection}})).rejects.toThrow("binding");
  expect(spy).not.toHaveBeenCalled();
});
it("native session opens and restores the original ledger without network or LAB trust",async()=>{
  await browser();const fetch=vi.fn<typeof globalThis.fetch>();
  const p={origin,cpOrigin,appId,appName:"Notes",environment:"production" as const,release,signal:new AbortController().signal,locks,
    allowNativeLoopbackHttp:true,loadRuntime:vi.fn(),openPortal:vi.fn(),openCollection:vi.fn(),fetch};
  const session=new AppWebSignInSession(p),first=await session.start();expect(first.status).toBe("signed_out");await session.close();
  const restored=new AppWebSignInSession(p);expect((await restored.start()).signIn).toEqual(first.signIn);await restored.close();
  expect(fetch).not.toHaveBeenCalled();expect(p.loadRuntime).not.toHaveBeenCalled();
  for(const field of ["cpOrigin","logOrigin"])
    expect(()=>selectAppEnvironment({environment:"production",appOrigin:origin,platform:"native",release:{...release,[field]:origin}})).toThrow();
  expect(()=>new AppWebSignInSession({...p,environment:"test" as never,release:{...release,environment:"test"}})).toThrow();
});
