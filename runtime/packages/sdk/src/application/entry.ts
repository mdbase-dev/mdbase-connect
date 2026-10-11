import {applicationDeclaration,rebindApplicationDeclaration,type ApplicationDeclarationSnapshot,type MdbaseApplicationDeclaration} from "./declaration.js";
import {compileApplicationManifest} from "./manifest.js";
import {resolveApplicationRegistration} from "./registration.js";
import {packagedApplicationAssets} from "./packaged-assets.js";
import {appReleaseTrust} from "./packaged-trust.js";
import {selectAppEnvironment} from "../app-host/app-environment.js";
import {ApplicationRuntime,type MdbaseApplicationSnapshot as RuntimeSnapshot} from "./runtime.js";
import {ApplicationBrowserSelection,browserApplicationSelectionPort} from "./browser-selection.js";
import {ApplicationCollectionSelection,type ApplicationCollectionSelectionSnapshot,type ApplicationSelectionMemory,type ApplicationSelectionSession} from "./collection-selection.js";
import {APPLICATION_WORKER_PROTOCOL} from "./worker-protocol.js";
import {browserApplicationPortalHost,reserveApplicationPortal} from "./portal-reservation.js";
import {mdbaseError} from "../errors.js";
import type {MdbaseClient} from "../client.js";
import type {FilesApi} from "../files.js";
import type {MdbasePeopleClient} from "../people.js";
import type {TimersApi} from "../timers.js";
import type {AppWebSignInPortal,AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {AppReplicaScope} from "../app-host/owner.js";

export type MdbaseApplicationFacet="capabilities"|"contracts"|"configuration"|"files"|"people"|"notifications";
export interface MdbaseApplicationProblem {readonly code:string}
export interface MdbaseApplicationAssessment {
  readonly status:"ready"|"setup_required"|"incompatible";
  readonly problem:MdbaseApplicationProblem|null;
}
export interface MdbaseApplicationFacetSnapshot {
  readonly checking:boolean;
  /** Null while checking/unsupported/read-failed; never invented READY. */
  readonly assessment:MdbaseApplicationAssessment|null;
  readonly problem:MdbaseApplicationProblem|null;
}
export interface MdbaseApplicationReadinessSnapshot extends MdbaseApplicationFacetSnapshot {
  readonly facets:Readonly<Record<MdbaseApplicationFacet,MdbaseApplicationFacetSnapshot>>;
}
export interface MdbaseApplicationSnapshot extends AppWebSignInSnapshot {
  readonly readiness:MdbaseApplicationReadinessSnapshot;
  /** Requested (URL/user/memory) versus usable (actually open) collection. */
  readonly selection:ApplicationCollectionSelectionSnapshot;
}
export interface MdbaseApplicationRequestOptions {readonly signal?:AbortSignal}
export interface MdbaseApplicationConnection {
  readonly id:string;
  readonly displayName:string;
  readonly scope:Readonly<AppReplicaScope>;
  readonly generation:string;
  /** Actual public borrowed UI client, not a legacy facade or second engine. */
  readonly records:MdbaseClient;
  /** SAME records.files. Available accessors do not widen original authority. */
  readonly files:FilesApi;
  readonly people:MdbasePeopleClient;
  readonly timers?:TimersApi;
  isCurrent():boolean;
}
export interface MdbaseApplication {
  getSnapshot():MdbaseApplicationSnapshot;
  subscribe(listener:()=>void):()=>void;
  start(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Call from the user gesture (reserves the Connect popup synchronously):
   * sign in, or approve the requested collection. Same as approve(). */
  authorize(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  select(collectionId:string,options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Call from the user gesture: approve one named collection (default: the requested one; none: choose in Connect). */
  approve(collectionId?:string|null,options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Call from the user gesture: re-approve the open/requested collection. */
  reauthorize(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Close the current collection and return to the chooser; Back restores it. */
  chooseAnother(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Refresh current aggregate evidence; checking/read errors never become READY. */
  assess(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationReadinessSnapshot>;
  /** Explicitly configure the current scope from its canonical declaration.
   * No caller operations/plan/SQL; original recovery and consent stay SDK-owned. */
  configure(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  clearSelection(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Local presentation/selection only; never revoke consent or delete records. */
  forget(collectionId:string,options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  setForeground(active:boolean):void;
  close():Promise<void>;
}
/** Structural public consumer port; production uses MdbaseConnect. Explicit
 * SDK testing fixtures may implement this without private fields or casts. */
export interface MdbaseApplicationEntry {
  application():MdbaseApplication;
  connection(collectionId:string):MdbaseApplicationConnection|null;
}
export class MdbaseApplicationUnavailableError extends Error {
  readonly code="application_not_yet_available";
  constructor(){super("MdbaseConnect application runtime is not yet available");this.name="MdbaseApplicationUnavailableError";}
}
const problem=Object.freeze({code:"application_not_yet_available"});
const facet=Object.freeze({checking:false,assessment:null,problem});
const readiness:MdbaseApplicationReadinessSnapshot=Object.freeze({checking:false,assessment:null,problem,
  facets:Object.freeze({capabilities:facet,contracts:facet,configuration:facet,files:facet,people:facet,notifications:facet})});
const emptyFacet=Object.freeze({checking:false,assessment:null,problem:null});
const emptyReadiness:MdbaseApplicationReadinessSnapshot=Object.freeze({checking:false,assessment:null,problem:null,
  facets:Object.freeze({capabilities:emptyFacet,contracts:emptyFacet,configuration:emptyFacet,files:emptyFacet,people:emptyFacet,notifications:emptyFacet})});
const unavailable=()=>new MdbaseApplicationUnavailableError();
const noSelection:ApplicationCollectionSelectionSnapshot=Object.freeze({state:"none",problem:null,usable:null,
  requested:Object.freeze({collectionId:null,source:"none",displayName:null,approved:false})});
/** Honest shell where the SDK cannot host its own module Worker (SSR, Node,
 * non-browser tests, non-web origins). Performs no registration, key, Worker,
 * storage, network or popup IO and never returns a fake client/READY state. */
function unavailableApplication():MdbaseApplication{
  const snapshot:MdbaseApplicationSnapshot=Object.freeze({status:"blocked",signIn:null,collections:Object.freeze([]),selectedCollectionId:null,problem:problem.code,timing:null,readiness,selection:noSelection});
  const refuse=()=>Promise.reject(unavailable());
  return Object.freeze({getSnapshot:()=>snapshot,subscribe:()=>()=>{},start:refuse,authorize:refuse,select:refuse,approve:refuse,reauthorize:refuse,chooseAnother:refuse,
    assess:refuse,configure:refuse,clearSelection:refuse,forget:refuse,setForeground(){throw unavailable();},close:refuse});
}
const browserHost=(origin:string)=>typeof Worker==="function"&&typeof MessageChannel==="function"&&typeof globalThis.location?.origin==="string"&&/^https?:$/.test(new URL(origin).protocol);
/** Last-used collection, a REQUESTED hint only (never approval). Optional storage. */
function selectionMemory(namespace:string):ApplicationSelectionMemory{
  const key=`mdbase.${namespace}.selected-collection.v1`;
  return Object.freeze({read:()=>{try{return globalThis.localStorage?.getItem(key)??null;}catch{return null;}},
    write:(id:string|null)=>{try{if(id===null)globalThis.localStorage?.removeItem(key);else globalThis.localStorage?.setItem(key,id);}catch{/* hint storage is optional */}}});
}
/** Declaration-only public entry. Construction is IO-free; SDK registration,
 * same-artifact Worker and original profile/SQL start lazily on the first
 * action. The URL names the requested collection; sign-in approval decides what
 * opens. No app factories, private authority hooks, replacement actors or
 * transport-only READY. */
export class MdbaseConnect implements MdbaseApplicationEntry {
  private readonly app:MdbaseApplication;private readonly declaration:Readonly<ApplicationDeclarationSnapshot>;
  private readonly lifetime=new AbortController();private readonly listeners=new Set<()=>void>();private readonly nativeListeners=new Set<()=>void>();
  private readonly selection:ApplicationCollectionSelection|null=null;
  private runtime:ApplicationRuntime|null=null;private initialization:Promise<ApplicationRuntime>|null=null;
  private closing:Promise<void>|null=null;private closed=false;private foreground=true;
  private snapshot:RuntimeSnapshot=Object.freeze({status:"not_started",signIn:null,collections:Object.freeze([]),selectedCollectionId:null,problem:null,timing:null,readiness:emptyReadiness});
  private composed:{base:RuntimeSnapshot;selection:ApplicationCollectionSelectionSnapshot;value:MdbaseApplicationSnapshot}|null=null;
  constructor(declaration:MdbaseApplicationDeclaration){
    this.declaration=applicationDeclaration(declaration);compileApplicationManifest(this.declaration);
    if(!browserHost(this.declaration.origin)){this.app=unavailableApplication();return;}
    this.selection=new ApplicationCollectionSelection({browser:new ApplicationBrowserSelection(this.declaration.origin,{},browserApplicationSelectionPort()),
      session:this.selectionSession(),memory:selectionMemory(this.declaration.storage.applicationNamespace)});
    this.selection.subscribe(()=>this.notify(false));
    const view=()=>this.getSnapshot();
    this.app=Object.freeze({getSnapshot:view,subscribe:(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};},
      start:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.call(runtime=>this.started(runtime,options))),
      authorize:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().approve(undefined,options)),
      approve:(id?:string|null,options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().approve(id,options)),
      reauthorize:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().reauthorize(options)),
      select:(id:string,options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().select(id,options)),
      clearSelection:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().select(null,options)),
      chooseAnother:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().chooseAnother(options)),
      forget:(id:string,options?:MdbaseApplicationRequestOptions)=>this.track(async()=>{
        const selection=this.choose();await this.call(runtime=>runtime.queue(()=>runtime.forget(id,options)));
        if(selection.getSnapshot().requested.collectionId===id)await selection.select(null,options);
      }),
      assess:(options?:MdbaseApplicationRequestOptions)=>this.call(runtime=>runtime.queue(()=>runtime.assess(options))),
      configure:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.call(runtime=>runtime.queue(()=>runtime.configure(options)))),
      setForeground:(active:boolean)=>{this.foreground=active;this.runtime?.setForeground(active);},close:()=>this.close()});
  }
  private getSnapshot():MdbaseApplicationSnapshot{
    const base=this.runtime?.getSnapshot()??this.snapshot,selection=this.selection?.getSnapshot()??noSelection,last=this.composed;
    if(last&&last.base===base&&last.selection===selection)return last.value;
    const value:MdbaseApplicationSnapshot=Object.freeze({...base,selection});this.composed={base,selection,value};return value;
  }
  private notify(native=true):void{
    if(native)for(const listener of [...this.nativeListeners])try{listener();}catch{/* selection observes, never owns lifecycle */}
    for(const listener of [...this.listeners])try{listener();}catch{/* UI observers cannot own initialization */}
  }
  /** Selection starts with the first action: it reads the URL request and
   * follows Back/forward. Explicit actions still call the session themselves. */
  private choose():ApplicationCollectionSelection{this.check();const selection=this.selection!;selection.start();return selection;}
  private async track(action:()=>Promise<unknown>):Promise<MdbaseApplicationSnapshot>{await action();return this.getSnapshot();}
  /** SDK-private port over the ONE runtime. Retire-before-switch and the
   * same-scope fast path live in runtime.select; the popup is reserved here
   * synchronously, before lazy registration/Worker startup awaits. */
  private selectionSession():ApplicationSelectionSession{
    return Object.freeze({
      getSnapshot:()=>this.runtime?.getNativeSnapshot()??this.snapshot,
      subscribe:(listener:()=>void)=>{this.nativeListeners.add(listener);return()=>{this.nativeListeners.delete(listener);};},
      open:(id:string,options:MdbaseApplicationRequestOptions={})=>this.call(runtime=>runtime.queue(()=>runtime.select(id,options))),
      clear:(options:MdbaseApplicationRequestOptions={})=>this.call(runtime=>runtime.queue(()=>runtime.clearSelection(options))),
      authorize:(options:MdbaseApplicationRequestOptions&{readonly collectionHint?:string|null}={})=>this.authorize(options,options.collectionHint??null),
    });
  }
  private check():void{if(this.closed||this.lifetime.signal.aborted)throw mdbaseError("cancelled","Application entry fenced","application_entry_fenced");}
  private environment(){return selectAppEnvironment({environment:this.declaration.environment,appOrigin:this.declaration.origin,release:appReleaseTrust()});}
  private initialize():Promise<ApplicationRuntime>{
    if(this.initialization)return this.initialization;
    const pending=Promise.resolve().then(async()=>{
      this.check();
      // Classic IIFE/relocated/foreign factories are unsupported. No DOM,
      // currentScript, guessed CDN/path or application-supplied loader fallback.
      if(typeof import.meta.url!=="string")throw unavailable();
      const moduleUrl=new URL(import.meta.url);
      if(moduleUrl.origin!==this.declaration.origin||globalThis.location.origin!==this.declaration.origin)throw mdbaseError("unavailable","Application module binding unavailable","application_worker_module_binding");
      const environment=this.environment();packagedApplicationAssets(this.declaration.environment,this.declaration.origin);
      // Registration resolves BEFORE any Worker, key, profile or DB allocation.
      const registered=await resolveApplicationRegistration({declaration:this.declaration,signal:this.lifetime.signal,isCurrent:()=>!this.closed});this.check();
      const declaration=rebindApplicationDeclaration(this.declaration,registered);
      const channel=new MessageChannel(),binding=crypto.randomUUID();let worker:Worker;
      // Literal module-relative form so app bundlers emit the SDK Worker chunk.
      try{worker=new Worker(new URL("./worker.js",import.meta.url),{type:"module"});}catch{channel.port1.close();channel.port2.close();throw mdbaseError("unavailable","Application Worker construction unavailable","application_worker_unavailable");}
      const failed=(event:Event)=>{event.preventDefault();channel.port1.dispatchEvent(new MessageEvent("messageerror"));};worker.addEventListener("error",failed);
      const runtime=new ApplicationRuntime({declaration,cpOrigin:environment.cpOrigin,port:channel.port1,binding,releaseWorker:()=>{worker.removeEventListener("error",failed);worker.terminate();}});
      try{worker.postMessage([APPLICATION_WORKER_PROTOCOL,binding,declaration],[channel.port2]);}catch{
        // No startup request was accepted; the original bootstrap transfer failed.
        worker.removeEventListener("error",failed);worker.terminate();channel.port1.close();channel.port2.close();throw mdbaseError("unavailable","Application bootstrap unavailable","application_worker_binding");
      }
      this.runtime=runtime;runtime.subscribe(()=>this.notify());runtime.setForeground(this.foreground);this.notify();return runtime;
    }).catch(error=>{
      // Nothing native was allocated (no runtime installed), so a later explicit
      // action may retry; registration itself retries only its exact upsert.
      if(this.initialization===pending)this.initialization=null;
      if(!this.closed){this.snapshot=Object.freeze({...this.snapshot,status:"blocked",problem:typeof error?.reason==="string"?error.reason:typeof error?.code==="string"?error.code:"application_entry_unavailable"});this.notify();}
      throw error;
    });
    this.initialization=pending;this.snapshot=Object.freeze({...this.snapshot,status:"starting",problem:null});this.notify();return pending;
  }
  private async call<T>(action:(runtime:ApplicationRuntime)=>Promise<T>):Promise<T>{this.check();const runtime=await this.initialize();this.check();return action(runtime);}
  /** Sign-in start is idempotent in the native session; every lifecycle action
   * that needs the protected request runs it first. */
  private started(runtime:ApplicationRuntime,options?:MdbaseApplicationRequestOptions):Promise<unknown>{
    this.choose();const status=runtime.getNativeSnapshot().status;
    return status==="not_started"||status==="starting"||(status==="blocked"&&!runtime.getNativeSnapshot().signIn)?runtime.queue(()=>runtime.start(options)):Promise.resolve();
  }
  private authorize(options:MdbaseApplicationRequestOptions={},collectionHint:string|null=null):Promise<unknown>{
    // Reserve the SDK popup synchronously in the user gesture, before lazy
    // registration/Worker startup awaits.
    let portal:AppWebSignInPortal;try{
      this.check();const environment=this.environment(),signal=options.signal?AbortSignal.any([this.lifetime.signal,options.signal]):this.lifetime.signal;
      portal=reserveApplicationPortal(browserApplicationPortalHost(environment.cpOrigin,signal,()=>!this.closed,this.declaration.environment==="lab"));
    }catch(error){return Promise.reject(error);}
    return this.call(async runtime=>{await this.started(runtime,options);return runtime.queue(()=>runtime.authorizeReserved(portal,options,collectionHint));})
      .catch(error=>{try{portal.close();}catch{/* original stop failure retained by the portal */}throw error;});
  }
  private close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.lifetime.abort();this.selection?.close();
    this.closing=Promise.resolve().then(async()=>{
      // A registration/asset failure allocated no native resources; an installed
      // runtime always requires its original terminal ACK and UI/helper drains.
      await this.initialization?.catch(()=>{});await this.runtime?.close();
      this.snapshot=Object.freeze({...this.snapshot,status:"closed",problem:null,selectedCollectionId:null});this.runtime=null;this.notify();this.listeners.clear();this.nativeListeners.clear();
    });return this.closing;
  }
  application():MdbaseApplication{return this.app;}
  connection(collectionId:string):MdbaseApplicationConnection|null{return this.closed?null:this.runtime?.connection(collectionId)??null;}
}

