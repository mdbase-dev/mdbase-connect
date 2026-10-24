import {openAppWebCollectionClient,type AppWebCollectionHandoff,type AppWebCollectionClient} from "../app-host/web-collection.js";
import type {ClientOptions} from "../client.js";
import type {MdbaseApplicationConnection} from "./entry.js";

export class ApplicationUiConnectionError extends Error {
  constructor(readonly code:"application_connection_binding"|"application_connection_busy"|"application_connection_fenced"|"application_connection_people_unavailable"){
    super("SDK application connection unavailable");this.name="ApplicationUiConnectionError";
  }
}
interface Owned {
  readonly public:MdbaseApplicationConnection;
  readonly ui:AppWebCollectionClient;
  readonly lifetime:AbortController;
}
const seen=new WeakSet<MessagePort>();
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** SDK UI owner for the ONE original borrowed data client. Retire before issuing
 * a native switch. Logical/UI retirement is NOT physical native/SQL/lease drain:
 * the singleton must subsequently await the original SDK Worker shutdown ACK. */
export class ApplicationUiConnections {
  private readonly app:ClientOptions["app"];
  private readonly signal:AbortSignal;
  private current:Owned|null=null;
  private pending:Promise<MdbaseApplicationConnection>|null=null;
  private opening:AbortController|null=null;
  private retiring:Promise<void>|null=null;
  private closing:Promise<void>|null=null;
  private epoch=0;
  private readonly timerCriteria:readonly string[];
  constructor(app:ClientOptions["app"],signal:AbortSignal,timerCriteria:readonly string[]=[]){
    this.app=Object.freeze({...app});this.signal=signal;this.timerCriteria=Object.freeze([...timerCriteria]);
    signal.addEventListener("abort",this.abort,{once:true});
  }
  private readonly abort=()=>{void this.close().catch(()=>{});};
  connection(id:string):MdbaseApplicationConnection|null {
    const value=this.current?.public;return value?.id===id&&value.isCurrent()?value:null;
  }
  /** Only SDK-owned readiness/configuration may access the journal/control
   * projection. Public connection does not expose it, SQL or a native Host. */
  owned():AppWebCollectionClient|null{return this.current?.public.isCurrent()?this.current.ui:null;}
  adopt(value:AppWebCollectionHandoff,options:{readonly caller:AbortSignal;isCurrent():boolean}):Promise<MdbaseApplicationConnection>{
    const caller=options.caller,current=options.isCurrent;
    // Take original new ports exactly once, even if later metadata refuses.
    // Never close another already-owned generation's ports on duplicate input.
    const ports=[value.dataPort,value.controlPort,...(value.timerPort?[value.timerPort]:[])];
    if(ports.some(port=>!(port instanceof MessagePort))||new Set(ports).size!==ports.length||ports.some(port=>seen.has(port))){
      for(const port of new Set(ports))if(port instanceof MessagePort&&!seen.has(port)){seen.add(port);port.close();}
      return Promise.reject(new ApplicationUiConnectionError("application_connection_binding"));
    }
    for(const port of ports)seen.add(port);
    const reject=(code:ApplicationUiConnectionError["code"])=>{for(const port of ports)port.close();return Promise.reject(new ApplicationUiConnectionError(code));};
    if(this.pending||this.current||this.retiring)return reject("application_connection_busy");
    if(this.closing||this.signal.aborted||caller.aborted||!current())return reject("application_connection_fenced");
    const scope=Object.freeze({...value.scope}),generation=value.generation,displayName=value.displayName;
    if(value.schema!=="mdbn-app-collection/1"||Object.keys(scope).sort().join()!=="account,collection,installation"||Object.values(scope).some(id=>!uuid.test(id)||id==="00000000-0000-0000-0000-000000000000")||
      typeof generation!=="string"||!generation||generation.length>256||typeof displayName!=="string"||!displayName.trim()||new TextEncoder().encode(displayName).length>4096||
      !["inspect","approved-new","reconcile-original"].includes(value.setupMode))return reject("application_connection_binding");
    if(value.people!==true)return reject("application_connection_people_unavailable");
    const handoff=Object.freeze({...value,scope,generation,displayName});
    const lifetime=new AbortController(),epoch=this.epoch;
    this.opening=lifetime;
    const cancel=()=>lifetime.abort();caller.addEventListener("abort",cancel,{once:true});
    const signal=AbortSignal.any([this.signal,lifetime.signal]);
    const valid=()=>!signal.aborted&&!this.closing&&!this.retiring&&this.epoch===epoch&&current();
    let ui:AppWebCollectionClient|null=null;
    const pending=Promise.resolve().then(async()=>{
      if(!valid()||caller.aborted)throw new ApplicationUiConnectionError("application_connection_fenced");
      ui=await openAppWebCollectionClient(handoff,{app:this.app,signal,timerCriteria:this.timerCriteria});
      if(!valid()||caller.aborted)throw new ApplicationUiConnectionError("application_connection_fenced");
      if(ui.client.collection!==scope.collection||ui.client.link!=="open")throw new ApplicationUiConnectionError("application_connection_binding");
      if(!ui.people)throw new ApplicationUiConnectionError("application_connection_people_unavailable");
      const original=ui,people=ui.people;
      const publicConnection:MdbaseApplicationConnection=Object.freeze({id:scope.collection,scope,generation,displayName,records:original.client,files:original.client.files,people,
        ...(original.timers?{timers:original.timers}:{}),isCurrent:()=>valid()&&this.current?.ui===original&&original.client.link==="open"});
      this.current={public:publicConnection,ui:original,lifetime};return publicConnection;
    }).catch(error=>{lifetime.abort();ui?.close();for(const port of ports)port.close();throw error;}).finally(()=>{
      caller.removeEventListener("abort",cancel);if(this.pending===pending){this.pending=null;this.opening=null;}
    });
    this.pending=pending;return pending;
  }
  /** Immediate scope fencing, then original in-progress open/UI-close drain.
   * A failed closer retains the original owned object and memoized rejection. */
  retire():Promise<void>{
    if(this.retiring)return this.retiring;
    ++this.epoch;const owner=this.current,pending=this.pending;
    this.opening?.abort();owner?.lifetime.abort();
    const retired=Promise.resolve().then(async()=>{await pending?.catch(()=>{});owner?.ui.close();if(this.current===owner)this.current=null;});
    this.retiring=retired;
    void retired.then(()=>{if(this.retiring===retired)this.retiring=null;},()=>{/* retain original ownership/quarantine, no retry */});
    return retired;
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    // Set closing before any close observers can re-enter adoption.
    this.closing=Promise.resolve().then(()=>this.retire());
    this.signal.removeEventListener("abort",this.abort);++this.epoch;
    this.opening?.abort();this.current?.lifetime.abort();return this.closing;
  }
}
