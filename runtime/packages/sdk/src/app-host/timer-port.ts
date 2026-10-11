/** Fixed native CP timer profile across the SAME owned Worker lifetime.
 * No data client, caller HTTP callback, credential or signer crosses this port.
 * UI Web Push platform work stays on UI; only closed target DTOs cross Worker. */
import { isErrorCode, MdbaseError, mdbaseError } from "../errors.js";
import type { AppTimersPort, TimerRequestOptions } from "../timers.js";
import type { AppReplicaScope } from "./owner.js";
import type { AppInstallationTimerChannel } from "./installation-sign-in.js";
import type { ResolvedWebPushChannelOptions, FcmChannelOptions, TimerChannelRegistration } from "../timers.js";

const NS=/^[A-Za-z0-9._-]{1,64}$/,ID=/^[A-Za-z0-9._:-]{1,128}$/;
const MAX=2*1024*1024;
const error=(code:"invalid_request"|"unauthenticated"|"unavailable"|"outcome_unknown"|"cancelled"|"upgrade_required",reason:string)=>mdbaseError(code,"Native timer request could not complete.",reason);
const key=(scope:Readonly<AppReplicaScope>)=>JSON.stringify([scope.account,scope.installation,scope.collection]);
function segment(value:unknown,pattern:RegExp):string {
  if(typeof value!=="string" || !pattern.test(value)) throw error("invalid_request","timer_input");
  return encodeURIComponent(value);
}
function record(value:unknown,fields:string):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).sort().join()!==fields.split(",").sort().join()) throw error("invalid_request","timer_input");
  return value as Record<string,unknown>;
}
function desired(value:unknown):{id:string;fire_at:string} {
  const r=record(value,"id,fire_at"); segment(r.id,ID);
  if(typeof r.fire_at!=="string" || !/^\d{4}-\d{2}-\d{2}T/.test(r.fire_at) || !Number.isFinite(Date.parse(r.fire_at))) throw error("invalid_request","timer_input");
  return {id:r.id as string,fire_at:r.fire_at};
}
function criterion(value:unknown):void {
  if(typeof value!=="string" || !value.length || value.length>100) throw error("invalid_request","timer_input");
}
function route(prefix:string,verb:string,args:unknown[]):{path:string;method:string;body?:unknown;write:boolean} {
  const base=`${prefix}/${segment(args[0],NS)}`;
  if(verb==="list" && args.length===1) return {path:base,method:"GET",write:false};
  if(verb==="put" && args.length===3) {
    const r=record(args[2],"criterion_id,fire_at"); criterion(r.criterion_id); desired({id:args[1],fire_at:r.fire_at});
    return {path:`${base}/${segment(args[1],ID)}`,method:"PUT",body:r,write:true};
  }
  if(verb==="cancel" && args.length===3) {
    const generation=args[2];
    if(generation!==undefined && (!Number.isSafeInteger(generation) || (generation as number)<1)) throw error("invalid_request","timer_input");
    return {path:`${base}/${segment(args[1],ID)}${generation===undefined?"":`?generation=${generation}`}`,method:"DELETE",write:true};
  }
  if((verb==="reconcile" || verb==="reconcileWithReceipt") && args.length===2) {
    const r=record(args[1],`criterion_id,timers${verb==="reconcileWithReceipt"?",recovery":""}`); criterion(r.criterion_id);
    if(!Array.isArray(r.timers) || r.timers.length>10000) throw error("invalid_request","timer_input");
    const timers=r.timers.map(desired); if(new Set(timers.map(t=>t.id)).size!==timers.length) throw error("invalid_request","timer_input");
    if(verb==="reconcileWithReceipt") {
      const recovery=record(r.recovery,"protocol_version,operation_id,expected_revision");
      if(recovery.protocol_version!==1 || typeof recovery.operation_id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recovery.operation_id)
        || !Number.isSafeInteger(recovery.expected_revision) || (recovery.expected_revision as number)<0 || (recovery.expected_revision as number)>=Number.MAX_SAFE_INTEGER) throw error("invalid_request","timer_input");
    }
    return {path:`${base}/reconcile`,method:"POST",body:{...r,timers},write:true};
  }
  if(verb==="lookupOperation" && args.length===2 && typeof args[1]==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args[1])) return {path:`${base}/operations/${args[1]}`,method:"GET",write:false};
  throw error("invalid_request","timer_input");
}

/** Internal trusted-host composition. The host selects the ORIGINAL receipt;
 * public grant IDs supplied by a caller never select this receiver's authority. */
export function attachAppTimerReceiver(port:MessagePort, options:{
  scope:Readonly<AppReplicaScope>;generation:string;grantId:string;cpOrigin:string;
  signal:AbortSignal;isCurrent():boolean;bearer():Promise<string>;fetch:typeof fetch;
  journal?:{read():AppInstallationTimerChannel|null;write(value:AppInstallationTimerChannel|null):Promise<void>};
}):{close():Promise<void>} {
  const scopeKey=key(options.scope),generation=options.generation;
  const prefix=`/v1/next/collections/${options.scope.collection}/background-grants/${options.grantId}/timers`;
  let closed=false,last=0,slot:{id:number;ctrl:AbortController;work:Promise<void>}|null=null,closing:Promise<void>|null=null;
  const check=()=>{if(closed || options.signal.aborted || !options.isCurrent()) throw error("unauthenticated","timer_fenced");};
  const close=()=>{
    if(closing) return closing; closed=true; options.signal.removeEventListener("abort",abort); slot?.ctrl.abort();
    try{port.postMessage([1,scopeKey,generation,"close"]);}finally{port.removeEventListener("message",receive);port.close();}
    return closing=Promise.resolve().then(async()=>{await slot?.work;});
  };
  const abort=()=>{void close();};
  const receive=(event:MessageEvent<unknown>)=>{
    const frame=event.data;
    if(!Array.isArray(frame) || frame[0]!==1 || frame[1]!==scopeKey || frame[2]!==generation) {void close();return;}
    if(frame.length===4 && frame[3]==="close") {void close();return;}
    if(frame.length===5 && frame[4]==="cancel" && Number.isSafeInteger(frame[3]) && frame[3]>0) {if(slot && slot.id===frame[3]) slot.ctrl.abort();return;}
    if(frame.length!==6 || !Number.isSafeInteger(frame[3]) || frame[3]<=last || slot || typeof frame[4]!=="string" || !Array.isArray(frame[5])) {void close();return;}
    const id=frame[3] as number,verb=frame[4],args=frame[5],ctrl=new AbortController();last=id;
    let dispatched=false,write=verb!=="list" && verb!=="lookupOperation";
    const work=Promise.resolve().then(async()=>{
      const timer=setTimeout(()=>ctrl.abort(),10000); let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      const bytes=new Uint8Array(MAX);let count=0;
      const cancelBody=()=>{void reader?.cancel().catch(()=>{});};ctrl.signal.addEventListener("abort",cancelBody,{once:true});
      try {
        check();ctrl.signal.throwIfAborted();
        const channelBase=prefix.slice(0,-"/timers".length)+"/notifications/channels";
        let request:{path:string;method:string;body?:unknown;write:boolean},pending:AppInstallationTimerChannel|undefined,previousChannel:AppInstallationTimerChannel|null=null;
        if(verb==="vapid" && args.length===0) {
          if(!options.journal)throw error("upgrade_required","native_timer_channel_journal_unavailable");
          options.journal.read();request={path:"/v1/notifications/vapid-public-key",method:"GET",write:false};
        }
        else if(verb==="registerChannel" && args.length===1) {
          if(!options.journal)throw error("upgrade_required","native_timer_channel_journal_unavailable");
          const input=args[0] as {kind?:unknown};
          const row=record(input,`kind,criteria,${input?.kind==="web_push"?"subscription":"token"}`);
          if(!["web_push","fcm"].includes(row.kind as string)||!Array.isArray(row.criteria)||!row.criteria.length||row.criteria.length>100)throw error("invalid_request","timer_input");
          row.criteria.forEach(criterion);if(new Set(row.criteria).size!==row.criteria.length)throw error("invalid_request","timer_input");
          let target:unknown;
          if(row.kind==="fcm") {
            if(typeof row.token!=="string"||row.token.length<16||row.token.length>4096||/[\s\u0000-\u001f\u007f]/.test(row.token))throw error("invalid_request","timer_input");target={transport:"fcm",token:row.token};
          } else {
            const subscription=record(row.subscription,"endpoint,expirationTime,keys"),keys=record(subscription.keys,"p256dh,auth");
            if(typeof subscription.endpoint!=="string"||subscription.endpoint.length>2048||typeof keys.p256dh!=="string"||typeof keys.auth!=="string"||!/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh)||!/^[A-Za-z0-9_-]{22}$/.test(keys.auth))throw error("invalid_request","timer_input");
            let endpoint:URL;try{endpoint=new URL(subscription.endpoint);}catch{throw error("invalid_request","timer_input");}if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.hash||endpoint.href!==subscription.endpoint)throw error("invalid_request","timer_input");
            if(subscription.expirationTime!==null && (!Number.isFinite(subscription.expirationTime)||(subscription.expirationTime as number)<0))throw error("invalid_request","timer_input");target={subscription};
          }
          request={path:channelBase,method:"POST",write:true,body:{installation_id:options.scope.installation,criteria:[...row.criteria].sort(),...(target as object)}};
          const bytes=new TextEncoder().encode(JSON.stringify(request.body));let digest:string;
          try{digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(value=>value.toString(16).padStart(2,"0")).join("");}finally{bytes.fill(0);}
          check();ctrl.signal.throwIfAborted();const previous=options.journal.read();previousChannel=previous;
          // Channel upserts have no operation receipt/CAS. Even same-target
          // replay cannot fence an earlier delayed upsert from resurrecting a
          // channel after deletion. Retire this grant through fresh approval.
          if(previous?.pending)throw error("outcome_unknown","timer_channel_reapproval_required");
          pending={grantId:options.grantId,kind:row.kind as "web_push"|"fcm",targetDigest:digest,channelId:previous?.channelId??null,pending:"register"};
        } else if(verb==="unregisterChannel" && args.length===1 && ["web_push","fcm"].includes(args[0] as string)) {
          if(!options.journal)throw error("upgrade_required","native_timer_channel_journal_unavailable");
          const previous=options.journal.read();previousChannel=previous;
          if(!previous){port.postMessage([1,scopeKey,generation,id,true,undefined]);return;}
          if(previous.pending==="register")throw error("outcome_unknown","timer_channel_reapproval_required");
          if(previous.kind!==args[0]||!previous.channelId)throw error("invalid_request","timer_channel_kind");
          pending={...previous,pending:"delete"};request={path:`${channelBase}/${previous.channelId}`,method:"DELETE",write:true};
        } else request=route(prefix,verb,args);
        write=request.write;
        const body=request.body===undefined?undefined:JSON.stringify(request.body);
        if(body && new TextEncoder().encode(body).length>MAX) throw error("invalid_request","timer_input");
        const bearer=await options.bearer();check();ctrl.signal.throwIfAborted();
        if(typeof bearer!=="string" || !/^(idev_|ct_)[A-Za-z0-9_-]{43}$/.test(bearer)) throw error("unauthenticated","timer_credential");
        if(pending){await options.journal!.write(pending);check();ctrl.signal.throwIfAborted();}
        dispatched=write;
        response=await options.fetch(`${options.cpOrigin}${request.path}`,{method:request.method,body,
          headers:{authorization:`Bearer ${bearer}`,...(body===undefined?{}:{"content-type":"application/json"})},
          credentials:"omit",redirect:"error",cache:"no-store",referrerPolicy:"no-referrer",signal:ctrl.signal});
        check();ctrl.signal.throwIfAborted();
        if(response.redirected)throw error("unavailable","timer_response");
        if(verb==="unregisterChannel" && response.status===204) {
          await options.journal!.write(null);check();ctrl.signal.throwIfAborted();port.postMessage([1,scopeKey,generation,id,true,undefined]);return;
        }
        if(response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json" || !response.body) throw error("unavailable","timer_response");
        const length=response.headers.get("content-length");if(length && /^\d+$/.test(length) && Number(length)>MAX) throw error("unavailable","timer_response");
        reader=response.body.getReader();
        for(;;){const result=await reader.read();try{check();ctrl.signal.throwIfAborted();if(result.done)break;if(count+result.value.length>MAX)throw error("unavailable","timer_response");bytes.set(result.value,count);count+=result.value.length;}finally{result.value?.fill(0);}}
        const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,count)));
        if(verb==="unregisterChannel" && response.status===404 && value?.error?.code==="channel_not_found") {
          await options.journal!.write(null);check();ctrl.signal.throwIfAborted();port.postMessage([1,scopeKey,generation,id,true,undefined]);return;
        }
        if(!response.ok) {
          if(response.status>=500) throw error("unavailable","timer_http");
          if(value?.error?.operation_outcome==="unknown") throw error("outcome_unknown","timer_write_unknown");
          if(pending){await options.journal!.write(previousChannel);check();ctrl.signal.throwIfAborted();}
          dispatched=false;
          throw mdbaseError(response.status===401||response.status===403?"unauthenticated":response.status===409?"conflict":response.status===404?"upgrade_required":response.status===429?"rate_limited":"invalid_request","Native timer request was refused.","timer_refused");
        }
        check();ctrl.signal.throwIfAborted();
        if(verb==="registerChannel") {
          if(typeof value?.channel_id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.channel_id))throw error("unavailable","timer_channel_response");
          await options.journal!.write({...pending!,channelId:value.channel_id,pending:null});check();ctrl.signal.throwIfAborted();
          port.postMessage([1,scopeKey,generation,id,true,{channelId:value.channel_id,installationId:options.scope.installation,criteria:(request.body as {criteria:string[]}).criteria}]);
        } else port.postMessage([1,scopeKey,generation,id,true,value]);
      } catch(cause) {
        const failure=dispatched?error("outcome_unknown","timer_write_unknown"):cause instanceof MdbaseError?cause:error(ctrl.signal.aborted?"cancelled":"unavailable","timer_request");
        if(!closed)port.postMessage([1,scopeKey,generation,id,false,failure.code,failure.reason]);
      } finally {
        clearTimeout(timer);ctrl.signal.removeEventListener("abort",cancelBody);bytes.fill(0);void(reader?.cancel()??response?.body?.cancel())?.catch(()=>{});reader?.releaseLock();if(slot?.id===id)slot=null;
      }
    });
    slot={id,ctrl,work};
  };
  port.addEventListener("message",receive);port.start();options.signal.addEventListener("abort",abort,{once:true});
  try{check();}catch(cause){void close();throw cause;}
  return Object.freeze({close});
}

/** UI fixed timer proxy, not another MdbaseClient or replica facade. */
export function appTimerPortClient(port:MessagePort,binding:{scope:Readonly<AppReplicaScope>;generation:string},options:{signal:AbortSignal;onClose():void}):AppTimersPort {
  const scopeKey=key(binding.scope),generation=binding.generation;let closed=false,sequence=0;
  let slot:{id:number;write:boolean;resolve(value:unknown):void;reject(cause:unknown):void;abort():void;signal?:AbortSignal}|null=null;
  const close=()=>{
    if(closed)return;closed=true;options.signal.removeEventListener("abort",close);
    const pending=slot;slot=null;pending?.signal?.removeEventListener("abort",pending.abort);
    pending?.reject(error(pending.write?"outcome_unknown":"cancelled","timer_port_closed"));
    try{port.postMessage([1,scopeKey,generation,"close"]);}finally{port.removeEventListener("message",receive);port.close();options.onClose();}
  };
  const receive=(event:MessageEvent<unknown>)=>{
    const frame=event.data;
    if(!Array.isArray(frame)||frame[0]!==1||frame[1]!==scopeKey||frame[2]!==generation){close();return;}
    if(frame.length===4&&frame[3]==="close"){close();return;}
    const pending=slot;
    if(!pending||frame[3]!==pending.id||!(frame.length===6&&frame[4]===true||frame.length===7&&frame[4]===false&&typeof frame[5]==="string"&&isErrorCode(frame[5]))){close();return;}
    slot=null;pending.signal?.removeEventListener("abort",pending.abort);
    if(frame[4])pending.resolve(frame[5]);else pending.reject(mdbaseError(frame[5],"Native timer request could not complete.",typeof frame[6]==="string"?frame[6]:undefined));
  };
  const run=(verb:string,args:unknown[],request:TimerRequestOptions,channel=false):Promise<unknown>=>{
    if(closed||options.signal.aborted||request.signal?.aborted)return Promise.reject(error("cancelled","timer_port_closed"));
    if(slot||channelBusy&&!channel)return Promise.reject(error("unavailable","timer_port_busy"));
    if(sequence>=Number.MAX_SAFE_INTEGER){close();return Promise.reject(error("unavailable","timer_port_closed"));}
    const id=++sequence,write=verb!=="list"&&verb!=="lookupOperation"&&verb!=="vapid";
    return new Promise((resolve,reject)=>{
      const abort=()=>{try{port.postMessage([1,scopeKey,generation,id,"cancel"]);}catch{close();}reject(error(write?"outcome_unknown":"cancelled","timer_request_cancelled"));};
      slot={id,write,resolve,reject,abort,signal:request.signal};request.signal?.addEventListener("abort",abort,{once:true});
      try{if(new TextEncoder().encode(JSON.stringify(args)).length>MAX)throw error("invalid_request","timer_input");port.postMessage([1,scopeKey,generation,id,verb,args]);}catch(cause){slot=null;request.signal?.removeEventListener("abort",abort);reject(cause);}
    });
  };
  let channelBusy=false;
  const check=()=>{if(closed||options.signal.aborted)throw error("cancelled","timer_port_closed");};
  const criteria=(input:readonly string[]|undefined)=>{
    if(!input?.length||input.length>100||input.some(value=>typeof value!=="string"||!value.length||value.length>100)||new Set(input).size!==input.length)throw error("invalid_request","timer_channel_criteria_required");
    return [...input].sort();
  };
  const registration=(value:unknown,expected:readonly string[]):TimerChannelRegistration=>{
    const row=record(value,"channelId,installationId,criteria");
    if(typeof row.channelId!=="string"||row.installationId!==binding.scope.installation||JSON.stringify(row.criteria)!==JSON.stringify(expected))throw error("outcome_unknown","timer_channel_response");
    return {channelId:row.channelId,installationId:binding.scope.installation,criteria:[...expected]};
  };
  const workflow=async<T>(request:TimerRequestOptions,work:()=>Promise<T>):Promise<T>=>{
    check();request.signal?.throwIfAborted();if(channelBusy||slot)throw error("unavailable","timer_port_busy");channelBusy=true;
    try{return await work();}finally{channelBusy=false;}
  };
  const registerWebPush=(request:ResolvedWebPushChannelOptions)=>workflow(request,async()=>{
    const chosen=criteria(request.criteria);if(request.installationId!==undefined&&request.installationId!==binding.scope.installation)throw error("invalid_request","timer_channel_installation");
    const worker=request.serviceWorker;
    if(!worker?.pushManager||typeof worker.pushManager.getSubscription!=="function"||typeof worker.pushManager.subscribe!=="function")throw error("invalid_request","timer_push_platform");
    const value=await run("vapid",[],request,true) as {public_key?:unknown};check();request.signal?.throwIfAborted();
    if(typeof value.public_key!=="string"||!/^[A-Za-z0-9_-]{87}$/.test(value.public_key))throw error("unavailable","timer_vapid_response");
    const raw=atob(value.public_key.replace(/-/g,"+").replace(/_/g,"/")),key=Uint8Array.from(raw,value=>value.charCodeAt(0));
    if(key.length!==65||key[0]!==4||btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==value.public_key)throw error("unavailable","timer_vapid_response");
    let subscription=await worker.pushManager.getSubscription();check();request.signal?.throwIfAborted();
    if(subscription){const existing=subscription.options.applicationServerKey;if(!existing||existing.byteLength!==key.length||new Uint8Array(existing).some((value,index)=>value!==key[index]))throw error("invalid_request","timer_push_key_changed");}
    if(!subscription){subscription=await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      if(closed||options.signal.aborted||request.signal?.aborted){await subscription.unsubscribe();throw error("cancelled","timer_port_closed");}}
    const target=subscription.toJSON();
    return registration(await run("registerChannel",[{kind:"web_push",criteria:chosen,subscription:{endpoint:target.endpoint,expirationTime:target.expirationTime??null,keys:target.keys}}],request,true),chosen);
  });
  const registerFcm=(request:FcmChannelOptions)=>workflow(request,async()=>{
    const chosen=criteria(request.criteria);if(request.installationId!==undefined&&request.installationId!==binding.scope.installation)throw error("invalid_request","timer_channel_installation");
    return {...registration(await run("registerChannel",[{kind:"fcm",criteria:chosen,token:request.token}],request,true),chosen),transport:"fcm" as const};
  });
  const unregisterWebPush=(worker:ServiceWorkerRegistration|undefined,request:TimerRequestOptions)=>workflow(request,async()=>{
    await run("unregisterChannel",["web_push"],request,true);check();request.signal?.throwIfAborted();
    if(worker){const subscription=await worker.pushManager.getSubscription();check();request.signal?.throwIfAborted();if(subscription)await subscription.unsubscribe();check();request.signal?.throwIfAborted();}
  });
  port.addEventListener("message",receive);port.start();options.signal.addEventListener("abort",close,{once:true});if(options.signal.aborted)close();
  return Object.freeze<AppTimersPort>({
    list:(ns,o)=>run("list",[ns],o),put:(ns,id,body,o)=>run("put",[ns,id,body],o),cancel:(ns,id,generation,o)=>run("cancel",[ns,id,generation],o),
    reconcile:(ns,body,o)=>run("reconcile",[ns,body],o),reconcileWithReceipt:(ns,body,o)=>run("reconcileWithReceipt",[ns,body],o),lookupOperation:(ns,id,o)=>run("lookupOperation",[ns,id],o),
    registerWebPush,unregisterWebPush,registerFcm,unregisterFcm:request=>workflow(request,async()=>{await run("unregisterChannel",["fcm"],request,true);}),close
  });
}
