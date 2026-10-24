/** Web-only OUTER protection of an opaque native Noise envelope. No Noise
 * plaintext, native custody key, sign/KEM seed or generic crypto interface. */
import { decode, encode, type CborValue } from "../cbor.js";
import { uuidToBytes } from "../codec.js";
import type { AppDeviceCustodyPersistence } from "./device-registration.js";
import type { AppDeviceIdentityPin, AppDeviceRegistrationReceipt, AppPrivateEnrolOperationMarker } from "./wasm-runtime.js";

/** Real persistent platform storage selected by the authenticated host. Writes
 * must consume/copy borrowed bytes before resolving. NO reset/delete/retry API.
 * A memory implementation is for tests only and does not qualify custody. */
export interface AppNoiseProtectedStore {
  read(namespace: string, options: { signal: AbortSignal }): Promise<Uint8Array | null>;
  /** Atomic exact-ciphertext CAS (or equivalent exclusively owned platform
   * transaction). False preserves another writer; uncertain writes THROW.
   * Never implement this as an unlocked read followed by a blind overwrite. */
  compareAndSet(namespace: string, expected: Uint8Array | null, encrypted: Uint8Array, options: { signal: AbortSignal }): Promise<boolean>;
}
export interface AppRestoredNoiseCustody { readonly envelope: Uint8Array; readonly receipt: AppDeviceRegistrationReceipt | null; readonly privateEnrolMarker: AppPrivateEnrolOperationMarker | null; }
const bad=()=>new Error("app Noise custody unavailable; preserve storage and reopen");
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length && a.every((v,i)=>v===b[i]);
/** The KEK is acquired/restored through the platform's persistent protected key
 * provider. NEVER generate a substitute key on failed lookup/decrypt/reopen.
 * Workers do NOT isolate keys against same-origin JS/XSS. */
export class AppWebNoiseCustody implements AppDeviceCustodyPersistence {
  private readonly scope:Readonly<{connectorId:string;deviceId:string;installationId:string}>;
  private readonly namespace:string;
  private readonly aad:Uint8Array;
  constructor(private readonly pin:AppDeviceIdentityPin,private readonly key:CryptoKey,private readonly store:AppNoiseProtectedStore) {
    try {
      this.scope=Object.freeze({connectorId:pin.connectorId,deviceId:pin.deviceId,installationId:pin.installationId});
      const ids=[this.scope.connectorId,this.scope.deviceId,this.scope.installationId].map(uuidToBytes);if (ids.some(b=>b.every(v=>v===0))) throw bad();
      if (key.type!=="secret" || key.extractable || key.algorithm.name!=="AES-GCM" || (key.algorithm as AesKeyAlgorithm).length!==256 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) throw bad();
      this.namespace=`mdbase.app-noise.v1:${this.scope.connectorId}:${this.scope.deviceId}:${this.scope.installationId}`;
      this.aad=encode(["mdbase/v1/app-noise-platform",...ids]);this.check(new AbortController().signal);
    } catch {throw bad();}
  }
  private check(signal:AbortSignal):void {
    try {if (signal.aborted || this.pin.isCurrent()!==true || this.pin.connectorId!==this.scope.connectorId || this.pin.deviceId!==this.scope.deviceId || this.pin.installationId!==this.scope.installationId) throw bad();} catch {throw bad();}
  }
  private receiptValue(receipt:AppDeviceRegistrationReceipt):CborValue {
    if (receipt.connectorId!==this.scope.connectorId || receipt.deviceId!==this.scope.deviceId || receipt.installationId!==this.scope.installationId) throw bad();
    const keys=[receipt.signPublicKey,receipt.kemPublicKey,receipt.noisePublicKey];if (keys.some(b=>!(b instanceof Uint8Array) || b.length!==32 || b.every(v=>v===0))) throw bad();
    return keys.map(b=>new Uint8Array(b));
  }
  private receipt(value:CborValue):AppDeviceRegistrationReceipt|null {
    if (value===null) return null;
    if (!Array.isArray(value) || value.length!==3 || value.some(b=>!(b instanceof Uint8Array) || b.length!==32 || b.every(v=>v===0))) throw bad();
    return Object.freeze({...this.scope,signPublicKey:new Uint8Array(value[0] as Uint8Array),kemPublicKey:new Uint8Array(value[1] as Uint8Array),noisePublicKey:new Uint8Array(value[2] as Uint8Array)});
  }
  private markerValue(marker:AppPrivateEnrolOperationMarker):CborValue {
    const collection=uuidToBytes(marker.collection);if(collection.every(v=>v===0) || typeof marker.acknowledged!=="boolean" || !(marker.sasCommitment instanceof Uint8Array) || marker.sasCommitment.length!==32 || marker.sasCommitment.every(v=>v===0)) throw bad();
    return [collection,...this.receiptValue(marker) as CborValue[],new Uint8Array(marker.sasCommitment),marker.acknowledged];
  }
  private marker(value:CborValue,receipt:AppDeviceRegistrationReceipt|null):AppPrivateEnrolOperationMarker|null {
    if(value===null) return null;
    if(!receipt || !Array.isArray(value) || value.length!==6 || !(value[0] instanceof Uint8Array) || value[0].length!==16 || value[0].every(v=>v===0) || typeof value[5]!=="boolean") throw bad();
    const keys=this.receipt(value.slice(1,4))!;for(const k of ["signPublicKey","kemPublicKey","noisePublicKey"] as const) if(!equal(keys[k],receipt[k])) throw bad();
    const commit=value[4];if(!(commit instanceof Uint8Array) || commit.length!==32 || commit.every(v=>v===0)) throw bad();
    const id=Array.from(value[0],v=>v.toString(16).padStart(2,"0")).join("");
    return Object.freeze({...keys,collection:`${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`,sasCommitment:new Uint8Array(commit),acknowledged:value[5]});
  }
  /** Async BEFORE sync native device open. Missing is explicit null, not first
   * install authorization: a host must consult its installation record. Any
   * existing ciphertext/key/scope failure REFUSES, never regenerates/falls back. */
  async restore(options:{signal:AbortSignal}):Promise<AppRestoredNoiseCustody|null> {
    const record=await this.read(options);this.check(options.signal);return record?.value??null;
  }
  private async read(options:{signal:AbortSignal}):Promise<{value:AppRestoredNoiseCustody;encrypted:Uint8Array}|null> {
    let cipher:Uint8Array|null=null,plain:Uint8Array|null=null;
    try {
      this.check(options.signal);const borrowed=await this.store.read(this.namespace,options);this.check(options.signal);
      if (borrowed===null) return null;
      if (!(borrowed instanceof Uint8Array) || borrowed.length===0 || borrowed.length>4096) throw bad();cipher=new Uint8Array(borrowed);
      const outer=decode(cipher);if (!(outer instanceof Map)) throw bad();const m=outer as Map<CborValue,CborValue>;const iv=m.get(1),body=m.get(2);
      if (m.size!==3 || m.get(0)!==1 || !(iv instanceof Uint8Array) || iv.length!==12 || !(body instanceof Uint8Array) || body.length<16 || body.length>2064) throw bad();
      plain=new Uint8Array(await globalThis.crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(iv),additionalData:new Uint8Array(this.aad),tagLength:128},this.key,new Uint8Array(body)));this.check(options.signal);
      if (plain.length>2048) throw bad();const value=decode(plain);if (!(value instanceof Map)) throw bad();const record=value as Map<CborValue,CborValue>,envelope=record.get(1);
      if (!((record.get(0)===1 && record.size===3) || (record.get(0)===2 && record.size===4 && record.has(3))) || !(envelope instanceof Uint8Array) || envelope.length===0 || envelope.length>1024 || !record.has(2)) throw bad();
      const receipt=this.receipt(record.get(2)!);const marker=record.get(0)===2?this.marker(record.get(3)!,receipt):null;
      return {value:Object.freeze({envelope:new Uint8Array(envelope),receipt,privateEnrolMarker:marker}),encrypted:new Uint8Array(cipher)};
    } catch {throw bad();}
    finally {cipher?.fill(0);plain?.fill(0);}
  }
  private async write(envelope:Uint8Array,receipt:AppDeviceRegistrationReceipt|null,expected:Uint8Array|null,options:{signal:AbortSignal},marker:AppPrivateEnrolOperationMarker|null=null):Promise<void> {
    let plain:Uint8Array|null=null,cipher:Uint8Array|null=null;
    try {
      this.check(options.signal);if (!(envelope instanceof Uint8Array) || !envelope.length || envelope.length>1024) throw bad();
      const record=new Map<number,CborValue>([[0,marker===null?1:2],[1,new Uint8Array(envelope)],[2,receipt===null?null:this.receiptValue(receipt)]]);if(marker!==null) {const value=this.markerValue(marker);this.marker(value,receipt);record.set(3,value);}
      plain=encode(record);if (plain.length>2048) throw bad();
      const iv=globalThis.crypto.getRandomValues(new Uint8Array(12));
      const body=new Uint8Array(await globalThis.crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:new Uint8Array(this.aad),tagLength:128},this.key,new Uint8Array(plain)));this.check(options.signal);
      cipher=encode(new Map<number,CborValue>([[0,1],[1,iv],[2,body]]));const stored=await this.store.compareAndSet(this.namespace,expected,cipher,options);this.check(options.signal);if (stored!==true) throw bad();
    } catch {throw bad();}
    finally {plain?.fill(0);cipher?.fill(0);}
  }
  async pending(envelope:Uint8Array,options:{signal:AbortSignal}):Promise<void> {
    const existing=await this.read(options);this.check(options.signal);
    // Preserve completed registration and uncertain prior writes. NO overwrite
    // with a different Noise identity, no fresh fallback/reset if record exists.
    if (existing) {if (!equal(existing.value.envelope,envelope)) throw bad();return;}
    await this.write(envelope,null,null,options);this.check(options.signal);
  }
  /** Protect PUBLIC exact tuple+commit BEFORE POST. Existing uncertain marker
   * cannot be replaced/cleared; no r, SAS custody purpose or generic data API. */
  async privateEnrolPending(marker:AppPrivateEnrolOperationMarker,options:{signal:AbortSignal}):Promise<void> {
    try {if(marker.acknowledged!==false) throw bad();await this.writePrivateMarker(marker,false,options);} catch {throw bad();}
  }
  /** Actual authenticated CP enrol response only, NOT approval/keyed. */
  async privateEnrolAcknowledged(marker:AppPrivateEnrolOperationMarker,options:{signal:AbortSignal}):Promise<void> {
    try {await this.writePrivateMarker(marker,true,options);} catch {throw bad();}
  }
  private async writePrivateMarker(marker:AppPrivateEnrolOperationMarker,acknowledged:boolean,options:{signal:AbortSignal}):Promise<void> {
    this.check(options.signal);const owned=this.marker(this.markerValue(marker),marker)!;
    const existing=await this.read(options);this.check(options.signal);if(!existing?.value.receipt) throw bad();
    for(const k of ["signPublicKey","kemPublicKey","noisePublicKey"] as const) if(!equal(owned[k],existing.value.receipt[k])) throw bad();
    const prior=existing.value.privateEnrolMarker;
    if(prior) {
      if(prior.collection!==owned.collection || !equal(prior.sasCommitment,owned.sasCommitment)) throw bad();
      if(prior.acknowledged) {if(!acknowledged) throw bad();return;}
      if(!acknowledged) return;
    } else if(acknowledged) throw bad();
    await this.write(existing.value.envelope,existing.value.receipt,existing.encrypted,options,Object.freeze({...owned,acknowledged}));this.check(options.signal);
  }
  async registered(receipt:AppDeviceRegistrationReceipt,options:{signal:AbortSignal}):Promise<void> {
    const existing=await this.read(options);this.check(options.signal);if (!existing) throw bad();
    if (existing.value.receipt) {
      for (const k of ["signPublicKey","kemPublicKey","noisePublicKey"] as const) if (!equal(existing.value.receipt[k],receipt[k])) throw bad();
      this.receiptValue(receipt);return;
    }
    await this.write(existing.value.envelope,receipt,existing.encrypted,options);this.check(options.signal);
  }
}
