import {webcrypto} from "node:crypto";
import {IDBFactory} from "fake-indexeddb";
import {afterEach,expect,it,vi} from "vitest";
import {applicationDeclaration,rebindApplicationDeclaration} from "../src/application/declaration.js";
import {applicationStorageNamespace,applicationStorageOwner} from "../src/application/storage-scope.js";
import {AppProtectedInstallationSignIn} from "../src/app-host/installation-sign-in.js";
import {acquireAppSignInLease,AppReplicaOwnerError,createAppSignInRootGuard,type AppLockPort} from "../src/app-host/owner.js";
import {eraseAppInstallationData} from "../src/app-host/sign-out-erase.js";
import {idbLogTokenCache,LOG_TOKEN_DATABASE} from "../src/app-host/log-token-cache.js";
import {appPoolNames} from "../src/app-storage/app-sqlite-index.js";

const appId="55555555-5555-4555-8555-555555555555",origin="https://app.test",cpOrigin="https://cp.test",manifestId="org.example.notes";
const account="11111111-1111-4111-8111-111111111111",connector="22222222-2222-4222-8222-222222222222",collection="33333333-3333-4333-8333-333333333333";
const declaration=(namespace?:string)=>applicationDeclaration({id:appId,name:"Notes",origin,environment:"production",manifest:{id:manifestId},...(namespace===undefined?{}:{storage:{applicationNamespace:namespace}})});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function browser(){
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("crypto",webcrypto);vi.stubGlobal("location",{origin});
  const key=await webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);vi.stubGlobal("CryptoKey",key.constructor);
  const held=new Set<string>(),names:string[]=[];
  const locks:AppLockPort={request:async(name,_options,hold)=>{names.push(name);if(held.has(name))return hold(null);held.add(name);try{await hold({});}finally{held.delete(name);}}};
  return {held,names,locks};
}

it("namespace roots open concurrently and keep sibling identity, tokens and replica data on erasure",async()=>{
  const b=await browser(),a=declaration("vault/a"),other=declaration("vault/b");
  const options=(d:ReturnType<typeof declaration>)=>({origin,cpOrigin,appId,appName:"Notes",environment:"production" as const,mode:"open" as const,owner:applicationStorageOwner(manifestId,applicationStorageNamespace(d)),storageNamespace:d.storage.applicationNamespace,signal:new AbortController().signal,locks:b.locks});
  const pa=options(a),pb=options(other),ga=createAppSignInRootGuard(b.locks,pa,pa.signal),gb=createAppSignInRootGuard(b.locks,pb,pb.signal);
  const fa=await AppProtectedInstallationSignIn.open({...pa,locks:ga.locks}),fb=await AppProtectedInstallationSignIn.open({...pb,locks:gb.locks});
  const {owner:_owner,storageNamespace:_namespace,...legacyOptions}=pa;
  const legacy=await AppProtectedInstallationSignIn.open(legacyOptions),legacyView=legacy.view();
  const va=fa.view(),vb=fb.view();expect(va.installationId).not.toBe(vb.installationId);expect(va.deviceId).not.toBe(vb.deviceId);
  await expect(AppProtectedInstallationSignIn.open(pa)).rejects.toBeDefined();
  const child=await AppProtectedInstallationSignIn.open({...pa,locks:ga.locks,owner:`${pa.owner}:scope:${crypto.randomUUID()}`});await child.close();
  expect(b.names.filter(name=>name===`mdbase-app-sign-in-v1-${appId}-${cpOrigin}`)).toHaveLength(1); // only the legacy slot
  const cache=idbLogTokenCache()!,now=Date.now(),token={value:"fixture-token",expires:now+120000};
  const tokenKey=(device:string,cp=cpOrigin,cid=connector,c=collection,log="https://log.test")=>[cp,log,cid,device,c].join(" ");
  const own=tokenKey(va.deviceId),sibling=tokenKey(vb.deviceId),otherCp=tokenKey(va.deviceId,"https://other-cp.test"),otherConnector=tokenKey(va.deviceId,cpOrigin,crypto.randomUUID()),oldCollection=tokenKey(va.deviceId,cpOrigin,connector,crypto.randomUUID(),"https://old-log.test");
  for(const key of [own,sibling,otherCp,otherConnector,oldCollection])await cache.write(key,token);
  const poolA=appPoolNames({account,installation:va.installationId,collection}),poolB=appPoolNames({account,installation:vb.installationId,collection});expect(poolA).not.toEqual(poolB);
  // Directory routing/erasure fixture; this test does not mount real OPFS.
  const replicas=new Map([[poolA.directory,"vault a data"],[poolB.directory,"vault b data"]]);
  vi.stubGlobal("navigator",{storage:{getDirectory:async()=>({keys:async function*(){yield* replicas.keys();},removeEntry:async(name:string)=>{replicas.delete(name);}})}});
  await fa.close();await ga.close();
  expect(await eraseAppInstallationData({...pa,accountId:account,connectorId:connector,deviceId:va.deviceId,installationId:va.installationId,collectionIds:[collection],databases:[a.storage.joinDatabaseName,a.storage.setupDatabaseName]})).toEqual({ledger:true,complete:true});
  expect(await cache.read(own,now)).toBeNull();expect(await cache.read(oldCollection,now)).toBeNull();
  for(const key of [sibling,otherCp,otherConnector])expect(await cache.read(key,now)).toEqual(token);
  expect(replicas.get(poolB.directory)).toBe("vault b data");expect(replicas.has(poolA.directory)).toBe(false);
  expect(fb.isCurrent()).toBe(true);expect(fb.view()).toEqual(vb);
  expect(legacy.isCurrent()).toBe(true);expect(legacy.view()).toEqual(legacyView);await legacy.close();
  await fb.close();await gb.close();
  const restored=await AppProtectedInstallationSignIn.open({...pb,mode:"existing"});expect(restored.view()).toEqual(vb);await restored.close();
  const fresh=await AppProtectedInstallationSignIn.open(pa);expect(fresh.view().installationId).not.toBe(va.installationId);await fresh.close();
  expect((await indexedDB.databases()).map(d=>d.name)).toEqual(expect.arrayContaining([LOG_TOKEN_DATABASE,`mdbase.app.installation.v1.${encodeURIComponent(cpOrigin)}.${appId}`]));
});

it.each([undefined,`bundle:${manifestId}`])("rejects a storage namespace with legacy owner %s before requesting locks",async(owner)=>{
  const b=await browser(),scope={cpOrigin,appId,storageNamespace:"vault-a",...(owner===undefined?{}:{owner})};
  expect(()=>acquireAppSignInLease(b.locks,scope)).toThrow(new AppReplicaOwnerError("invalid_scope"));
  await expect(AppProtectedInstallationSignIn.open({...scope,origin,appName:"Notes",environment:"production",mode:"open",signal:new AbortController().signal,locks:b.locks})).rejects.toBeDefined();
  expect(b.names).toEqual([]);expect(await indexedDB.databases()).toEqual([]);
});

it("no-override declaration, owner, database and locks retain their exact legacy names and identity",async()=>{
  const b=await browser(),d=declaration();
  expect(applicationStorageNamespace(d)).toBeNull();expect(applicationStorageOwner(manifestId,null)).toBe(`bundle:${manifestId}`);
  expect(d.storage).toEqual({applicationNamespace:appId,joinDatabaseName:`mdbase.${appId}.native-collection-join.v1`,setupDatabaseName:`mdbase.${appId}.native-model-setup.v1`});
  const p={origin,cpOrigin,appId,appName:"Notes",environment:"production" as const,mode:"open" as const,owner:`bundle:${manifestId}`,signal:new AbortController().signal,locks:b.locks};
  const f=await AppProtectedInstallationSignIn.open(p),view=f.view();await f.close();
  expect(b.names).toEqual([`mdbase-app-sign-in-v1-${appId}-${cpOrigin}`,`mdbase-app-sign-in-v2-${JSON.stringify([cpOrigin,p.owner,appId])}`]);
  const dbName=`mdbase.app.installation.v2.${encodeURIComponent(cpOrigin)}.${encodeURIComponent(p.owner)}.${appId}`;
  expect((await indexedDB.databases()).map(d=>d.name)).toEqual([dbName]);
  const again=await AppProtectedInstallationSignIn.open({...p,mode:"existing"});expect(again.view()).toEqual(view);await again.close();
  const rebound=rebindApplicationDeclaration(d,{id:"77777777-7777-4777-8777-777777777777",name:"Notes",supersededDeclaredId:appId});
  expect(rebound.storage).toEqual(d.storage);
});

it("namespace-only overrides derive separate bounded journals and recovery owners",()=>{
  const a=declaration("vault-a"),b=declaration("vault-b"),long=declaration("x".repeat(256));
  expect(a.storage.joinDatabaseName).not.toBe(b.storage.joinDatabaseName);expect(a.storage.setupDatabaseName).not.toBe(b.storage.setupDatabaseName);
  expect(long.storage.joinDatabaseName.length).toBeLessThan(256);
  const otherApp=applicationDeclaration({...a,id:"77777777-7777-4777-8777-777777777777",storage:{applicationNamespace:"vault-a"}});
  expect(otherApp.storage.joinDatabaseName).not.toBe(a.storage.joinDatabaseName);
  expect(applicationStorageOwner(manifestId,"x".repeat(256)).length+":scope:".length+36).toBeLessThan(256);
});
