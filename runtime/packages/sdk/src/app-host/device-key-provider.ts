/** First-party browser platform KEK, NOT a third-party grant/keychain API.
 * Stores only a nonextractable CryptoKey, never raw KEK/device secrets. Same
 * origin XSS can still invoke it; IDB/strict durability is not OS key isolation
 * or a physical durability/Saved guarantee. Explicit fresh/existing only. */
import { uuidToBytes } from "../codec.js";
import type { AppDeviceKeyCustodyPin } from "./device-key-custody.js";
const STORE="device-key-kek",KEY="original-device-kek";
const fail=()=>new Error("app device key provider unavailable; preserve storage and reopen");
export interface AppIndexedDbDeviceKeyProviderOptions {
  readonly source: AppDeviceKeyCustodyPin;
  readonly origin: string;
  readonly mode: "fresh" | "existing";
  readonly signal: AbortSignal;
  /** Owned isolated loopback fixtures only, never arbitrary HTTP. */
  readonly allowLoopbackHttp?: boolean;
}
function key(value: unknown): CryptoKey {
  // Genuine platform key handle, not metadata alone; IDB clones into this realm.
  if(typeof globalThis.CryptoKey!=="function" || !(value instanceof CryptoKey) || value.type!=="secret" || value.extractable || value.algorithm.name!=="AES-GCM" || (value.algorithm as AesKeyAlgorithm).length!==256 || value.usages.length!==2 || !value.usages.includes("encrypt") || !value.usages.includes("decrypt"))throw fail();
  return value;
}
function record(value: unknown): CryptoKey|null {
  if(value===undefined)return null;
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length!==2 || !Object.hasOwn(value,"version") || !Object.hasOwn(value,"key") || (value as {version:unknown}).version!==1)throw fail();
  return key((value as {key:unknown}).key);
}
export class AppIndexedDbDeviceKeyProvider {
  private db: IDBDatabase|null=null;
  private value: CryptoKey|null=null;
  private closed=false;
  private loaned=false;
  private readonly scope: Readonly<{accountId:string;connectorId:string;deviceId:string;installationId:string}>;
  private readonly current: AppDeviceKeyCustodyPin["isCurrent"];
  private readonly owned: AppDeviceKeyCustodyPin["installationOwned"];
  private constructor(private readonly source: AppDeviceKeyCustodyPin,private readonly origin: string,private readonly lifetime: AbortSignal) {
    this.scope=Object.freeze({accountId:source.accountId,connectorId:source.connectorId,deviceId:source.deviceId,installationId:source.installationId});
    this.current=source.isCurrent;this.owned=source.installationOwned;
  }
  static async open(options: AppIndexedDbDeviceKeyProviderOptions): Promise<AppIndexedDbDeviceKeyProvider> {
    let out:AppIndexedDbDeviceKeyProvider|null=null;
    try {
      const {source,origin,mode,signal}=options;
      out=new AppIndexedDbDeviceKeyProvider(source,origin,signal);
      const ids=Object.values(out.scope).map(v=>{const bytes=uuidToBytes(v);if(bytes.every(b=>b===0))throw fail();return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");});
      const u=new URL(origin),loopback=options.allowLoopbackHttp===true && u.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(u.hostname);
      if((u.protocol!=="https:"&&!loopback)||u.origin!==origin||u.username||u.password||!["fresh","existing"].includes(mode)||!globalThis.indexedDB||!globalThis.crypto?.subtle||typeof globalThis.CryptoKey!=="function")throw fail();
      out.check(signal);
      const generate=crypto.subtle.generateKey.bind(crypto.subtle);
      const name=`mdbase.app.device-key-kek.v1.${ids.join(".")}`;
      const db=await out.openDatabase(name,mode);out.db=db;
      db.onversionchange=()=>out!.close();out.check(signal);
      const old=await out.transaction("readonly",signal,null);out.check(signal);
      if(mode==="existing") {if(old===null||typeof old==="boolean")throw fail();out.value=old;}
      else {
        if(old!==null)throw fail();
        const next=key(await generate({name:"AES-GCM",length:256},false,["encrypt","decrypt"]));out.check(signal);
        if(await out.transaction("readwrite",signal,next)!==true)throw fail();
        out.check(signal);out.value=next;
      }
      out.check(signal);return out;
    }catch{out?.close();throw fail();}
  }
  private check(signal: AbortSignal): void {
    try {
      if(this.closed||this.lifetime.aborted||signal.aborted||globalThis.location?.origin!==this.origin||this.source.isCurrent!==this.current||this.source.installationOwned!==this.owned||this.current.call(this.source)!==true||this.owned.call(this.source)!==true||Object.entries(this.scope).some(([k,v])=>this.source[k as keyof typeof this.scope]!==v))throw fail();
    }catch{throw fail();}
  }
  private openDatabase(name: string,mode: "fresh"|"existing"): Promise<IDBDatabase> {
    return new Promise((resolve,reject)=>{
      this.check(this.lifetime);const request=indexedDB.open(name,1);let abandoned=false,created=false;
      const stop=()=>{abandoned=true;reject(fail());};
      this.lifetime.addEventListener("abort",stop,{once:true});const finish=()=>this.lifetime.removeEventListener("abort",stop);
      request.onblocked=stop;
      request.onupgradeneeded=()=>{try{this.check(this.lifetime);if(abandoned||mode!=="fresh"||request.result.objectStoreNames.length!==0)throw fail();request.result.createObjectStore(STORE);created=true;}catch{request.transaction?.abort();}};
      request.onerror=()=>{finish();reject(fail());};
      request.onsuccess=()=>{finish();try{this.check(this.lifetime);if(abandoned||(mode==="fresh"&&!created)||request.result.objectStoreNames.length!==1||!request.result.objectStoreNames.contains(STORE))throw fail();resolve(request.result);}catch{request.result.close();reject(fail());}};
    });
  }
  private transaction(mode: IDBTransactionMode,signal: AbortSignal,next: CryptoKey|null): Promise<CryptoKey|null|boolean> {
    return new Promise((resolve,reject)=>{
      this.check(signal);if(!this.db)throw fail();
      const tx=this.db.transaction(STORE,mode,{durability:"strict"}),store=tx.objectStore(STORE);let result:CryptoKey|null|boolean=null,failed=false;
      const abort=()=>{failed=true;try{tx.abort();}catch{/* commit may already exist: preserve */}};
      signal.addEventListener("abort",abort,{once:true});this.lifetime.addEventListener("abort",abort,{once:true});
      const finish=()=>{signal.removeEventListener("abort",abort);this.lifetime.removeEventListener("abort",abort);};
      tx.onerror=tx.onabort=()=>{finish();result=null;reject(fail());};
      tx.oncomplete=()=>{finish();try{this.check(signal);if(failed)throw fail();resolve(result);}catch{result=null;reject(fail());}};
      const request=store.get(KEY);
      request.onsuccess=()=>{try{this.check(signal);const old=record(request.result);if(mode==="readonly")result=old;else{result=old===null;if(result===true&&next!==null)store.add({version:1,key:key(next)},KEY);}}catch{abort();}};
    });
  }
  /** Single first-party handle loan, for constructing original key + Noise
   * custody under the SAME scope. No raw export/sign/DH or arbitrary KV. */
  deviceCustodyKek(options: {signal:AbortSignal}): CryptoKey {
    this.check(options.signal);if(this.loaned||!this.value)throw fail();this.loaned=true;return key(this.value);
  }
  close(): void {if(!this.closed){this.closed=true;this.value=null;this.db?.close();this.db=null;}}
}
