import type {AppWebSignInPortal,AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {AppWebCollectionHandoff} from "../app-host/web-collection.js";
import type {ApplicationDeclarationSnapshot} from "./declaration.js";
import type {compileApplicationManifest} from "./manifest.js";
import type {MdbaseApplicationConnection,MdbaseApplicationProblem,MdbaseApplicationReadinessSnapshot,MdbaseApplicationRequestOptions,MdbaseApplicationSnapshot as PublicSnapshot,MdbaseSignOutOptions} from "./entry.js";
import {pendingWrites,signOutPendingWritesError} from "./sign-out.js";
import {ApplicationScope} from "./scope.js";
import {applicationLoopbackAllowed} from "./local-build.js";
import {consentedFileActions} from "./file-access.js";
import type {MdbaseSetupPlan,MdbaseSetupPlanOptions} from "./setup.js";
import {ApplicationWorkerClient} from "./worker-client.js";
import {browserApplicationPortalHost,reserveApplicationPortal} from "./portal-reservation.js";

/** Runtime view; the public entry adds its collection selection. */
export type MdbaseApplicationSnapshot=Omit<PublicSnapshot,"selection">;

/** Private activation input, built ONLY by SDK registration/asset/Worker startup.
 * This is not a public app constructor option, runtime hook or authority loan. */
export interface ApplicationRuntimeActivation {
  readonly declaration:Readonly<ApplicationDeclarationSnapshot>;
  /** SAME entry-owned canonical result; metadata rebinding does not change the manifest. */
  readonly compiledManifest:ReturnType<typeof compileApplicationManifest>;
  readonly typeIssues?:"block"|"degrade";
  readonly cpOrigin:string;
  readonly port:MessagePort;readonly binding:string;
  nativeAuthorization?:import("./worker-client.js").ApplicationWorkerClientOwner["nativeAuthorization"];
  releaseWorker():void;
}
export class ApplicationRuntimeError extends Error {
  constructor(readonly code:"application_busy"|"application_fenced"|"application_stop_failed"|"application_connection_unavailable"){
    super("SDK application runtime unavailable");this.name="ApplicationRuntimeError";
  }
}
const emptyReadiness=():MdbaseApplicationReadinessSnapshot=>{
  const facet=Object.freeze({checking:false,assessment:null,problem:null});
  return Object.freeze({checking:false,assessment:null,problem:null,facets:Object.freeze({capabilities:facet,contracts:facet,configuration:facet,files:facet,people:facet,notifications:facet})});
};
/** ONE singleton lifecycle over the original Worker and UI scope. Activation
 * happens after canonical registration and packaged asset checks, before this
 * class is installed on the public entry. Source tests alone are not acceptance. */
export class ApplicationRuntime {
  private readonly lifetime=new AbortController();private readonly scope:ApplicationScope;
  private readonly worker:ApplicationWorkerClient;private readonly cpOrigin:string;private readonly lab:boolean;
  private readonly listeners=new Set<()=>void>();private readonly unsubscribe:()=>void;
  private raw:AppWebSignInSnapshot=Object.freeze({status:"not_started",collections:Object.freeze([]),selectedCollectionId:null,signIn:null,problem:null,timing:null});
  private snapshot:MdbaseApplicationSnapshot=Object.freeze({...this.raw,readiness:emptyReadiness()});
  private pending:Promise<MdbaseApplicationSnapshot>|null=null;private closing:Promise<void>|null=null;private epoch=0;private loggedProblem:string|null=null;private assessing=false;private retiring=false;private closed=false;private stopped=false;private stopFailed=false;
  constructor(input:ApplicationRuntimeActivation){
    this.cpOrigin=input.cpOrigin;this.lab=applicationLoopbackAllowed(input.declaration.environment);
    this.scope=new ApplicationScope(input.compiledManifest,{name:input.declaration.name,version:"1"},this.lifetime.signal,input.typeIssues,id=>consentedFileActions(this.raw,id));
    this.worker=new ApplicationWorkerClient(input.port,input.binding,{
      snapshot:value=>{if(!this.closed){this.raw=value;this.followSession();this.publish();}},
      handoff:(value,caller)=>{const epoch=this.epoch;return this.scope.adopt(value,caller,()=>!this.closed&&this.epoch===epoch).then(()=>{this.portsFailed=null;},error=>{this.portsFailed=value.scope.collection;throw error;});},
      attached:value=>this.attached(value),
      releaseWorker:input.releaseWorker,
      ...(input.nativeAuthorization?{nativeAuthorization:input.nativeAuthorization}:{}),
      failed:error=>{if(!this.closed){this.raw=Object.freeze({...this.raw,status:"blocked",problem:error.code});this.publish();}},
    });
    this.unsubscribe=this.scope.subscribe(()=>this.publish());
  }
  /** The open collection whose ports this tab failed to adopt: it reads as
   * blocked, not as still opening. */
  private portsFailed:string|null=null;
  /** Ports for a collection this tab did not open itself: adopt them after any
   * action of this tab, as that action's successor. */
  private attached(value:AppWebCollectionHandoff):void {
    const discard=()=>{for(const port of [value.dataPort,value.controlPort,...(value.timerPort?[value.timerPort]:[])])try{port.close();}catch{/* already closed */}};
    if(this.closed){discard();return;}
    const caller=this.lifetime.signal;
    void this.queue(()=>this.action(async()=>{
      if(this.raw.selectedCollectionId!==value.scope.collection){discard();return this.snapshot;}
      if(this.scope.selectedId()!==null){++this.epoch;await this.retireOwn();}
      const epoch=this.epoch;
      await this.scope.adopt(value,caller,()=>!this.closed&&this.epoch===epoch).catch(error=>{this.portsFailed=value.scope.collection;throw error;});
      this.portsFailed=null;
      return this.complete(this.raw,caller);
    },caller)).catch(()=>{if(!this.closed)this.publish();});
  }
  /** The session's open collection changed under this tab (another tab, or
   * access ended): let go of the old ports; wait for new ones if it is open.
   * An approval in progress (adding a collection) keeps the open collection
   * open: its ports stay, so a cancelled approval returns to it as it was. */
  private followSession():void {
    if(this.pending)return;
    const open=this.raw.status==="ready"||this.raw.status==="setup_required",id=this.raw.selectedCollectionId,held=this.scope.selectedId();
    if(held!==null&&(held!==id||(!open&&this.raw.status!=="opening"&&this.raw.status!=="authorizing"))){
      const caller=this.lifetime.signal;
      void this.queue(()=>this.action(async()=>{
        if(this.scope.selectedId()===held){++this.epoch;await this.retireOwn();}
        this.publish();return this.snapshot;
      },caller)).catch(()=>{});
    }
  }
  connection(id:string):MdbaseApplicationConnection|null{return this.closed?null:this.scope.connection(id);}
  getSnapshot():MdbaseApplicationSnapshot{return this.snapshot;}
  /** Native session view (what is actually open), before readiness demotion. */
  getNativeSnapshot():AppWebSignInSnapshot{return this.raw;}
  /** Start work after the current action drains. Ordering only: no retry,
   * no second slot and no overlap with the original Worker request. */
  async queue<T>(work:()=>Promise<T>):Promise<T>{while(this.pending&&!this.closed)await this.pending.catch(()=>{});return work();}
  subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private publish():void {
    if(this.closed){this.snapshot=Object.freeze({...this.raw,status:this.stopped?"closed":"blocked",problem:this.stopped?null:this.stopFailed?"application_stop_failed":"application_closing",selectedCollectionId:null,readiness:emptyReadiness()});}
    else {
      const readiness=this.scope.getReadiness()??emptyReadiness();let status=this.raw.status,problem=this.raw.problem,detail:MdbaseApplicationProblem["detail"];
      const id=this.raw.selectedCollectionId;
      // Open in the session, and this tab's own ports to it are on the way.
      // A scope this tab's own action is letting go of reads fenced: that is the
      // switch in progress (opening), not a blocked collection.
      const released=this.retiring&&readiness.problem?.code==="readiness_fenced";
      const waiting=id!==null&&(this.scope.getReadiness()===null||released)&&this.portsFailed!==id;
      if((status==="ready"||status==="setup_required")&&waiting)status="opening";
      else if(status==="ready"||status==="setup_required"){
        // Inside an action (open, setup, configure) incomplete evidence is still
        // being gathered: opening, not blocked. The action publishes its final
        // evidence when it settles, and only that can read as blocked.
        const unassessed=this.assessing&&!readiness.assessment&&readiness.problem?.code!=="readiness_fenced";
        status=readiness.checking||unassessed?"opening":readiness.assessment?.status==="ready"?"ready":readiness.assessment?.status==="setup_required"?"setup_required":"blocked";
        if(status==="blocked"){const blocked=readiness.problem??readiness.assessment?.problem;problem=blocked?.code??"application_readiness_unavailable";detail=blocked?.detail;}
      }
      // A blocked app names its typed code once in the console; the UI shows only copy.
      const diagnostic=`${problem}:${detail??""}`;
      if(status==="blocked"&&problem&&diagnostic!==this.loggedProblem){this.loggedProblem=diagnostic;try{if(detail)console.error("mdbase application blocked:",problem,detail);else console.error("mdbase application blocked:",problem);}catch{/* no console */}}
      else if(status!=="blocked")this.loggedProblem=null;
      this.snapshot=Object.freeze({...this.raw,status,problem,collections:Object.freeze(this.raw.collections.map(value=>Object.freeze({...value}))),readiness});
    }
    for(const listener of [...this.listeners])try{listener();}catch{/* observers do not own lifecycle */}
  }
  /** Inside an action: let go of the open scope as this tab's own step. */
  private retireOwn():Promise<void>{this.retiring=true;return this.scope.retire();}
  /** The action's final evidence: no longer "opening" by virtue of being in flight. */
  private settled():MdbaseApplicationSnapshot{this.assessing=false;this.publish();return this.snapshot;}
  private signal(options:MdbaseApplicationRequestOptions):AbortSignal{return options.signal?AbortSignal.any([this.lifetime.signal,options.signal]):this.lifetime.signal;}
  private action(work:()=>Promise<MdbaseApplicationSnapshot>,caller:AbortSignal):Promise<MdbaseApplicationSnapshot>{
    if(this.closed||caller.aborted)return Promise.reject(new ApplicationRuntimeError("application_fenced"));
    if(this.pending)return Promise.reject(new ApplicationRuntimeError("application_busy"));
    // A native open inside this action reads opening until complete() assesses it.
    this.assessing=true;
    const pending=Promise.resolve().then(async()=>{
      if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");
      const result=await work();
      if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");return result;
    }).finally(async()=>{if(this.assessing||this.retiring){this.assessing=false;this.retiring=false;this.publish();}await this.worker.drain();if(this.pending===pending)this.pending=null;});this.pending=pending;return pending;
  }
  private async complete(value:AppWebSignInSnapshot,caller:AbortSignal):Promise<MdbaseApplicationSnapshot>{
    if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");
    const assess=Boolean(value.selectedCollectionId&&this.scope.connection(value.selectedCollectionId));
    this.raw=value;this.assessing=assess;this.publish();
    if(assess){
      // Semantic failures demote READY; they are not transport success. Retain
      // helper's truthful null/error state rather than replacing native owner.
      try{await this.scope.assess({signal:caller}).catch(()=>{});}finally{this.assessing=false;}this.publish();
    }
    if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");return this.snapshot;
  }
  start(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>this.complete(await this.worker.request("start",null,caller),caller),caller);
  }
  /** Entry reserves this SAME SDK portal before lazy registration/startup. */
  authorizeReserved(portal:AppWebSignInPortal,options:MdbaseApplicationRequestOptions={},collectionHint:string|null=null):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);
    return this.action(async()=>this.complete(await this.worker.request("authorize",collectionHint,caller,portal),caller),caller).catch(error=>{portal.close();throw error;});
  }
  authorize(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);
    // Synchronous reservation belongs to this SDK user-gesture call, before
    // any Worker startup/expiry awaits; no app popup glue or text matching.
    let portal;try{portal=reserveApplicationPortal(browserApplicationPortalHost(this.cpOrigin,caller,()=>!this.closed,this.lab));}catch(error){return Promise.reject(error);}
    return this.authorizeReserved(portal,options);
  }
  select(id:string,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{
      // Reselecting the SAME current open scope keeps its generation/client.
      if(this.raw.selectedCollectionId===id&&(this.raw.status==="ready"||this.raw.status==="setup_required")&&this.scope.connection(id)?.isCurrent()){
        // A settled readiness failure needs a real retry, not the cached blocked
        // snapshot. Keep the original connection/journal; never redo its writes.
        if(this.snapshot.status==="blocked")return this.complete(this.raw,caller);
        return this.snapshot;
      }
      ++this.epoch;const retired=this.retireOwn();this.publish();await retired;
      if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");
      // Worker session.select subsequently drains its ORIGINAL native scope.
      // UI retirement above is not the native shutdown/SQL/lease certificate.
      return this.complete(await this.worker.request("select",id,caller),caller);
    },caller);
  }
  assess(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationReadinessSnapshot>{
    const caller=this.signal(options);
    return this.action(async()=>{await this.scope.assess({signal:caller});return this.settled();},caller).then(value=>value.readiness);
  }
  configure(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{await this.scope.configure({signal:caller});return this.settled();},caller);
  }
  /** Read-only review plan of the open collection; no snapshot publication. */
  planSetup(options:MdbaseSetupPlanOptions={}):Promise<MdbaseSetupPlan>{
    const caller=this.signal(options);
    if(this.closed||caller.aborted)return Promise.reject(new ApplicationRuntimeError("application_fenced"));
    return this.scope.planSetup({...options,signal:caller});
  }
  applySetup(plan:MdbaseSetupPlan,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{await this.scope.applySetup(plan,{signal:caller});return this.settled();},caller);
  }
  clearSelection(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{
      ++this.epoch;await this.retireOwn();return this.complete(await this.worker.request("clearSelection",null,caller),caller);
    },caller);
  }
  forget(id:string,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{
      if(this.raw.selectedCollectionId===id){++this.epoch;await this.retireOwn();}
      return this.complete(await this.worker.request("forget",id,caller),caller);
    },caller);
  }
  /** SDK-2: re-read the approved collection list. The open collection stays
   * open: no retire, no readiness pass. */
  refreshCollections(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);
    return this.action(async()=>{this.raw=await this.worker.request("refreshCollections",null,caller);this.publish();return this.snapshot;},caller);
  }
  /** UX-011: refuse while the open collection has unconfirmed writes (unless
   * `discard`), retire the UI scope, then the Worker session signs out and
   * erases this installation. The entry then discards this runtime. */
  signOut(options:MdbaseSignOutOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options),id=this.raw.selectedCollectionId;
    const pending=options.discard!==true&&id?pendingWrites(this.scope.connection(id)):0;
    if(pending>0)return Promise.reject(signOutPendingWritesError(pending));
    return this.action(async()=>{++this.epoch;await this.retireOwn();return this.complete(await this.worker.request("signOut",null,caller),caller);},caller);
  }
  /** Owner delete through the CP, then forget it locally like `forget`. A
   * refusal leaves the collection (and any open connection) as it was. */
  deleteCollection(id:string,confirmName:string,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{
      await this.worker.request("deleteCollection",[id,confirmName],caller);
      if(this.raw.selectedCollectionId===id){++this.epoch;await this.retireOwn();}
      return this.complete(await this.worker.request("forget",id,caller),caller);
    },caller);
  }
  /** Entry reserves the portal in the user gesture. The open collection stays
   * open: no retire, no readiness pass. */
  requestFileAccess(portal:AppWebSignInPortal,collectionId:string,actions:readonly string[],reason:string,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);
    return this.action(async()=>{this.raw=await this.worker.request("requestFileAccess",[collectionId,actions,reason],caller,portal);this.publish();return this.snapshot;},caller).catch(error=>{portal.close();throw error;});
  }
  pollFileAccess(requestId:string):Promise<MdbaseApplicationSnapshot>{
    const caller=this.lifetime.signal;
    return this.action(async()=>{this.raw=await this.worker.request("pollFileAccess",requestId,caller);this.publish();return this.snapshot;},caller);
  }
  setForeground(active:boolean):void{if(!this.closed)this.worker.setForeground(active);}
  /** Page lifecycle (pagehide): stop synchronously, without the terminal ACK
   * a frozen or unloading page could never receive. Terminates the Worker and
   * fences this runtime for good; the entry builds a fresh one to resume. */
  abandon():void{
    if(this.closed)return;
    this.closed=true;this.stopped=true;++this.epoch;this.unsubscribe();this.listeners.clear();
    this.closing=Promise.resolve();this.worker.abandon();this.lifetime.abort();
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;++this.epoch;this.lifetime.abort();this.unsubscribe();
    // Begin native terminal close concurrently with UI/helper drains. A held
    // native READ must not prevent its own original lifetime shutdown signal.
    this.closing=Promise.resolve().then(async()=>{
      await Promise.all([this.scope.close(),this.worker.close()]);
      await this.pending?.catch(()=>{});this.stopped=true;this.publish();this.listeners.clear();
    }).catch(()=>{this.stopFailed=true;this.publish();throw new ApplicationRuntimeError("application_stop_failed");});this.publish();return this.closing;
  }
}
