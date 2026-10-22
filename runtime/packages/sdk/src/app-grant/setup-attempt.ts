/** An encrypted original-MID register, deliberately NOT an ordinary write/replay journal. */
import { mdbaseError } from "../errors.js";
import type { AppGrantStore, StoredAppGrant } from "./grant-store.js";
export interface PrivateSetupJournal {
  load(): Promise<string | undefined>;
  begin(mid: string): Promise<string>;
  clear(mid: string): Promise<void>;
}
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function protectedSetupJournal(input: {
  store():Promise<AppGrantStore>; grant():Promise<StoredAppGrant>; assertCurrent(grant:StoredAppGrant):Promise<unknown>; aad:Uint8Array;
}):PrivateSetupJournal {
  const aad=new Uint8Array([...input.aad,...new TextEncoder().encode("\0declared-setup-attempt-v1")]);
  const fail=()=>mdbaseError("unavailable","Protected Native setup attempt storage is unavailable.","grant_storage");
  async function context() {
    const grant=await input.grant(); await input.assertCurrent(grant);
    const store=await input.store();
    if(!store.getSetupAttempt || !store.putSetupAttemptIfAbsent || !store.deleteSetupAttempt) throw fail();
    return {grant,store};
  }
  async function decode(bytes:Uint8Array,grant:StoredAppGrant):Promise<string> {
    let plain:Uint8Array|undefined;
    try {
      if(bytes.length<29 || bytes.length>2048) throw fail();
      plain=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12),additionalData:aad},grant.refreshKey,bytes.slice(12)));
      const row=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));
      const noise=Array.from(grant.noisePublicKey,b=>b.toString(16).padStart(2,"0")).join("");
      if(row.version!==1 || !uuid.test(row.mid) || row.noise!==noise || Object.keys(row).sort().join(",")!=="mid,noise,version") throw fail();
      await input.assertCurrent(grant); return row.mid;
    } catch {throw fail();} finally {plain?.fill(0);}
  }
  return {
    async load(){const {grant,store}=await context(), b=await store.getSetupAttempt!(grant.collection); await input.assertCurrent(grant); return b?decode(b,grant):undefined;},
    async begin(mid){
      if(!uuid.test(mid)) throw fail();
      const {grant,store}=await context(),iv=crypto.getRandomValues(new Uint8Array(12));
      const plain=new TextEncoder().encode(JSON.stringify({version:1,mid,noise:Array.from(grant.noisePublicKey,b=>b.toString(16).padStart(2,"0")).join("")}));
      let encrypted:Uint8Array;
      try {encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},grant.refreshKey,plain));} finally{plain.fill(0);}
      await input.assertCurrent(grant);
      const result=await store.putSetupAttemptIfAbsent!(grant.collection,new Uint8Array([...iv,...encrypted]));
      return decode(result,grant);
    },
    async clear(mid){
      const {grant,store}=await context(),b=await store.getSetupAttempt!(grant.collection);
      if(b && await decode(b,grant)===mid){await input.assertCurrent(grant);await store.deleteSetupAttempt!(grant.collection,b);}
    },
  };
}
