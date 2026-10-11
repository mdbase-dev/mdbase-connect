import {createAppCollectionReadiness,type AppCollectionReadiness,type AppCollectionReadinessRequirements,type AppCollectionReadinessSnapshot} from "../app-host/collection-readiness.js";
import type {MdbaseApplicationConnection,MdbaseApplicationFacetSnapshot,MdbaseApplicationReadinessSnapshot,MdbaseApplicationRequestOptions} from "./entry.js";

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
export class ApplicationReadinessError extends Error {
  constructor(readonly code:"application_readiness_fenced"|"application_readiness_busy"){
    super("SDK application readiness unavailable");this.name="ApplicationReadinessError";
  }
}
const empty=(code:string|null,checking=false):MdbaseApplicationFacetSnapshot=>Object.freeze({checking,assessment:null,problem:code?Object.freeze({code}):null});
function nativeFacet(value:AppCollectionReadinessSnapshot):MdbaseApplicationFacetSnapshot {
  const problem=value.problem?Object.freeze({code:`readiness_${value.problem.reason}`}):null;
  return Object.freeze({checking:value.checking,assessment:value.assessment?Object.freeze({status:value.assessment.status,problem:value.assessment.problem?Object.freeze({code:`readiness_${value.assessment.problem.reason}`}):null}):null,problem});
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
  constructor(options:ApplicationReadinessOptions){
    this.connection=options.connection;this.signal=options.signal;this.observed=options.isCurrent;
    this.sources=Object.freeze({configuration:options.configuration,files:options.files,people:options.people,notifications:options.notifications});
    this.native=options.nativeRequirements?createAppCollectionReadiness(this.connection.records,options.nativeRequirements,{collection:this.connection.id,generation:this.connection.generation,signal:this.signal,isCurrent:()=>this.current()}):null;
    if(this.native)this.stops.push(this.native.subscribe(this.changed));
    for(const source of Object.values(this.sources))if(source)this.stops.push(source.subscribe(this.changed));
    this.signal.addEventListener("abort",this.abort,{once:true});
  }
  private current():boolean {try{return !this.closed&&!this.signal.aborted&&this.observed()===true&&this.connection.isCurrent()&&this.connection.records.collection===this.connection.id;}catch{return false;}}
  private readonly changed=()=>{for(const listener of [...this.listeners])try{listener();}catch{/* observers do not own evidence */}};
  private readonly abort=()=>{void this.close().catch(()=>{});};
  subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  getSnapshot():MdbaseApplicationReadinessSnapshot {
    const current=this.current(),unsupported=empty(current?"readiness_unsupported":"readiness_fenced");
    let native=unsupported;
    if(current&&this.native){
      const value=this.native.getSnapshot(),witness=value.assessment?.witness;
      native=witness&&(witness.collection!==this.connection.id||witness.generation!==this.connection.generation)?empty("readiness_fenced"):nativeFacet(value);
    }
    const read=(name:keyof typeof this.sources)=>{
      if(!current)return unsupported;const source=this.sources[name];
      if(!source)return empty(`${name}_unsupported`);
      try{const value=source.getSnapshot();return Object.freeze({checking:value.checking,assessment:value.assessment?Object.freeze({...value.assessment,problem:value.assessment.problem?Object.freeze({...value.assessment.problem}):null}):null,problem:value.problem?Object.freeze({...value.problem}):null});}catch{return empty(`${name}_unavailable`);}
    };
    const facets=Object.freeze({capabilities:native,contracts:native,configuration:read("configuration"),files:read("files"),people:read("people"),notifications:read("notifications")});
    const values=Object.values(facets),checking=current&&(this.checking||values.some(value=>value.checking));
    let assessment:MdbaseApplicationFacetSnapshot["assessment"]=null,problem:MdbaseApplicationFacetSnapshot["problem"]=null;
    if(!current)problem=Object.freeze({code:"readiness_fenced"});
    else if(!checking){
      problem=values.find(value=>value.problem)?.problem??null;
      if(values.every(value=>value.assessment!==null)){
        const incompatible=values.find(value=>value.assessment?.status==="incompatible"),setup=values.find(value=>value.assessment?.status==="setup_required"),selected=incompatible??setup;
        assessment=Object.freeze({status:incompatible?"incompatible":setup?"setup_required":"ready",problem:selected?.assessment?.problem??null});
      }
    }
    // Source getters/observers can synchronously retire the connection.
    if(!this.current())return Object.freeze({checking:false,assessment:null,problem:Object.freeze({code:"readiness_fenced"}),facets:Object.freeze({capabilities:empty("readiness_fenced"),contracts:empty("readiness_fenced"),configuration:empty("readiness_fenced"),files:empty("readiness_fenced"),people:empty("readiness_fenced"),notifications:empty("readiness_fenced")})});
    return Object.freeze({checking,assessment,problem,facets});
  }
  refresh(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationReadinessSnapshot>{
    const caller=options.signal;
    if(!this.current()||caller?.aborted)return Promise.reject(new ApplicationReadinessError("application_readiness_fenced"));
    if(this.pending)return Promise.reject(new ApplicationReadinessError("application_readiness_busy"));
    this.checking=true;
    const pending=Promise.resolve().then(async()=>{
      if(!this.current())return this.getSnapshot();
      if(this.native)await this.native.start();
      for(const source of Object.values(this.sources)){
        if(!this.current())break;
        if(source)await source.refresh(); // original lifetime READ, no caller cancellation loan
      }
      return this.getSnapshot();
    }).finally(()=>{if(this.pending===pending){this.pending=null;this.checking=false;this.changed();}}).then(()=>this.getSnapshot());
    this.pending=pending;this.changed();
    return pending.then(value=>{if(!this.current()||caller?.aborted)throw new ApplicationReadinessError("application_readiness_fenced");return value;});
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.checking=false;this.signal.removeEventListener("abort",this.abort);
    this.closing=Promise.resolve().then(async()=>{
      for(const stop of this.stops.splice(0))stop();
      for(const source of Object.values(this.sources))await source?.close();
      await this.native?.close();await this.pending?.catch(()=>{});this.listeners.clear();
    });this.changed();return this.closing;
  }
}
