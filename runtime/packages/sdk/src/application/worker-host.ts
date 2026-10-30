import {nativeAuthorizationCall,nativeAuthorizationReply,nativePreparation,type NativeAuthorizationCall,type NativeAuthorizationResult} from "./native-authorization-rpc.js";
import type {AppNativeAuthorizationPort} from "../app-host/native-sign-in.js";
import type {NativeCompletion} from "../app-grant/native-completion.js";
import {applicationWorkerSession} from "./worker-session.js";
import type {ApplicationDeclarationSnapshot} from "./declaration.js";
import type {PackagedApplicationNativeAssets} from "./native-assets.js";
import type {AppLockPort} from "../app-host/owner.js";
import type {AppWebCollectionHandoff} from "../app-host/web-collection.js";
import type {AppWebSignInPortal} from "../app-host/web-sign-in-session.js";
import type {AppFileAction} from "../app-host/installation-sign-in.js";
import {APPLICATION_WORKER_PROTOCOL,ApplicationWorkerError,applicationWorkerBinding,applicationWorkerProblem,applicationWorkerRequest,
  type ApplicationWorkerEvent,type ApplicationWorkerProblem,type ApplicationWorkerRequest} from "./worker-protocol.js";
import {webSignInProblem} from "../app-host/web-sign-in-problem.js";

/** A failed operation's bounded reply code. Native app-host errors (setup journal,
 * cloud-copy create, join, HTTP log, replica owner) keep their typed code, e.g.
 * `outcome_unknown` or `open_in_another_tab`, instead of reading as an
 * unavailable Worker. Same vocabulary as the session snapshot's problem. */
export function applicationWorkerReplyProblem(error:unknown):ApplicationWorkerProblem {
  const problem=applicationWorkerProblem(error);
  if(problem.code!=="application_worker_unavailable")return problem;
  const native=webSignInProblem(error).problem;
  return native==="open_failed"?problem:Object.freeze({code:native});
}

/** Tabs that may attach to one Worker: the leader tab plus followers. */
export const APPLICATION_WORKER_MAX_CLIENTS=32;
interface HostClient {
  readonly port:MessagePort;readonly binding:string;readonly primary:boolean;
  lastId:number;foreground:boolean;gone:boolean;
  /** The collection this tab shows (its URL selection); null: none. */
  selected:string|null;
  /** The connection generation whose ports this tab holds, its handoff and collection. */
  generation:string|null;handoff:AppWebCollectionHandoff|null;collection:string|null;
  readonly onMessage:(event:MessageEvent<unknown>)=>void;readonly onMessageError:()=>void;
}
type Queued={readonly client:HostClient;readonly request:ApplicationWorkerRequest;readonly job?:undefined}
  /** Internal work (closing collections no tab shows), in turn with requests. */
  |{readonly client:null;readonly request:null;readonly job:()=>Promise<void>};

/** SDK-private lifecycle owner, distinct from the existing native CONTROL
 * channel. One session for every tab of this app in this browser: the leader
 * tab's port (primary) plus follower tabs attached by the leader page. Requests
 * from all tabs run one at a time, in order. Each tab selects its own
 * collection: the session holds every collection some tab shows, each tab gets
 * the shared sign-in state with its own collection's status, and its own
 * data/control/timer ports onto that collection. A collection no tab shows any
 * more is closed. No record
 * RPC, retry, authority loan or replacement client. The public entry resolves
 * registration before boot/start; constructing this owner does not open a
 * profile or initialize native/SQL. */
export class ApplicationWorkerHost {
  readonly session:ReturnType<typeof applicationWorkerSession>["session"];
  private readonly lifetime=new AbortController();
  private readonly primary:HostClient;
  private readonly clients=new Map<string,HostClient>();
  private readonly queue:Queued[]=[];
  private active:Queued|null=null;
  private pending:Promise<void>|null=null;
  private stopping:Promise<void>|null=null;
  private readonly appliedForeground=new Map<string,string>();private sessionForeground:boolean|null=null;
  private collecting=false;private revalidationQueued=false;
  private nativeRpc=0;
  private nativeWait:{rpc:number;id:number;client:HostClient;resolve(value:NativeAuthorizationResult):void;reject(error:unknown):void}|null=null;
  /** The latest proxy portal's person-closed report (page `approvalClosed`). */
  private approval:{reported:boolean;readonly client:HostClient}|null=null;
  private unsubscribe:(()=>void)|null=null;
  constructor(port:MessagePort,binding:string,declaration:Readonly<ApplicationDeclarationSnapshot>,packaged:PackagedApplicationNativeAssets,locks:AppLockPort|undefined,storageNamespace:string|null,fetcher?:typeof fetch){
    if(!applicationWorkerBinding(binding))throw new ApplicationWorkerError("application_worker_binding");
    const composed=applicationWorkerSession(declaration,packaged,{signal:this.lifetime.signal,locks,storageNamespace,
      openPortal:()=>this.portal(),handoff:value=>this.handoff(value),...(fetcher?{fetch:fetcher}:{})});
    this.session=composed.session;
    this.primary=this.client(port,binding,true);
    this.unsubscribe=this.session.subscribe(()=>{
      this.applyForeground();if(this.stopping)return;
      // Signed out: no tab shows a collection any more.
      if(this.session.getSnapshot().status==="signed_out")for(const client of this.clients.values())this.leave(client);
      for(const client of [...this.clients.values()])this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"nativeSnapshot",0,this.view(client)]);
      this.reconcile();
    });
    this.post(this.primary,[APPLICATION_WORKER_PROTOCOL,binding,"nativeSnapshot",0,this.view(this.primary)]);
  }
  /** What one tab sees: the shared sign-in with its own collection. A tab that
   * did not start an approval in progress keeps showing its open collection. */
  private view(client:HostClient){return this.session.viewFor(client.selected,{bystander:this.approval?.client!==client});}
  private client(port:MessagePort,binding:string,primary:boolean):HostClient {
    const client:HostClient={port,binding,primary,lastId:0,foreground:primary,gone:false,selected:null,generation:null,handoff:null,collection:null,
      onMessage:event=>this.onMessage(client,event),onMessageError:()=>primary?this.failStop("application_worker_unavailable"):this.detach(client)};
    this.clients.set(binding,client);
    port.addEventListener("message",client.onMessage);port.addEventListener("messageerror",client.onMessageError);port.start();
    return client;
  }
  /** The leader page attached a follower tab on its own port. */
  attach(port:MessagePort,binding:string):void {
    if(this.stopping||this.lifetime.signal.aborted||!applicationWorkerBinding(binding)||this.clients.has(binding)||this.clients.size>=APPLICATION_WORKER_MAX_CLIENTS){port.close();return;}
    const client=this.client(port,binding,false);
    this.post(client,[APPLICATION_WORKER_PROTOCOL,binding,"nativeSnapshot",0,this.view(client)]);
    this.reconcile();
  }
  /** The leader page saw a follower tab leave (or it closed its own client). */
  detachClient(binding:string):void {const client=this.clients.get(binding);if(client&&!client.primary)this.detach(client);}
  private detach(client:HostClient):void {
    if(client.gone||client.primary)return;
    client.gone=true;this.clients.delete(client.binding);
    if(this.nativeWait?.client===client){const slot=this.nativeWait;this.nativeWait=null;slot.reject(new ApplicationWorkerError("application_worker_fenced"));}
    for(let i=this.queue.length-1;i>=0;i--)if(this.queue[i]!.client===client)this.queue.splice(i,1);
    this.leave(client);
    client.port.removeEventListener("message",client.onMessage);client.port.removeEventListener("messageerror",client.onMessageError);client.port.close();
    this.applyForeground();this.collect();
  }
  /** The tab stops showing its collection: its follower ports go (the
   * collection stays open while another tab shows it). */
  private leave(client:HostClient):void {
    const handoff=client.handoff,collection=client.collection;
    client.selected=null;client.handoff=null;client.generation=null;client.collection=null;
    if(!handoff||collection===null)return;
    const connection=this.session.connection(collection);
    if(connection?.generation===handoff.generation)try{connection.detach?.(handoff);}catch{/* closed with the connection */}
  }
  /** Give every tab without ports for its open collection its own. */
  private reconcile():void {
    if(this.stopping)return;
    for(const client of [...this.clients.values()]){
      if(client.gone||client.selected===null)continue;
      const connection=this.session.connection(client.selected);
      if(!connection?.isCurrent()||typeof connection.attach!=="function"||client.generation===connection.generation)continue;
      const value=connection.attach();if(!value)continue;
      client.generation=connection.generation;client.handoff=value;client.collection=client.selected;
      // An unsolicited handoff is adopted against this tab's latest selection.
      this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"nativeSnapshot",0,this.view(client)]);
      this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"handoff",0,value],[value.dataPort,value.controlPort,...(value.timerPort?[value.timerPort]:[])]);
    }
  }
  /** Close, in turn with requests, each held collection no tab shows. */
  private collect():void {
    if(this.stopping||this.collecting)return;
    const shown=new Set<string>();for(const client of this.clients.values())if(!client.gone&&client.selected!==null)shown.add(client.selected);
    if(!this.session.heldCollections().some(id=>!shown.has(id)))return;
    this.collecting=true;
    this.queue.push({client:null,request:null,job:async()=>{
      this.collecting=false;
      const shown=new Set<string>();for(const client of this.clients.values())if(!client.gone&&client.selected!==null)shown.add(client.selected);
      for(const id of this.session.heldCollections())if(!shown.has(id))await this.session.releaseCollection(id);
    }});
    this.pump();
  }
  private post(client:HostClient,value:ApplicationWorkerEvent,transfer:Transferable[]=[]):void {
    if(client.gone)return;
    try{client.port.postMessage(value,transfer);}catch{
      // A follower's delivery failure detaches that tab only. The leader's is
      // not permission to drop ownership or unlock SQL.
      if(!client.primary){this.detach(client);return;}
      void this.stop().catch(()=>{});throw new ApplicationWorkerError("application_worker_unavailable");
    }
  }
  private portal():AppWebSignInPortal {
    const owner=this.active;
    if(!owner||owner.client===null||!["authorize","renewExpiredPairing","requestFileAccess"].includes(owner.request[3])||this.stopping)throw new ApplicationWorkerError("application_worker_fenced");
    const id=owner.request[2],client=owner.client;
    let closed=false;const approval={reported:false,client};this.approval=approval;
    const nativeAuthorization:AppNativeAuthorizationPort={
      prepare:async(context,signal)=>nativePreparation(await this.nativeCall(client,id,{action:"prepare",value:context},signal)),
      finish:async(selection,signal)=>await this.nativeCall(client,id,{action:"finish",value:selection},signal) as NativeCompletion,
      cancel:()=>{if(!client.gone && !this.stopping)this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"nativeAuthorization",id,{rpc:++this.nativeRpc,action:"cancel",value:null}]);},
    };
    return Object.freeze({nativeAuthorization,get closed(){return approval.reported;},navigate:(uri:string)=>{
      if(closed||this.stopping||this.lifetime.signal.aborted||client.gone)throw new ApplicationWorkerError("application_worker_fenced");
      this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"portal",id,{action:"navigate",uri}]);
    },close:()=>{if(closed)return;closed=true;this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"portal",id,{action:"close"}]);}});
  }
  private nativeCall(client:HostClient,id:number,call:Omit<NativeAuthorizationCall,"rpc">,signal:AbortSignal):Promise<NativeAuthorizationResult>{
    if(this.nativeWait || signal.aborted || client.gone || this.stopping || this.approval?.client!==client)return Promise.reject(new ApplicationWorkerError("application_worker_fenced"));
    const value=nativeAuthorizationCall({...call,rpc:++this.nativeRpc});
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{signal.removeEventListener("abort",abort);this.lifetime.signal.removeEventListener("abort",abort);};
      const abort=()=>{cleanup();if(this.nativeWait===wait)this.nativeWait=null;reject(new ApplicationWorkerError("application_worker_fenced"));};
      const wait={rpc:value.rpc,id,client,resolve:(v:NativeAuthorizationResult)=>{cleanup();resolve(v);},reject:(e:unknown)=>{cleanup();reject(e);}};
      this.nativeWait=wait;signal.addEventListener("abort",abort,{once:true});
      this.lifetime.signal.addEventListener("abort",abort,{once:true});
      try{this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"nativeAuthorization",id,value]);}catch(e){this.nativeWait=null;wait.reject(e);}
    });
  }
  private handoff(value:AppWebCollectionHandoff):void {
    if(this.stopping||this.lifetime.signal.aborted)throw new ApplicationWorkerError("application_worker_fenced");
    // The tab whose request opened it; else (a server-directed reopen) a tab showing it.
    const id=value.scope.collection,owner=this.active?.client;
    const client=owner&&!owner.gone&&owner.selected===id?owner:[...this.clients.values()].find(other=>!other.gone&&other.selected===id);
    if(!client)throw new ApplicationWorkerError("application_worker_fenced");
    client.generation=value.generation;client.handoff=value;client.collection=id;
    // Transfer ALL original present ports. Native adapter owns cleanup if the
    // delivery throws; never keep/reconstruct a second facade/engine.
    this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"handoff",client===owner?this.active!.request![2]:0,value],[value.dataPort,value.controlPort,...(value.timerPort?[value.timerPort]:[])]);
  }
  /** Visible in any tab. */
  private get foreground():boolean{for(const client of this.clients.values())if(client.foreground)return true;return false;}
  /** One inventory read, in the SAME queue as lifecycle actions. Visibility and
   * native transport wake immediately; metadata cannot make a tab's start/select
   * fail busy or overlap an original consent/receipt operation. */
  private revalidateForeground():void {
    if(this.stopping||this.revalidationQueued)return;
    this.revalidationQueued=true;
    this.queue.push({client:null,request:null,job:async()=>{
      try{
        if(this.foreground&&this.session.getSnapshot().signIn?.state==="paired")await this.session.refreshCollectionList();
      }finally{this.revalidationQueued=false;}
    }});
    this.pump();
  }
  /** `wake`: a page reported visible/focus/online, so a visible connection
   * syncs now even if it was already in the foreground. `report`: a tab told
   * us, so the session hears it even when the aggregate did not change. */
  private applyForeground(wake=false,report=false):void {
    if(this.stopping)return;
    const foreground=this.foreground;
    if(report||this.sessionForeground!==foreground){this.sessionForeground=foreground;try{this.session.setForeground(foreground);}catch{/* a closing session ignores it */}}
    // Each open collection syncs in the foreground while a tab showing it is visible.
    for(const id of this.session.heldCollections()){
      const connection=this.session.connection(id);
      if(!connection?.isCurrent()){this.appliedForeground.delete(id);continue;}
      let shown=false;for(const client of this.clients.values())if(client.selected===id&&client.foreground)shown=true;
      const key=`${connection.generation}:${shown}`;
      if(this.appliedForeground.get(id)===key&&!(wake&&shown))continue;
      connection.setForeground(shown);this.appliedForeground.set(id,key);
    }
    for(const id of [...this.appliedForeground.keys()])if(!this.session.heldCollections().includes(id))this.appliedForeground.delete(id);
    if(report&&foreground)this.revalidateForeground();
  }
  private failStop(code:"application_worker_binding"|"application_worker_unavailable"):void {
    try{this.post(this.primary,[APPLICATION_WORKER_PROTOCOL,this.primary.binding,"fatal",0,{code}]);}catch{/* original stop owns delivery failure */}
    void this.stop().catch(()=>{});
  }
  /** A malformed message from the leader stops the Worker; from a follower it
   * detaches that tab. */
  private refuse(client:HostClient):void {if(client.primary)this.failStop("application_worker_binding");else this.detach(client);}
  private onMessage(client:HostClient,event:MessageEvent<unknown>):void {
    if(client.gone)return;
    let request:ApplicationWorkerRequest;
    try{
      const frame=event.data;
      if(Array.isArray(frame)&&frame.length===5&&frame[0]===APPLICATION_WORKER_PROTOCOL&&frame[1]===client.binding&&frame[2]==="nativeAuthorizationReply"){
        const reply=nativeAuthorizationReply(frame[4]),slot=this.nativeWait;
        if(!slot){if(reply.rpc>this.nativeRpc)throw new ApplicationWorkerError("application_worker_binding");return;}
        if(slot.client!==client||slot.id!==frame[3]||slot.rpc!==reply.rpc)throw new ApplicationWorkerError("application_worker_binding");
        this.nativeWait=null;
        if(reply.ok)slot.resolve(reply.value!);else slot.reject(new ApplicationWorkerError("application_worker_unavailable"));
        return;
      }
      request=applicationWorkerRequest(event.data,client.binding);
      if(request[2]===0){
        // Visibility never waits behind sign-in/receipt IO and does not acquire
        // a second operation slot. No acknowledgement RPC; inventory work
        // takes its separate turn in the original WorkerHost queue.
        if(this.stopping)return;
        if(request[3]==="approvalClosed"){
          // The page holding the approval window saw it closed. The proxy portal
          // reflects it; the session reads once more and ends only a still-pending wait.
          // A window held by another tab is that tab's to report.
          if(this.approval&&this.approval.client!==client)return;
          if(this.approval)this.approval.reported=true;
          try{this.session.approvalWindowClosed();}catch{/* a closing session ignores it */}
          return;
        }
        // A tab shown, focused or back online: a visible connection drives now
        // (backoff and offline waits reset), not on its next timer or push.
        client.foreground=request[4] as boolean;this.applyForeground(client.foreground,true);
        return;
      }
      if(request[2]<=client.lastId)throw new ApplicationWorkerError("application_worker_binding");
      client.lastId=request[2];
    }catch{this.refuse(client);return;}
    if(request[3]==="close"&&!client.primary){
      // A follower tab closing: only its ports go; the session stays for the others.
      const closed=Object.freeze({...this.view(client),status:"closed" as const,selectedCollectionId:null});
      try{this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"reply",request[2],{ok:true,snapshot:closed}]);}finally{this.detach(client);}
      return;
    }
    if(request[3]==="close"){
      // Closing interrupts lifetime but drains the ORIGINAL operation. It is
      // the only terminal cut allowed while a request is running.
      void this.stop(false).then(()=>{
        try{this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"reply",request[2],{ok:true,snapshot:this.session.getSnapshot()}]);}finally{this.detachAll();}
      },()=>{try{this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"reply",request[2],{ok:false,problem:{code:"application_worker_stop_failed"}}]);}catch{/* ownership remains quarantined */}}).catch(()=>{});
      return;
    }
    if(this.stopping){
      try{this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"reply",request[2],{ok:false,problem:{code:"application_worker_fenced"}}]);}catch{/* stop already owns cleanup */}return;
    }
    // Each tab holds one request at a time; tabs take turns, in arrival order.
    if(this.queue.some(item=>item.client===client)||this.active?.client===client){
      try{this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"reply",request[2],{ok:false,problem:{code:"application_worker_busy"}}]);}catch{/* stop already owns cleanup */}return;
    }
    this.queue.push({client,request});this.pump();
  }
  private pump():void {
    if(this.active||this.stopping)return;
    const next=this.queue.shift();if(!next)return;
    this.active=next;
    let pending:Promise<void>|null=null;
    const finish=()=>{if(this.pending===pending){this.pending=null;this.active=null;this.reconcile();this.applyForeground();this.pump();}};
    if(next.client===null){
      // Internal: a failed close stays quarantined in the session (its problem shows there).
      pending=Promise.resolve().then(next.job).catch(()=>{}).finally(finish);
      this.pending=pending;return;
    }
    const {client,request}=next;
    pending=Promise.resolve().then(()=>this.invoke(client,request)).then(()=>{
      if(this.stopping||this.lifetime.signal.aborted)throw new ApplicationWorkerError("application_worker_fenced");
      this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"reply",request[2],{ok:true,snapshot:this.view(client)}]);
    }).catch(error=>{
      try{this.post(client,[APPLICATION_WORKER_PROTOCOL,client.binding,"reply",request[2],{ok:false,problem:applicationWorkerReplyProblem(error)}]);}catch{/* stop owns late delivery */}
    }).finally(finish);
    this.pending=pending;
  }
  private async invoke(client:HostClient,request:ApplicationWorkerRequest):Promise<void>{
    if(this.stopping||this.lifetime.signal.aborted)throw new ApplicationWorkerError("application_worker_fenced");
    const payload=request[4];
    switch(request[3]){
      case "start":await this.session.start();break;
      case "authorize":await this.session.authorize({collectionHint:payload as string|null});break;
      case "renewExpiredPairing":await this.session.renewExpiredPairing();break;
      case "select":{
        // This tab's own selection: other tabs keep theirs open.
        const id=payload as string;
        if(client.selected!==id){this.leave(client);client.selected=id;}
        try{await this.session.openCollection(id);}finally{this.collect();}
        break;
      }
      case "clearSelection":this.leave(client);this.collect();break;
      case "forget":await this.session.forget(payload as string);break;
      case "refreshCollections":await this.session.refreshCollectionList();break;
      case "signOut":await this.session.signOut();break;
      case "deleteCollection":{const [id,name]=payload as readonly[string,string];await this.session.deleteCollection(id,name);break;}
      case "requestFileAccess":{const [id,actions,reason]=payload as readonly[string,readonly AppFileAction[],string];await this.session.requestFileAccess(id,actions,reason);break;}
      case "pollFileAccess":await this.session.pollFileAccess(payload as string);break;
      case "foreground":client.foreground=payload as boolean;this.applyForeground(true,true);break;
      case "approvalClosed":case "close":throw new ApplicationWorkerError("application_worker_fenced");
    }
  }
  /** Once-only physical stop. Failed native/SQL stop retains this owner, port and
   * original SDK leases; a subsequent call returns the SAME rejection. */
  stop(detach=true):Promise<void>{
    if(this.stopping)return this.stopping;
    const pending=this.pending;this.queue.length=0;
    this.stopping=Promise.resolve().then(async()=>{
      await this.session.close();await pending;
      this.unsubscribe?.();this.unsubscribe=null;
      if(detach)this.detachAll();
    });
    this.lifetime.abort();return this.stopping;
  }
  private detachAll():void {
    for(const client of [...this.clients.values()]){
      client.gone=true;this.clients.delete(client.binding);
      client.port.removeEventListener("message",client.onMessage);client.port.removeEventListener("messageerror",client.onMessageError);client.port.close();
    }
  }
}
