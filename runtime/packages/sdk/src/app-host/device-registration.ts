/** First-party protected device registration ONLY. No collection bootstrap,
 * private-enrol/create/SAS/Noise handshake, retry or provider activation. */
import { uuidToBytes } from "../codec.js";
import type { AppDeviceIdentityPin, AppDeviceRegistrationReceipt, AppNoiseCustodyResult, AppWasmRuntime } from "./wasm-runtime.js";

export interface AppCpDeviceSession extends AppDeviceIdentityPin {
  readonly cpOrigin: string;
  /** Actual first-party platform: Capacitor mobile1, web app-runtime2. */
  readonly kind: "mobile" | "app-runtime";
  connectorBearer(options: { signal: AbortSignal }): Promise<string>;
}
/** Platform-protected store; NO deletion/reset/retry surface. A successful
 * write is NOT collection durability/Saved. Uncertain writes must be preserved. */
export interface AppDeviceCustodyPersistence {
  pending(envelope: Uint8Array, options: { signal: AbortSignal }): Promise<void>;
  registered(receipt: AppDeviceRegistrationReceipt, options: { signal: AbortSignal }): Promise<void>;
}
export class AppDeviceRegistrationError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "unavailable" | "response") { super(`app device registration: ${reason}`); this.name="AppDeviceRegistrationError"; }
}
const fail=(r:AppDeviceRegistrationError["reason"])=>new AppDeviceRegistrationError(r);
const hex=(b:Uint8Array)=>Array.from(b,v=>v.toString(16).padStart(2,"0")).join("");
/** The runtime has already opened its DEVICE-only phase. Store opaque native
 * custody BEFORE the single challenge/registration attempt; store the actual
 * response's exact public receipt BEFORE permitting native collection adoption. */
export class AppCpDeviceRegistration {
  private attempted=false;
  private readonly lifetime=new AbortController();
  private readonly origin:string;
  private readonly rawOrigin:string;
  private readonly scope:Readonly<{connectorId:string;deviceId:string;installationId:string;kind:"mobile"|"app-runtime"}>;
  private readonly custody:AppNoiseCustodyResult;
  private readonly now:()=>number;
  private readonly fetchImpl:typeof globalThis.fetch;
  constructor(private readonly runtime:AppWasmRuntime,private readonly session:AppCpDeviceSession,custody:AppNoiseCustodyResult,private readonly persistence:AppDeviceCustodyPersistence,options:{fetch?:typeof globalThis.fetch;now?:()=>number;allowLoopbackHttp?:boolean}={}) {
    try {
      this.scope=Object.freeze({connectorId:session.connectorId,deviceId:session.deviceId,installationId:session.installationId,kind:session.kind});
      for (const id of [this.scope.connectorId,this.scope.deviceId,this.scope.installationId]) if (uuidToBytes(id).every(b=>b===0)) throw fail("binding");
      if (session.kind!=="mobile" && session.kind!=="app-runtime") throw fail("binding");
      this.rawOrigin=session.cpOrigin;const u=new URL(this.rawOrigin);
      if (u.username || u.password || u.pathname!=="/" || u.search || u.hash || (u.protocol!=="https:" && !(options.allowLoopbackHttp===true && u.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(u.hostname)))) throw fail("binding");
      this.origin=u.origin;this.now=options.now??Date.now;this.fetchImpl=options.fetch??globalThis.fetch;
      if (!(custody.envelope instanceof Uint8Array) || !custody.envelope.length || custody.envelope.length>1024) throw fail("binding");
      if (!runtime.deviceCustodyCurrent(session,custody)) throw fail("binding");
      this.custody=Object.freeze({signPublicKey:new Uint8Array(custody.signPublicKey),kemPublicKey:new Uint8Array(custody.kemPublicKey),noisePublicKey:new Uint8Array(custody.noisePublicKey),envelope:new Uint8Array(custody.envelope)});
      if (!this.current()) throw fail("binding");
    } catch {runtime.retireLog();throw fail("binding");}
  }
  private current():boolean {
    try {return !this.lifetime.signal.aborted && this.runtime.deviceCustodyCurrent(this.session,this.custody) && this.session.isCurrent()===true && this.session.cpOrigin===this.rawOrigin && this.session.connectorId===this.scope.connectorId && this.session.deviceId===this.scope.deviceId && this.session.installationId===this.scope.installationId && this.session.kind===this.scope.kind;} catch {return false;}
  }
  private check(signal:AbortSignal):void {if (!this.current() || signal.aborted) {this.close();throw fail("fenced");}}
  private async json(path:"/v1/next/devices/challenge"|"/v1/next/devices",bearer:string,body:string|undefined,parent:AbortSignal):Promise<Record<string,unknown>> {
    this.check(parent);const ctrl=new AbortController(),abort=()=>ctrl.abort(),timer=setTimeout(abort,15_000);(timer as {unref?:()=>void}).unref?.();
    parent.addEventListener("abort",abort,{once:true});this.lifetime.signal.addEventListener("abort",abort,{once:true});
    const bytes=new Uint8Array(32*1024);let count=0,response:Response|null=null,reader:ReadableStreamDefaultReader<Uint8Array>|null=null;
    try {
      const fetchImpl=this.fetchImpl;response=await fetchImpl(`${this.origin}${path}`,{method:"POST",headers:{authorization:`Bearer ${bearer}`,...(body===undefined?{}:{"content-type":"application/json"})},body,signal:ctrl.signal,redirect:"error",credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"});
      this.check(parent);if (ctrl.signal.aborted || !response.ok) throw fail("unavailable");
      // Fetch's decoded stream is authoritative for the cap, not wire length.
      const length=response.headers.get("content-length");if (length!==null && /^(0|[1-9][0-9]*)$/.test(length) && Number(length)>bytes.length) {ctrl.abort();throw fail("response");}
      if (!response.body) throw fail("response");reader=response.body.getReader();
      for (;;) {const {done,value}=await reader.read();try {this.check(parent);if (ctrl.signal.aborted) throw fail("unavailable");if (done) break;if (count+value.length>bytes.length) {ctrl.abort();throw fail("response");}bytes.set(value,count);count+=value.length;} finally {value?.fill(0);}}
      const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,count)));
      if (!value || typeof value!=="object" || Array.isArray(value)) throw fail("response");return value as Record<string,unknown>;
    } catch (e) {this.check(parent);if (e instanceof AppDeviceRegistrationError) throw e;throw fail("unavailable");}
    finally {bytes.fill(0);void (reader?.cancel()??response?.body?.cancel())?.catch(()=>{});reader?.releaseLock();clearTimeout(timer);parent.removeEventListener("abort",abort);this.lifetime.signal.removeEventListener("abort",abort);}
  }
  async register(options:{signal:AbortSignal}):Promise<AppDeviceRegistrationReceipt> {
    let challenge:Uint8Array|null=null,signature:Uint8Array|null=null;
    try {
      this.check(options.signal);if (this.attempted) throw fail("fenced");this.attempted=true;
      await this.persistence.pending(new Uint8Array(this.custody.envelope),options);this.check(options.signal);
      const bearer=await this.session.connectorBearer(options);this.check(options.signal);
      if (typeof bearer!=="string" || !bearer || bearer.length>16*1024 || /[^\x21-\x7e]/.test(bearer)) throw fail("binding");
      const issued=await this.json("/v1/next/devices/challenge",bearer,undefined,options.signal);this.check(options.signal);
      if (typeof issued.challenge!=="string" || !/^[0-9a-f]{64}$/.test(issued.challenge) || typeof issued.expires_at!=="number" || !Number.isSafeInteger(issued.expires_at) || issued.expires_at-this.now()<=5000 || issued.expires_at-this.now()>16*60_000) throw fail("response");
      challenge=Uint8Array.from(issued.challenge.match(/../g)!.map(v=>parseInt(v,16)));const proof=this.runtime.signCpEnrol(challenge);this.check(options.signal);signature=proof.signature;
      const result=await this.json("/v1/next/devices",bearer,JSON.stringify({device_id:this.scope.deviceId,kind:this.scope.kind,challenge:issued.challenge,sign_pk:hex(proof.signPublicKey),kem_pk:hex(proof.kemPublicKey),noise_pk:hex(proof.noisePublicKey),sig:hex(signature)}),options.signal);this.check(options.signal);
      if (result.device_id!==this.scope.deviceId) throw fail("response");
      const receipt=Object.freeze({connectorId:this.scope.connectorId,deviceId:this.scope.deviceId,installationId:this.scope.installationId,signPublicKey:new Uint8Array(proof.signPublicKey),kemPublicKey:new Uint8Array(proof.kemPublicKey),noisePublicKey:new Uint8Array(proof.noisePublicKey)});
      await this.persistence.registered(receipt,options);this.check(options.signal);
      this.runtime.acknowledgeDeviceRegistration(receipt);return receipt;
    } catch(e) {this.close();if (e instanceof AppDeviceRegistrationError) throw e;throw fail("unavailable");}
    finally {challenge?.fill(0);signature?.fill(0);}
  }
  close():void {if (this.lifetime.signal.aborted) return;this.lifetime.abort();this.custody.envelope.fill(0);this.runtime.retireLog();}
}
