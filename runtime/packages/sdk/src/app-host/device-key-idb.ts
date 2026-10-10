/** Bounded first-party original-device ciphertext IO. No CryptoKey/seed export,
 * replacement, delete, generic KV, collection SQL or implicit recovery. */
import { uuidToBytes } from "../codec.js";
import type { AppDeviceKeyCustodyPin, AppDeviceKeyProtectedStore } from "./device-key-custody.js";
const STORE="original-device-keys", KEY="custody", MAX=256;
const fail=()=>new Error("app device key custody store unavailable");
function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || !value.length || value.length>MAX) throw fail();
  return new Uint8Array(value);
}
export interface AppIndexedDbDeviceKeyOptions {
  readonly origin: string;
  readonly mode: "fresh" | "existing";
  readonly source: AppDeviceKeyCustodyPin;
  readonly signal: AbortSignal;
  readonly allowLoopbackHttp?: boolean;
}
export class AppIndexedDbDeviceKeyProtectedStore implements AppDeviceKeyProtectedStore {
  private closed=false;
  private readonly current: AppDeviceKeyCustodyPin["isCurrent"];
  private readonly owned: AppDeviceKeyCustodyPin["installationOwned"];
  private constructor(private readonly db: IDBDatabase, private readonly source: AppDeviceKeyCustodyPin,
    private readonly scope: Readonly<{accountId:string;connectorId:string;deviceId:string;installationId:string}>,
    private readonly namespace: string, private readonly origin: string) {
    this.current=source.isCurrent; this.owned=source.installationOwned;
    db.onversionchange=()=>this.close();
  }
  static async open(options: AppIndexedDbDeviceKeyOptions): Promise<AppIndexedDbDeviceKeyProtectedStore> {
    try { return await this.openChecked(options); } catch { throw fail(); }
  }
  private static async openChecked(options: AppIndexedDbDeviceKeyOptions): Promise<AppIndexedDbDeviceKeyProtectedStore> {
    // Snapshot ALL option/scope/authority inputs before an IDB wait or upgrade.
    const {source,signal,mode,origin}=options;
    const scope=Object.freeze({accountId:source.accountId,connectorId:source.connectorId,deviceId:source.deviceId,installationId:source.installationId});
    const current=source.isCurrent,owned=source.installationOwned;
    const isCurrent=()=>{try{return !signal.aborted && source.isCurrent===current && source.installationOwned===owned && current.call(source)===true && owned.call(source)===true && (Object.keys(scope) as (keyof typeof scope)[]).every(k=>source[k]===scope[k]);}catch{return false;}};
    const ids=[scope.accountId,scope.connectorId,scope.deviceId,scope.installationId].map(v=>{const b=uuidToBytes(v);if(b.every(v=>v===0))throw fail();return Array.from(b,v=>v.toString(16).padStart(2,"0")).join("");});
    const endpoint=new URL(origin),loopback=options.allowLoopbackHttp===true && endpoint.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname);
    if ((!loopback && endpoint.protocol!=="https:") || endpoint.origin!==origin || endpoint.username || endpoint.password || globalThis.location?.origin!==origin || !["fresh","existing"].includes(mode) || !isCurrent() || !globalThis.indexedDB) throw fail();
    const namespace=`mdbase.app-device-keys.v1:${ids.join(":")}`,name=`mdbase.app.device-keys.v1.${ids.join(".")}`;
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open(name,1);let abandoned=false;
      const stop=()=>{abandoned=true;reject(fail());};
      signal.addEventListener("abort",stop,{once:true});const finish=()=>signal.removeEventListener("abort",stop);
      request.onblocked=stop;
      request.onupgradeneeded=()=>{if(abandoned || mode!=="fresh" || !isCurrent() || request.result.objectStoreNames.length!==0){request.transaction?.abort();return;}request.result.createObjectStore(STORE);};
      request.onerror=()=>{finish();reject(fail());};
      request.onsuccess=()=>{finish();if(abandoned || !isCurrent() || request.result.objectStoreNames.length!==1 || !request.result.objectStoreNames.contains(STORE)){request.result.close();reject(fail());return;}resolve(request.result);};
    });
    const out=new AppIndexedDbDeviceKeyProtectedStore(db,source,scope,namespace,origin);
    try {out.check(signal);const record=await out.read(namespace,{signal});try {if((mode==="fresh")!==(record===null))throw fail();out.check(signal);return out;}finally{record?.fill(0);}}catch{out.close();throw fail();}
  }
  private check(signal: AbortSignal, namespace=this.namespace): void {
    try {
      if(this.closed || signal.aborted || namespace!==this.namespace || globalThis.location?.origin!==this.origin || this.source.isCurrent!==this.current || this.source.installationOwned!==this.owned || this.current.call(this.source)!==true || this.owned.call(this.source)!==true || (Object.keys(this.scope) as (keyof typeof this.scope)[]).some(k=>this.source[k]!==this.scope[k]))throw fail();
    }catch{throw fail();}
  }
  async read(namespace: string, options: {signal:AbortSignal}): Promise<Uint8Array|null> {
    const result=await this.transaction("readonly",namespace,options.signal,null);
    try {this.check(options.signal,namespace);return result as Uint8Array|null;}catch{if(result instanceof Uint8Array)result.fill(0);throw fail();}
  }
  async create(namespace: string, encrypted: Uint8Array, options: {signal:AbortSignal}): Promise<boolean> {
    this.check(options.signal,namespace);const value=bytes(encrypted);
    try {const result=await this.transaction("readwrite",namespace,options.signal,value);this.check(options.signal,namespace);return result===true;}finally{value.fill(0);}
  }
  private transaction(mode: IDBTransactionMode, namespace: string, signal: AbortSignal, next: Uint8Array|null): Promise<Uint8Array|null|boolean> {
    return new Promise((resolve,reject)=>{
      this.check(signal,namespace);const tx=this.db.transaction(STORE,mode,{durability:"strict"}),store=tx.objectStore(STORE);
      let result: Uint8Array|null|boolean=null,failed=false;
      const abort=()=>{failed=true;try{tx.abort();}catch{/* possible committed result remains uncertain */}};
      const finish=()=>signal.removeEventListener("abort",abort);
      signal.addEventListener("abort",abort,{once:true});
      tx.onabort=tx.onerror=()=>{finish();if(result instanceof Uint8Array)result.fill(0);reject(fail());};
      tx.oncomplete=()=>{finish();try{this.check(signal,namespace);if(failed)throw fail();resolve(result);}catch{if(result instanceof Uint8Array)result.fill(0);reject(fail());}};
      const request=store.get(KEY);
      request.onsuccess=()=>{let prior:Uint8Array|null=null;try{this.check(signal,namespace);prior=request.result===undefined?null:bytes(request.result);if(mode==="readonly"){result=prior;prior=null;}else{result=prior===null;if(result===true && next!==null)store.add(new Uint8Array(next),KEY);}}catch{abort();}finally{prior?.fill(0);}};
    });
  }
  close(): void {if(!this.closed){this.closed=true;this.db.close();}}
}
