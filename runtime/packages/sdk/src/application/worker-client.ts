import {isAppOpeningProgress} from "../app-host/opening-progress.js";
import {nativeAuthorizationCall, type NativeAuthorizationCall, type NativeAuthorizationResult} from "./native-authorization-rpc.js";
import type {AppWebCollectionHandoff} from "../app-host/web-collection.js";
import type {AppWebSignInPortal,AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import {APPLICATION_WORKER_MAX_ID,APPLICATION_WORKER_PROTOCOL,ApplicationWorkerError,applicationWorkerBinding,applicationWorkerRequest,type ApplicationWorkerAction,type ApplicationWorkerPayload} from "./worker-protocol.js";

/** SDK-private UI transport. These callbacks are SDK owners, never application
 * constructor options. Native physical stop must ACK before releaseWorker. */
export interface ApplicationWorkerClientOwner {
  snapshot(value:AppWebSignInSnapshot):void;
  handoff(value:AppWebCollectionHandoff,caller:AbortSignal):Promise<void>;
  /** Ports for the collection another tab opened (or that was open when this
   * tab attached): not the reply to any request of this tab. */
  attached?(value:AppWebCollectionHandoff):void;
  nativeAuthorization?(call:NativeAuthorizationCall,portal:AppWebSignInPortal,signal:AbortSignal):Promise<NativeAuthorizationResult>;
  releaseWorker():void;
  failed?(error:ApplicationWorkerError):void;
}
export class ApplicationWorkerReplyError extends Error {
  constructor(readonly code:string){super("SDK application operation unavailable");this.name="ApplicationWorkerReplyError";}
}
interface Slot {
  readonly id:number;readonly caller:AbortSignal;readonly done:Promise<void>;finish():void;
  resolve(value:AppWebSignInSnapshot):void;reject(error:unknown):void;
  cancel():void;fenced:boolean;reply:boolean;handoff:Promise<void>|null;
}
function nativeSnapshot(value:unknown):AppWebSignInSnapshot {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ApplicationWorkerError("application_worker_binding");
  const snapshot=value as AppWebSignInSnapshot;
  if(!["not_started","starting","signed_out","authorizing","unselected","opening","setup_required","ready","blocked","closed"].includes(snapshot.status)||
    !(snapshot.openingProgress==null||typeof snapshot.openingProgress==="string")||
    !Array.isArray(snapshot.collections)||snapshot.collections.length>1024||!(snapshot.selectedCollectionId===null||typeof snapshot.selectedCollectionId==="string")||
    !(snapshot.problem===null||(typeof snapshot.problem==="string"&&/^[a-z0-9_-]{1,128}$/.test(snapshot.problem))))throw new ApplicationWorkerError("application_worker_binding");
  return Object.freeze({...snapshot,openingProgress:isAppOpeningProgress(snapshot.openingProgress)?snapshot.openingProgress:null});
}
/** One original operation slot, no queue/retry/cancel RPC. Caller cancellation
 * rejects delivery only; the original slot remains until reply AND handoff drain.
 * Terminal close is the sole permitted interrupt and retains failed ownership. */
export class ApplicationWorkerClient {
  private readonly port:MessagePort;private readonly binding:string;private readonly owner:ApplicationWorkerClientOwner;
  private nextId=0;private active:Slot|null=null;private portal:{id:number;value:AppWebSignInPortal;caller:AbortSignal;life:AbortController;lastRpc:number;busy:boolean}|null=null;
  private fault:ApplicationWorkerError|null=null;private stopping:Promise<void>|null=null;
  private stopReply:{id:number;resolve():void;reject(error:unknown):void}|null=null;
  private watch:ReturnType<typeof setInterval>|null=null;
  private abandoned=false;
  constructor(port:MessagePort,binding:string,owner:ApplicationWorkerClientOwner){
    if(!applicationWorkerBinding(binding))throw new ApplicationWorkerError("application_worker_binding");
    this.port=port;this.binding=binding;this.owner=Object.freeze({...owner});
    port.addEventListener("message",this.message);port.addEventListener("messageerror",this.messageError);port.start();
  }
  private id():number {if(this.nextId===APPLICATION_WORKER_MAX_ID)throw new ApplicationWorkerError("application_worker_stop_failed");return ++this.nextId;}
  private send(id:number,action:ApplicationWorkerAction,payload:ApplicationWorkerPayload):void {
    const request=applicationWorkerRequest([APPLICATION_WORKER_PROTOCOL,this.binding,id,action,payload],this.binding);
    try{this.port.postMessage(request);}catch{this.quarantine("application_worker_unavailable");throw this.fault;}
  }
  request(action:Exclude<ApplicationWorkerAction,"close"|"foreground">,payload:Exclude<ApplicationWorkerPayload,boolean>,caller:AbortSignal,portal?:AppWebSignInPortal):Promise<AppWebSignInSnapshot>{
    if(this.fault||this.stopping||caller.aborted)return Promise.reject(this.fault??new ApplicationWorkerError("application_worker_fenced"));
    if(this.active)return Promise.reject(new ApplicationWorkerError("application_worker_busy"));
    let id:number;try{id=this.id();applicationWorkerRequest([APPLICATION_WORKER_PROTOCOL,this.binding,id,action,payload],this.binding);}catch(error){return Promise.reject(error);}
    if(portal){
      if(!["authorize","renewExpiredPairing","requestFileAccess"].includes(action))return Promise.reject(new ApplicationWorkerError("application_worker_binding"));
      this.portal?.life.abort();
      try{this.portal?.value.close();}catch{this.quarantine("application_worker_stop_failed");return Promise.reject(this.fault);}
      this.portal={id,value:portal,caller,life:new AbortController(),lastRpc:0,busy:false};this.watchPortal();
    }
    let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
    return new Promise((resolve,reject)=>{
      const slot:Slot={id,caller,done,finish,resolve,reject,fenced:false,reply:false,handoff:null,cancel:()=>{
        slot.fenced=true;reject(new ApplicationWorkerError("application_worker_fenced"));
        // Keep original active slot and all original operations until reply/drain.
      }};
      this.active=slot;caller.addEventListener("abort",slot.cancel,{once:true});
      try{this.send(id,action,payload);}catch(error){reject(error);/* quarantine retains slot */}
      if(caller.aborted)slot.cancel();
    });
  }
  /** SDK lifecycle delivery cancellation must not free its enclosing action
   * before this SAME original transport slot finishes reply/handoff drain. */
  drain():Promise<void>{return this.fault?Promise.reject(this.fault):this.active?.done??Promise.resolve();}
  setForeground(value:boolean):void {if(!this.stopping&&!this.fault)this.send(0,"foreground",value);}
  /** While this client holds the approval window, report once (one-way ID0)
   * that it was closed. Every SDK close releases `this.portal` first, so a
   * window still held here was closed by the person or by Connect itself. */
  private watchPortal():void {
    if(this.watch!==null)clearInterval(this.watch);this.watch=null;
    const held=this.portal;if(!held||!("closed" in held.value))return;
    this.watch=setInterval(()=>{
      if(this.portal!==held||this.stopping||this.fault){clearInterval(this.watch!);this.watch=null;return;}
      let closed=false;try{closed=held.value.closed===true;}catch{/* unknown is not closed */}
      if(!closed)return;
      clearInterval(this.watch!);this.watch=null;
      if(held.lastRpc===0)this.portal=null;
      try{this.send(0,"approvalClosed",true);}catch{/* send quarantined the client */}
    },500);
  }
  private readonly messageError=()=>this.quarantine("application_worker_unavailable");
  private quarantine(code:ApplicationWorkerError["code"]):void {
    if(this.fault)return;this.fault=new ApplicationWorkerError(code);
    if(this.active){this.active.fenced=true;this.active.reject(this.fault);}
    this.stopReply?.reject(this.fault);
    try{this.owner.failed?.(this.fault);}catch{/* notification cannot release quarantined ownership */}
    // Neither terminate nor detach: physical stop is unconfirmed; original owner
    // and ports remain held. No replacement Worker and no manufactured success.
  }
  private readonly message=(event:MessageEvent<unknown>)=>{
    try{
      const data=event.data;
      if(!Array.isArray(data)||data.length!==5||data[0]!==APPLICATION_WORKER_PROTOCOL||data[1]!==this.binding||!Number.isInteger(data[3])||data[3]<0||data[3]>APPLICATION_WORKER_MAX_ID)throw new ApplicationWorkerError("application_worker_binding");
      if(this.fault)return;
      const [,,kind,id,value]=data;
      if(kind==="nativeSnapshot"){
        if(id!==0)throw new ApplicationWorkerError("application_worker_binding");
        const snapshot=nativeSnapshot(value);if(!this.stopping)this.owner.snapshot(snapshot);return;
      }
      if(kind==="fatal"){if(id!==0)throw new ApplicationWorkerError("application_worker_binding");this.quarantine("application_worker_stop_failed");return;}
      if(kind==="nativeAuthorization"){
        const call=nativeAuthorizationCall(value),held=this.portal;
        if(!held||held.id!==id||this.stopping||held.caller.aborted||call.rpc<=held.lastRpc)throw new ApplicationWorkerError("application_worker_fenced");
        held.lastRpc=call.rpc;
        if(call.action==="cancel")held.life.abort();
        else if(held.busy)throw new ApplicationWorkerError("application_worker_binding");
        if(call.action!=="cancel")held.busy=true;
        const signal=AbortSignal.any([held.caller,held.life.signal]);
        void Promise.resolve().then(()=>{
          if(!this.owner.nativeAuthorization)throw new ApplicationWorkerError("application_worker_unavailable");
          return this.owner.nativeAuthorization(call,held.value,signal);
        }).then(result=>{
          if(signal.aborted||this.portal!==held||this.stopping)throw new ApplicationWorkerError("application_worker_fenced");
          this.port.postMessage([APPLICATION_WORKER_PROTOCOL,this.binding,"nativeAuthorizationReply",id,{rpc:call.rpc,ok:true,value:result}]);
        },()=>{this.port.postMessage([APPLICATION_WORKER_PROTOCOL,this.binding,"nativeAuthorizationReply",id,{rpc:call.rpc,ok:false}]);})
          .catch(()=>{try{this.port.postMessage([APPLICATION_WORKER_PROTOCOL,this.binding,"nativeAuthorizationReply",id,{rpc:call.rpc,ok:false}]);}catch{/* original stop */}}).finally(()=>{held.busy=false;});
        return;
      }
      if(kind==="portal"){
        if(!value||!["navigate","close"].includes(value.action))throw new ApplicationWorkerError("application_worker_binding");
        const portal=this.portal;if(!portal||portal.id!==id)return; // old original reservation already closed, never reused
        if(value.action==="close"){portal.life.abort();portal.value.close();this.portal=null;}
        else {if(this.stopping||typeof value.uri!=="string"||value.uri.length>8192)throw new ApplicationWorkerError("application_worker_binding");portal.value.navigate(value.uri);}
        return;
      }
      if(kind==="handoff"&&id===0){
        if(!value||value.schema!=="mdbn-app-collection/1")throw new ApplicationWorkerError("application_worker_binding");
        const ports=[value.dataPort,value.controlPort,...(value.timerPort?[value.timerPort]:[])];
        if(ports.some(port=>!(port instanceof MessagePort)))throw new ApplicationWorkerError("application_worker_binding");
        if(this.stopping||!this.owner.attached){for(const port of ports)port.close();return;}
        this.owner.attached(value as AppWebCollectionHandoff);return;
      }
      if(kind==="handoff"){
        const slot=this.active;
        if(!slot||slot.id!==id||slot.reply||slot.handoff)throw new ApplicationWorkerError("application_worker_binding");
        if(this.stopping){
          // A transferred original handoff may already be in flight when close
          // fences UI delivery. Drain those received ports, not a new client.
          if(!value||value.schema!=="mdbn-app-collection/1")throw new ApplicationWorkerError("application_worker_binding");
          for(const port of [value.dataPort,value.controlPort,...(value.timerPort?[value.timerPort]:[])]){
            if(!(port instanceof MessagePort))throw new ApplicationWorkerError("application_worker_binding");port.close();
          }
          slot.handoff=Promise.resolve();return;
        }
        // Dispatch immediately; native HELLO/port traffic may be required before
        // the original Worker operation replies. Do not wait for a new RPC.
        slot.handoff=Promise.resolve().then(()=>this.owner.handoff(value as AppWebCollectionHandoff,slot.caller));
        void slot.handoff.catch(()=>{});return;
      }
      if(kind!=="reply"||!value||typeof value.ok!=="boolean"||(!value.ok&&(!value.problem||typeof value.problem.code!=="string"||value.problem.code.length>128)))throw new ApplicationWorkerError("application_worker_binding");
      const stop=this.stopReply;if(stop&&stop.id===id){
        if(value.ok){const closed=nativeSnapshot(value.snapshot);if(closed.status!=="closed"||closed.selectedCollectionId!==null)throw new ApplicationWorkerError("application_worker_stop_failed");stop.resolve();}else stop.reject(new ApplicationWorkerError("application_worker_stop_failed"));return;
      }
      const slot=this.active;if(!slot||slot.id!==id||slot.reply)throw new ApplicationWorkerError("application_worker_binding");
      slot.reply=true;const snapshot=value.ok?nativeSnapshot(value.snapshot):null;
      void this.settle(slot,snapshot,value.ok?null:Object.freeze({code:value.problem.code}));
    }catch{this.quarantine("application_worker_binding");}
  };
  private async settle(slot:Slot,snapshot:AppWebSignInSnapshot|null,problem:{readonly code:string}|null):Promise<void>{
    try{
      await slot.handoff;
      if(slot.fenced||slot.caller.aborted||this.stopping||this.fault)throw this.fault??new ApplicationWorkerError("application_worker_fenced");
      if(problem)throw new ApplicationWorkerReplyError(problem.code);
      if(snapshot)slot.resolve(snapshot);
    }catch(error){slot.reject(error);}finally{
      slot.caller.removeEventListener("abort",slot.cancel);if(this.active===slot)this.active=null;slot.finish();
    }
  }
  /** Synchronous page-lifecycle stop (pagehide: the page may be frozen in the
   * back/forward cache before any reply could arrive). Fences every slot,
   * releases the portal and terminates the Worker at once, which frees the
   * Web Locks/OPFS handles it holds, exactly as closing the tab would. The
   * native store is crash-safe; no terminal ACK is awaited. Single use. */
  abandon():void {
    if(this.abandoned)return;this.abandoned=true;
    if(!this.fault)this.fault=new ApplicationWorkerError("application_worker_fenced");
    if(this.watch!==null){clearInterval(this.watch);this.watch=null;}
    const active=this.active;if(active){active.fenced=true;active.reject(this.fault);active.finish();this.active=null;}
    this.stopReply?.reject(this.fault);this.stopReply=null;
    this.portal?.life.abort();
    try{this.portal?.value.close();}catch{/* the page is leaving; the window is not reused */}this.portal=null;
    try{this.owner.releaseWorker();}catch{/* terminate is best effort; the page owns no other stop */}
    this.port.removeEventListener("message",this.message);this.port.removeEventListener("messageerror",this.messageError);this.port.close();
  }
  close():Promise<void>{
    if(this.stopping)return this.stopping;
    const active=this.active;if(active){active.fenced=true;active.reject(new ApplicationWorkerError("application_worker_fenced"));}
    this.stopping=Promise.resolve().then(async()=>{
      if(this.fault)throw new ApplicationWorkerError("application_worker_stop_failed");
      this.portal?.life.abort();this.portal?.value.close();this.portal=null;
      const id=this.id();await new Promise<void>((resolve,reject)=>{this.stopReply={id,resolve,reject};try{this.send(id,"close",null);}catch(error){reject(error);}});
      await active?.done;
      if(this.fault)throw new ApplicationWorkerError("application_worker_stop_failed");
      this.owner.releaseWorker();
      this.port.removeEventListener("message",this.message);this.port.removeEventListener("messageerror",this.messageError);this.port.close();
    }).catch(error=>{this.quarantine("application_worker_stop_failed");throw error;});
    return this.stopping;
  }
}
