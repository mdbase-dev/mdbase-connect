/** First-party DEVICE-phase private bootstrap. Fixed domains/routes, one explicit
 * attempt. Authenticated response metadata is NOT native policy/keyed/readiness. */
import { uuidToBytes } from "../codec.js";
import { collectionDisplayName } from "./collection-display-name.js";
import type { AppWasmRuntime, AppPrivateCollectionPin, AppPrivateEnrolOperationMarker, AppDeviceRegistrationReceipt } from "./wasm-runtime.js";
export interface AppCpPrivateSession extends AppPrivateCollectionPin {
  readonly accountId:string;
  readonly cpOrigin:string;
  readonly logOrigin:string;
  /** Authenticated HOST trust pin, never discovered from this response. */
  readonly rootPublicKey:Uint8Array;
  connectorBearer(options:{signal:AbortSignal}):Promise<string>;
}
export interface AppPrivateBootstrapMetadata {
  readonly collection:string;readonly deviceId:string;readonly logOrigin:string;
  readonly rootPublicKey:Uint8Array;readonly genesisItem:Uint8Array;
  readonly expectedGenesis:string;
  readonly approval:"creator"|"pending";
  readonly displayName?:string;
}
/** Protected exact public operation/completion persistence, not a generic KV or
 * native grant. Acknowledged enrol restore must supply protected genuine metadata
 * without repeating proof. Writes resolve only after outcome preservation. */
export interface AppPrivateBootstrapPersistence {
  pendingCreate(scope:AppDeviceRegistrationReceipt&{readonly collection:string;readonly displayName?:string},options:{signal:AbortSignal}):Promise<void>;
  privateEnrolPending(marker:AppPrivateEnrolOperationMarker,options:{signal:AbortSignal}):Promise<void>;
  completed(metadata:AppPrivateBootstrapMetadata,options:{signal:AbortSignal}):Promise<void>;
  privateEnrolAcknowledged(marker:AppPrivateEnrolOperationMarker,options:{signal:AbortSignal}):Promise<void>;
  restoredCompletion(options:{signal:AbortSignal}):Promise<AppPrivateBootstrapMetadata|null>;
}
export class AppPrivateBootstrapError extends Error {
 constructor(readonly reason:"binding"|"fenced"|"unavailable"|"response") {super(`app private bootstrap: ${reason}`);this.name="AppPrivateBootstrapError";}
}
const fail=(r:AppPrivateBootstrapError["reason"])=>new AppPrivateBootstrapError(r);
const hex=(b:Uint8Array)=>Array.from(b,v=>v.toString(16).padStart(2,"0")).join("");
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function bytes(value:unknown,max:number):Uint8Array {
 if(typeof value!=="string"||!value.length||value.length>max*2||value.length%2||!/^[0-9a-f]+$/.test(value))throw fail("response");
 return Uint8Array.from(value.match(/../g)!.map(v=>parseInt(v,16)));
}
function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=="object"||Array.isArray(value))throw fail("response");return value as Record<string,unknown>;}
export class AppCpPrivateBootstrap {
 private attempted=false;private readonly lifetime=new AbortController();
 private readonly scope:Readonly<{connectorId:string;deviceId:string;installationId:string;collection:string;purpose:"create"|"enrol";accountId:string;cpOrigin:string;logOrigin:string}>;
 private readonly root:Uint8Array;private readonly marker:AppPrivateEnrolOperationMarker|null;
 private readonly fetchImpl:typeof fetch;private readonly now:()=>number;
 private readonly displayName:string|undefined;
 constructor(private readonly runtime:AppWasmRuntime,private readonly session:AppCpPrivateSession,private readonly persistence:AppPrivateBootstrapPersistence,private readonly options:{fetch?:typeof fetch;now?:()=>number;allowLoopbackHttp?:boolean;displayName?:string}={}) {
  try {
   const requestedName=options.displayName;
   this.displayName=requestedName===undefined?undefined:collectionDisplayName(requestedName);
   if(this.displayName!==undefined&&session.purpose!=="create")throw fail("binding");
   this.scope=Object.freeze({connectorId:session.connectorId,deviceId:session.deviceId,installationId:session.installationId,collection:session.collection,purpose:session.purpose,accountId:session.accountId,cpOrigin:session.cpOrigin,logOrigin:session.logOrigin});
   for(const id of [this.scope.connectorId,this.scope.deviceId,this.scope.installationId,this.scope.collection,this.scope.accountId])if(uuidToBytes(id).every(v=>v===0))throw fail("binding");
   this.origin(this.scope.cpOrigin);this.origin(this.scope.logOrigin);
   if(!(session.rootPublicKey instanceof Uint8Array)||session.rootPublicKey.length!==32||session.rootPublicKey.every(v=>v===0))throw fail("binding");this.root=new Uint8Array(session.rootPublicKey);
   this.fetchImpl=options.fetch??globalThis.fetch;this.now=options.now??Date.now;
   this.marker=this.scope.purpose==="enrol"?runtime.privateEnrolMarker():null;
   if(!this.current())throw fail("binding");
  }catch{runtime.retireLog();throw fail("binding");}
 }
 private origin(raw:string):string {const u=new URL(raw);if(u.username||u.password||u.pathname!=="/"||u.search||u.hash||(u.protocol!=="https:"&&!(this.options.allowLoopbackHttp===true&&u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname))))throw fail("binding");return u.origin;}
 private current():boolean {try{return !this.lifetime.signal.aborted&&this.runtime.privateCollectionCurrent(this.session)&&this.session.isCurrent()===true&&this.session.approvalMode==="password-ak1"&&equal(this.session.rootPublicKey,this.root)&&Object.entries(this.scope).every(([k,v])=>this.session[k as keyof AppCpPrivateSession]===v);}catch{return false;}}
 private markerCopy():AppPrivateEnrolOperationMarker {const m=this.marker;if(!m)throw fail("binding");return Object.freeze({...m,sasCommitment:new Uint8Array(m.sasCommitment),signPublicKey:new Uint8Array(m.signPublicKey),kemPublicKey:new Uint8Array(m.kemPublicKey),noisePublicKey:new Uint8Array(m.noisePublicKey)});}
 private check(signal:AbortSignal):void {if(!this.current()||signal.aborted){this.close();throw fail("fenced");}}
 private async json(path:"/v1/next/devices/challenge"|"/v1/next/collections/private"|`/v1/next/collections/${string}/private/devices`,bearer:string,body:string|undefined,signal:AbortSignal):Promise<Record<string,unknown>> {
  this.check(signal);const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,15000);(timer as {unref?:()=>void}).unref?.();signal.addEventListener("abort",abort,{once:true});this.lifetime.signal.addEventListener("abort",abort,{once:true});
  const buffer=new Uint8Array(1024*1024);let count=0,reader:ReadableStreamDefaultReader<Uint8Array>|null=null,response:Response|null=null;
  try {
   const request=this.fetchImpl;response=await request(`${this.origin(this.scope.cpOrigin)}${path}`,{method:"POST",headers:{authorization:`Bearer ${bearer}`,...(body===undefined?{}:{"content-type":"application/json"})},body,signal:controller.signal,redirect:"error",credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"});this.check(signal);if(controller.signal.aborted||!response.ok)throw fail("unavailable");
   // Wire Content-Length can describe compressed bytes; bound decoded bytes.
   const length=response.headers.get("content-length");if(length!==null&&/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)>buffer.length){controller.abort();throw fail("response");}if(!response.body)throw fail("response");reader=response.body.getReader();
   for(;;){const {done,value}=await reader.read();try{this.check(signal);if(controller.signal.aborted)throw fail("unavailable");if(done)break;if(count+value.length>buffer.length){controller.abort();throw fail("response");}buffer.set(value,count);count+=value.length;}finally{value?.fill(0);}}
   return object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,count))));
  }catch(e){this.check(signal);if(e instanceof AppPrivateBootstrapError)throw e;throw fail("unavailable");}finally{buffer.fill(0);void(reader?.cancel()??response?.body?.cancel())?.catch(()=>{});reader?.releaseLock();clearTimeout(timer);signal.removeEventListener("abort",abort);this.lifetime.signal.removeEventListener("abort",abort);}
 }
 private copy(metadata:AppPrivateBootstrapMetadata):AppPrivateBootstrapMetadata {
  if(metadata.displayName!==this.displayName||metadata.collection!==this.scope.collection||metadata.deviceId!==this.scope.deviceId||metadata.logOrigin!==this.scope.logOrigin||!equal(metadata.rootPublicKey,this.root)||!(metadata.genesisItem instanceof Uint8Array)||!metadata.genesisItem.length||metadata.genesisItem.length>256*1024||metadata.expectedGenesis.length!==71||!/^sha256:[0-9a-f]{64}$/.test(metadata.expectedGenesis)||metadata.approval!==(this.scope.purpose==="create"?"creator":"pending"))throw fail("response");
  return Object.freeze({collection:metadata.collection,deviceId:metadata.deviceId,logOrigin:metadata.logOrigin,expectedGenesis:metadata.expectedGenesis,approval:metadata.approval,...(this.displayName===undefined?{}:{displayName:this.displayName}),rootPublicKey:new Uint8Array(metadata.rootPublicKey),genesisItem:new Uint8Array(metadata.genesisItem)});
 }
 async bootstrap(options:{signal:AbortSignal}):Promise<AppPrivateBootstrapMetadata> {
  let nonce:Uint8Array|null=null,signature:Uint8Array|null=null;
  try {
   this.check(options.signal);if(this.attempted)throw fail("fenced");this.attempted=true;
   // Completion may have committed before the ACK write/callback was lost.
   // Restore BOTH purposes before another challenge/proof/POST; repair only the
   // protected enrol acknowledgement, never infer keyed/approval from metadata.
   const stored=await this.persistence.restoredCompletion(options);this.check(options.signal);
   if(stored){const owned=this.copy(stored);if(this.marker&&!this.marker.acknowledged){await this.persistence.privateEnrolAcknowledged(this.markerCopy(),options);this.check(options.signal);}return owned;}
   if(this.marker?.acknowledged)throw fail("response");
   if(this.marker)await this.persistence.privateEnrolPending(this.markerCopy(),options);
   else await this.persistence.pendingCreate({...this.runtime.registeredDeviceReceipt(),collection:this.scope.collection,...(this.displayName===undefined?{}:{displayName:this.displayName})},options);
   this.check(options.signal);const bearer=await this.session.connectorBearer(options);this.check(options.signal);if(typeof bearer!=="string"||!bearer||bearer.length>16384||/[^\x21-\x7e]/.test(bearer))throw fail("binding");
   const issued=await this.json("/v1/next/devices/challenge",bearer,undefined,options.signal);this.check(options.signal);nonce=bytes(issued.challenge,32);if(nonce.length!==32||typeof issued.expires_at!=="number"||!Number.isSafeInteger(issued.expires_at)||issued.expires_at-this.now()<=5000||issued.expires_at-this.now()>16*60000)throw fail("response");
   const enrol=this.scope.purpose==="enrol";signature=enrol?this.runtime.signPrivateDeviceEnrol(nonce).signature:this.runtime.signPrivateCreate(nonce);this.check(options.signal);
   const result=await this.json(enrol?`/v1/next/collections/${this.scope.collection}/private/devices`:"/v1/next/collections/private",bearer,JSON.stringify({device_id:this.scope.deviceId,challenge:issued.challenge,sig:hex(signature),...(enrol?{sas_commit:hex(this.marker!.sasCommitment)}:{collection_id:this.scope.collection,...(this.displayName===undefined?{}:{display_name:this.displayName})})}),options.signal);this.check(options.signal);
   if(result.collection_id!==this.scope.collection||this.origin(result.log_url as string)!==this.origin(this.scope.logOrigin))throw fail("response");
   if(enrol){if(result.approval!=="pending"||typeof result.enrolled_at!=="number"||!Number.isSafeInteger(result.enrolled_at)||result.enrolled_at<1)throw fail("response");}else if(result.state!=="private"||result.owner_account!==this.scope.accountId||!equal(bytes(result.root_public_key,32),this.root))throw fail("response");
   const device=object(result.device);if(device.device_id!==this.scope.deviceId||typeof device.token!=="string"||!device.token.length||device.token.length>16384||/[^\x21-\x7e]/.test(device.token)||typeof device.expires_at!=="number"||!Number.isSafeInteger(device.expires_at)||device.expires_at-this.now()<=5000||device.expires_at-this.now()>16*60000)throw fail("response");
   const genesis=object(result.genesis);if(genesis.seq!==1)throw fail("response");const item=bytes(genesis.item,256*1024);
   // H(domain,msg) = SHA256(u8(domain.length)||UTF8(domain)||msg), wire §hash.
   const domain=new TextEncoder().encode("mdbase/v1/chain"),message=new Uint8Array(1+domain.length+item.length);message[0]=domain.length;message.set(domain,1);message.set(item,1+domain.length);
   const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",message));this.check(options.signal);
   const metadata=this.copy({collection:this.scope.collection,deviceId:this.scope.deviceId,logOrigin:this.scope.logOrigin,rootPublicKey:this.root,genesisItem:item,expectedGenesis:`sha256:${hex(digest)}`,approval:enrol?"pending":"creator",...(this.displayName===undefined?{}:{displayName:this.displayName})});
   await this.persistence.completed(this.copy(metadata),options);this.check(options.signal);if(this.marker){await this.persistence.privateEnrolAcknowledged(this.markerCopy(),options);this.check(options.signal);}return metadata;
  }catch(e){this.close();if(e instanceof AppPrivateBootstrapError)throw e;throw fail("unavailable");}finally{nonce?.fill(0);signature?.fill(0);}
 }
 close():void {this.lifetime.abort();this.runtime.retireLog();}
}
