import {describe,it,expect,vi,afterEach} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {protectedSetupJournal} from "../src/app-grant/setup-attempt.js";
import {indexedDbAppGrantStore,memoryAppGrantStore,type StoredAppGrant} from "../src/app-grant/grant-store.js";
import {mdbaseError} from "../src/errors.js";
const mid1="10000000-0000-4000-8000-000000000001",mid2="10000000-0000-4000-8000-000000000002";
afterEach(()=>vi.unstubAllGlobals());
async function fixture(idb=false){
 if(idb)vi.stubGlobal("indexedDB",new IDBFactory());
 const key=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
 const grant:StoredAppGrant={version:1,collection:"20000000-0000-4000-8000-000000000001",noisePrivateKey:key,noisePublicKey:new Uint8Array(32).fill(7),refreshKey:key,refresh:new Uint8Array(28),refreshExpiresAt:Date.now()+3600000};
 const store=idb?indexedDbAppGrantStore("https://cp.example","app",{owner:"bundle:original"}):memoryAppGrantStore();
 await store.putGrant(grant);let current=true;
 const input={store:async()=>store,grant:async()=>grant,assertCurrent:async()=>{if(!current)throw mdbaseError("unauthenticated","replaced");},aad:new TextEncoder().encode("original-scope")};
 return {store,grant,input,replace:()=>{current=false;},journal:protectedSetupJournal(input)};
}
describe("protected Native original-MID register",()=>{
 for(const idb of [false,true])it(`persists only encrypted attempts, atomically selects one MID and reconciles without replay (${idb?"IndexedDB":"memory"})`,async()=>{
   const f=await fixture(idb),second=protectedSetupJournal(f.input);
   const [a,b]=await Promise.all([f.journal.begin(mid1),second.begin(mid2)]);expect(a).toBe(b);
   const ciphertext=await f.store.getSetupAttempt!(f.grant.collection);
   expect(new TextDecoder().decode(ciphertext)).not.toContain(a);
   expect(await protectedSetupJournal(f.input).load()).toBe(a);
   await f.store.deleteSetupAttempt!(f.grant.collection,new Uint8Array(ciphertext!.length));expect(await f.journal.load()).toBe(a);
   await f.journal.clear(a===mid1?mid2:mid1);expect(await f.journal.load()).toBe(a);
   await f.journal.clear(a);expect(await second.load()).toBeUndefined();
 });
 it("refuses replacement identity and ciphertext under another scope",async()=>{
   const f=await fixture(true);await f.journal.begin(mid1);
   const other=protectedSetupJournal({...f.input,aad:new TextEncoder().encode("different scope")});
   await expect(other.load()).rejects.toMatchObject({reason:"grant_storage"});
   f.replace();await expect(f.journal.clear(mid1)).rejects.toMatchObject({code:"unauthenticated"});
   expect(await f.store.getSetupAttempt!(f.grant.collection)).toBeDefined();
 });
});
