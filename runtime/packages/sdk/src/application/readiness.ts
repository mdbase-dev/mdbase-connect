import {describeError} from "../describe-error.js";
import {isMdbaseError} from "../errors.js";
import {createAppCollectionReadiness,type AppCollectionReadiness,type AppCollectionReadinessRequirements,type AppCollectionReadinessSnapshot} from "../app-host/collection-readiness.js";
import type {MdbaseApplicationConnection,MdbaseApplicationFacetSnapshot,MdbaseApplicationProblem,MdbaseApplicationReadinessSnapshot,MdbaseApplicationRequestOptions} from "./entry.js";

/** Internal current facet sources; never declaration callbacks or app authority.
 * The singleton supplies the genuine SDK configuration/files/people/notifications
 * helpers against this SAME connection. Missing sources remain unsupported. */
export interface ApplicationReadinessFacetSource {
  getSnapshot():MdbaseApplicationFacetSnapshot;
  subscribe(listener:()=>void):()=>void;
  refresh(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationFacetSnapshot>;
  close():void|Promise<void>;
}
export interface ApplicationReadinessOptions {
  readonly connection:MdbaseApplicationConnection;
  readonly nativeRequirements:AppCollectionReadinessRequirements|null;
  readonly signal:AbortSignal;
  readonly configuration?:ApplicationReadinessFacetSource;
  readonly files?:ApplicationReadinessFacetSource;
  readonly people?:ApplicationReadinessFacetSource;
  readonly notifications?:ApplicationReadinessFacetSource;
  isCurrent():boolean;
}
const GATING=["configuration","files"] as const,ADVISORY=["people","notifications"] as const;
export class ApplicationReadinessError extends Error {
  constructor(readonly code:"application_readiness_fenced"|"application_readiness_busy",readonly detail?:MdbaseApplicationProblem["detail"]){
    super("SDK application readiness unavailable");this.name="ApplicationReadinessError";
  }
}
const empty=(code:string|null,checking=false,detail?:MdbaseApplicationProblem["detail"]):MdbaseApplicationFacetSnapshot=>Object.freeze({checking,assessment:null,problem:code?Object.freeze({code,...(detail?{detail}:{})}):null});
function nativeFacet(value:AppCollectionReadinessSnapshot):MdbaseApplicationFacetSnapshot {
  const convert=(problem:AppCollectionReadinessSnapshot["problem"]):MdbaseApplicationFacetSnapshot["problem"]=>problem?Object.freeze({code:`readiness_${problem.reason}`,...(problem.detail?{detail:problem.detail}:{})}):null;
  const problem=convert(value.problem);
  const types=value.assessment?.unavailableTypes;
  return Object.freeze({checking:value.checking,assessment:value.assessment?Object.freeze({status:value.assessment.status,problem:convert(value.assessment.problem),
    ...(types?.length?{unavailableTypes:types}:{})}):null,problem});
}
/** Aggregate semantic evidence is SDK-owned. A compiler/transport/setup receipt
 * or a subset of successful facets never substitutes for current native witness.
 * Refresh sequences borrowed CONTROL facets; caller abort fences delivery only. */
export class ApplicationReadiness {
  private readonly connection:MdbaseApplicationConnection;private readonly signal:AbortSignal;private readonly observed:()=>boolean;
  private readonly native:AppCollectionReadiness|null;private readonly sources:Readonly<Pick<ApplicationReadinessOptions,"configuration"|"files"|"people"|"notifications">>;
  private readonly listeners=new Set<()=>void>();private readonly stops:Array<()=>void>=[];
  private pending:Promise<MdbaseApplicationReadinessSnapshot>|null=null;private closing:Promise<void>|null=null;
  private checking=false;private closed=false;
  /** People and notifications refreshing after the gating facets (P5). */
  private advisory:Promise<void>=Promise.resolve();
  /** The last settled aggregate of this connection, kept while it is re-checked. */
  private lastReady:MdbaseApplicationReadinessSnapshot|null=null;
  constructor(options:ApplicationReadinessOptions){
    this.connection=options.connection;this.signal=options.signal;this.observed=options.isCurrent;
    this.sources=Object.freeze({configuration:options.configuration,files:options.files,people:options.people,notifications:options.notifications});
    this.native=options.nativeRequirements?createAppCollectionReadiness(this.connection.records,options.nativeRequirements,{collection:this.connection.id,generation:this.connection.generation,signal:this.signal,isCurrent:()=>this.current()}):null;
    if(this.native)this.stops.push(this.native.subscribe(this.changed));
    for(const source of Object.values(this.sources))if(source)this.stops.push(source.subscribe(this.changed));
    this.signal.addEventListener("abort",this.abort,{once:true});
  }
  private fenceDetail():NonNullable<MdbaseApplicationProblem["detail"]>|null {
    try{
      if(this.signal.aborted)return "scope_aborted";
      if(this.closed)return "scope_closed";
      if(this.observed()!==true)return "observer_not_current";
      if(!this.connection.isCurrent())return "connection_not_current";
      if(this.connection.records.collection!==this.connection.id)return "collection_mismatch";
      return null;
    }catch{return "currentness_check_failed";}
  }
  private current():boolean {return this.fenceDetail()===null;}
  /** The retained connection may stop being current because its native session
   * ended. Keep the typed closing reason while this scope's lifetime is still
   * live; never replace it with the generic fencing/busy placeholder. */
  private connectionProblem():string {
    if(!this.closed&&!this.signal.aborted&&this.connection.records.collection===this.connection.id&&this.connection.records.link==="closed"){
      const error=this.connection.records.linkProblem;
      if(isMdbaseError(error)){
        const described=describeError(error);
        return described&&described.key!=="unknown"?described.key:error.code;
      }
    }
    return "readiness_fenced";
  }
  private readonly changed=()=>{for(const listener of [...this.listeners])try{listener();}catch{/* observers do not own evidence */}};
  private readonly abort=()=>{void this.close().catch(()=>{});};
  subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  getSnapshot():MdbaseApplicationReadinessSnapshot {
    const current=this.current(),unsupported=empty(current?"readiness_unsupported":"readiness_fenced");
    let native=unsupported;
    if(current&&this.native){
      const value=this.native.getSnapshot(),witness=value.assessment?.witness;
      const detail=witness&&witness.collection!==this.connection.id?"native_witness_collection_mismatch":witness&&witness.generation!==this.connection.generation?"native_witness_generation_mismatch":null;
      native=detail?empty("readiness_fenced",false,detail):nativeFacet(value);
    }
    const read=(name:keyof typeof this.sources)=>{
      if(!current)return unsupported;const source=this.sources[name];
      if(!source)return empty(`${name}_unsupported`);
      try{const value=source.getSnapshot();return Object.freeze({checking:value.checking,assessment:value.assessment?Object.freeze({...value.assessment,problem:value.assessment.problem?Object.freeze({...value.assessment.problem}):null}):null,problem:value.problem?Object.freeze({...value.problem}):null});}catch{return empty(`${name}_unavailable`);}
    };
    const facets=Object.freeze({capabilities:native,contracts:native,configuration:read("configuration"),files:read("files"),people:read("people"),notifications:read("notifications")});
    // Notifications and people are advisory: an app opens with reminders off
    // (Connect's approval lets the person leave them off) and reads
    // facets.notifications to offer turning them on; people (members, the
    // signed-in person) load after the collection is ready and report through
    // facets.people. Neither gates READY or the aggregate problem (P5).
    const values=[facets.capabilities,facets.contracts,facets.configuration,facets.files],checking=current&&(this.checking||values.some(value=>value.checking));
    let assessment:MdbaseApplicationFacetSnapshot["assessment"]=null,problem:MdbaseApplicationFacetSnapshot["problem"]=null;
    if(!current)problem=Object.freeze({code:"readiness_fenced"});
    else if(!checking){
      const failed=(["capabilities","contracts",...GATING] as const).find(name=>facets[name].problem);
      problem=failed?facets[failed].problem:null;
      if(failed&&problem?.code==="readiness_fenced"&&!problem.detail)problem=Object.freeze({...problem,detail:`${failed}_facet`});
      if(values.every(value=>value.assessment!==null)){
        const incompatible=values.find(value=>value.assessment?.status==="incompatible"),setup=values.find(value=>value.assessment?.status==="setup_required"),selected=incompatible??setup;
        const types=native.assessment?.unavailableTypes;
        assessment=Object.freeze({status:incompatible?"incompatible":setup?"setup_required":"ready",problem:selected?.assessment?.problem??null,...(types?.length?{unavailableTypes:types}:{})});
      }
    }
    // Source getters/observers can synchronously retire the connection.
    const detail=this.fenceDetail();
    if(detail){this.lastReady=null;return Object.freeze({checking:false,assessment:null,problem:Object.freeze({code:this.connectionProblem(),detail}),facets:Object.freeze({capabilities:empty("readiness_fenced",false,detail),contracts:empty("readiness_fenced",false,detail),configuration:empty("readiness_fenced",false,detail),files:empty("readiness_fenced",false,detail),people:empty("readiness_fenced",false,detail),notifications:empty("readiness_fenced",false,detail)})});}
    // A collection that was READY stays READY while a change (this device's or
    // another's) is re-checked: re-checks and concurrent-change retries are not
    // problems. A settled non-ready assessment or any other problem replaces it.
    // Every operation is still checked by the replica itself.
    // A settled non-ready assessment is kept the same way through background
    // facet re-checks, but not through an explicit refresh (an action re-checking).
    const transient=!problem||/_(changed|busy)$/.test(problem.code);
    if(problem===null&&assessment!==null&&!checking)this.lastReady=Object.freeze({checking,assessment,problem,facets});
    else if(this.lastReady&&transient&&(checking||assessment===null)&&(this.lastReady.assessment?.status==="ready"||!this.checking))return Object.freeze({...this.lastReady,facets});
    else this.lastReady=null;
    return Object.freeze({checking,assessment,problem,facets});
  }
  refresh(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationReadinessSnapshot>{
    const caller=options.signal;
    const detail=this.fenceDetail()??(caller?.aborted?"caller_aborted":null);
    if(detail)return Promise.reject(new ApplicationReadinessError("application_readiness_fenced",detail));
    if(this.pending)return Promise.reject(new ApplicationReadinessError("application_readiness_busy"));
    this.checking=true;
    const pending=Promise.resolve().then(async()=>{
      if(!this.current())return this.getSnapshot();
      // Advisory facets from the previous refresh still hold the control slot.
      await this.advisory;
      if(this.native)await this.native.start();
      // Gating facets one at a time (one native control slot); advisory facets
      // (people, notifications) after them, outside `checking` (P5).
      for(const name of GATING){
        const source=this.sources[name];
        if(!this.current())break;
        if(source)await source.refresh(); // original lifetime READ, no caller cancellation loan
      }
      return this.getSnapshot();
    }).finally(()=>{
      if(this.pending!==pending)return;
      this.pending=null;this.checking=false;
      const advisory=(async()=>{for(const name of ADVISORY){const source=this.sources[name];if(!this.current())break;if(source)await source.refresh().catch(()=>{});}})();
      this.advisory=advisory;
      this.changed();
    }).then(()=>this.getSnapshot());
    this.pending=pending;this.changed();
    return pending.then(value=>{const detail=this.fenceDetail()??(caller?.aborted?"caller_aborted":null);if(detail)throw new ApplicationReadinessError("application_readiness_fenced",detail);return value;});
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.checking=false;this.signal.removeEventListener("abort",this.abort);
    this.closing=Promise.resolve().then(async()=>{
      for(const stop of this.stops.splice(0))stop();
      for(const source of Object.values(this.sources))await source?.close();
      await this.native?.close();await this.pending?.catch(()=>{});await this.advisory;this.listeners.clear();
    });this.changed();return this.closing;
  }
}
