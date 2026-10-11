import type {AppWebSignInPortal,AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {ApplicationDeclarationSnapshot} from "./declaration.js";
import type {MdbaseApplicationConnection,MdbaseApplicationReadinessSnapshot,MdbaseApplicationRequestOptions,MdbaseApplicationSnapshot as PublicSnapshot} from "./entry.js";
import {ApplicationScope} from "./scope.js";
import type {MdbaseSetupPlan,MdbaseSetupPlanOptions} from "./setup.js";
import {ApplicationWorkerClient} from "./worker-client.js";
import {browserApplicationPortalHost,reserveApplicationPortal} from "./portal-reservation.js";

/** Runtime view; the public entry adds its collection selection. */
export type MdbaseApplicationSnapshot=Omit<PublicSnapshot,"selection">;

/** Private activation input, built ONLY by SDK registration/asset/Worker startup.
 * This is not a public app constructor option, runtime hook or authority loan. */
export interface ApplicationRuntimeActivation {
  readonly declaration:Readonly<ApplicationDeclarationSnapshot>;
  readonly cpOrigin:string;
  readonly port:MessagePort;readonly binding:string;
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
  private pending:Promise<MdbaseApplicationSnapshot>|null=null;private closing:Promise<void>|null=null;private epoch=0;private closed=false;private stopped=false;private stopFailed=false;
  constructor(input:ApplicationRuntimeActivation){
    this.cpOrigin=input.cpOrigin;this.lab=input.declaration.environment==="lab";
    this.scope=new ApplicationScope(input.declaration,{name:input.declaration.name,version:"1"},this.lifetime.signal);
    this.worker=new ApplicationWorkerClient(input.port,input.binding,{
      snapshot:value=>{if(!this.closed){this.raw=value;this.publish();}},
      handoff:(value,caller)=>{const epoch=this.epoch;return this.scope.adopt(value,caller,()=>!this.closed&&this.epoch===epoch).then(()=>{});},
      releaseWorker:input.releaseWorker,
      failed:error=>{if(!this.closed){this.raw=Object.freeze({...this.raw,status:"blocked",problem:error.code});this.publish();}},
    });
    this.unsubscribe=this.scope.subscribe(()=>this.publish());
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
      const readiness=this.scope.getReadiness()??emptyReadiness();let status=this.raw.status,problem=this.raw.problem;
      if(status==="ready"||status==="setup_required"){
        status=readiness.checking?"opening":readiness.assessment?.status==="ready"?"ready":readiness.assessment?.status==="setup_required"?"setup_required":"blocked";
        if(status==="blocked")problem=readiness.problem?.code??readiness.assessment?.problem?.code??"application_readiness_unavailable";
      }
      this.snapshot=Object.freeze({...this.raw,status,problem,collections:Object.freeze(this.raw.collections.map(value=>Object.freeze({...value}))),readiness});
    }
    for(const listener of [...this.listeners])try{listener();}catch{/* observers do not own lifecycle */}
  }
  private signal(options:MdbaseApplicationRequestOptions):AbortSignal{return options.signal?AbortSignal.any([this.lifetime.signal,options.signal]):this.lifetime.signal;}
  private action(work:()=>Promise<MdbaseApplicationSnapshot>,caller:AbortSignal):Promise<MdbaseApplicationSnapshot>{
    if(this.closed||caller.aborted)return Promise.reject(new ApplicationRuntimeError("application_fenced"));
    if(this.pending)return Promise.reject(new ApplicationRuntimeError("application_busy"));
    const pending=Promise.resolve().then(async()=>{
      if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");
      const result=await work();
      if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");return result;
    }).finally(async()=>{await this.worker.drain();if(this.pending===pending)this.pending=null;});this.pending=pending;return pending;
  }
  private async complete(value:AppWebSignInSnapshot,caller:AbortSignal):Promise<MdbaseApplicationSnapshot>{
    if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");
    this.raw=value;this.publish();
    if(value.selectedCollectionId&&this.scope.connection(value.selectedCollectionId)){
      // Semantic failures demote READY; they are not transport success. Retain
      // helper's truthful null/error state rather than replacing native owner.
      await this.scope.assess({signal:caller}).catch(()=>{});this.publish();
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
      if(this.raw.selectedCollectionId===id&&(this.raw.status==="ready"||this.raw.status==="setup_required")&&this.scope.connection(id)?.isCurrent())return this.snapshot;
      ++this.epoch;const retired=this.scope.retire();this.publish();await retired;
      if(this.closed||caller.aborted)throw new ApplicationRuntimeError("application_fenced");
      // Worker session.select subsequently drains its ORIGINAL native scope.
      // UI retirement above is not the native shutdown/SQL/lease certificate.
      return this.complete(await this.worker.request("select",id,caller),caller);
    },caller);
  }
  assess(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationReadinessSnapshot>{
    const caller=this.signal(options);
    return this.action(async()=>{await this.scope.assess({signal:caller});this.publish();return this.snapshot;},caller).then(value=>value.readiness);
  }
  configure(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{await this.scope.configure({signal:caller});this.publish();return this.snapshot;},caller);
  }
  /** Read-only review plan of the open collection; no snapshot publication. */
  planSetup(options:MdbaseSetupPlanOptions={}):Promise<MdbaseSetupPlan>{
    const caller=this.signal(options);
    if(this.closed||caller.aborted)return Promise.reject(new ApplicationRuntimeError("application_fenced"));
    return this.scope.planSetup({...options,signal:caller});
  }
  applySetup(plan:MdbaseSetupPlan,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{await this.scope.applySetup(plan,{signal:caller});this.publish();return this.snapshot;},caller);
  }
  clearSelection(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{
      ++this.epoch;await this.scope.retire();return this.complete(await this.worker.request("clearSelection",null,caller),caller);
    },caller);
  }
  forget(id:string,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{
      if(this.raw.selectedCollectionId===id){++this.epoch;await this.scope.retire();}
      return this.complete(await this.worker.request("forget",id,caller),caller);
    },caller);
  }
  /** Owner delete through the CP, then forget it locally like `forget`. A
   * refusal leaves the collection (and any open connection) as it was. */
  deleteCollection(id:string,confirmName:string,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationSnapshot>{
    const caller=this.signal(options);return this.action(async()=>{
      await this.worker.request("deleteCollection",[id,confirmName],caller);
      if(this.raw.selectedCollectionId===id){++this.epoch;await this.scope.retire();}
      return this.complete(await this.worker.request("forget",id,caller),caller);
    },caller);
  }
  setForeground(active:boolean):void{if(!this.closed)this.worker.setForeground(active);}
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
