import {applicationDeclaration,rebindApplicationDeclaration,type ApplicationDeclarationSnapshot,type MdbaseApplicationDeclaration} from "./declaration.js";
import {describeError} from "../describe-error.js";
import {currentAppOrigin,isAppOrigin,urlOrigin} from "../app-host/app-origin.js";
import {compileApplicationManifest} from "./manifest.js";
import {resolveApplicationRegistration} from "./registration.js";
import {packagedApplicationAssets} from "./packaged-assets.js";
import {appReleaseTrust} from "./packaged-trust.js";
import {selectAppEnvironment} from "../app-host/app-environment.js";
import {ApplicationRuntime,type MdbaseApplicationSnapshot as RuntimeSnapshot} from "./runtime.js";
import {ApplicationBrowserSelection,browserApplicationSelectionPort} from "./browser-selection.js";
import {ApplicationCollectionSelection,type ApplicationCollectionSelectionSnapshot,type ApplicationSelectionMemory,type ApplicationSelectionSession} from "./collection-selection.js";
import {APPLICATION_WORKER_PROTOCOL} from "./worker-protocol.js";
import {browserApplicationPortalHost,openerApplicationPortalHost,reserveApplicationPortal,type ApplicationPortalHost} from "./portal-reservation.js";
import {MdbaseError,mdbaseError} from "../errors.js";
import {registrationRefusal} from "./registration-refusal.js";
import type {MdbaseClient} from "../client.js";
import type {FilesApi} from "../files.js";
import type {MdbasePeopleClient} from "../people.js";
import type {TimersApi} from "../timers.js";
import type {AppWebSignInPortal,AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {AppReplicaScope} from "../app-host/owner.js";
import type {MdbaseApplicationSetup,MdbaseSetupPlan,MdbaseSetupPlanOptions} from "./setup.js";

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
export interface MdbaseCollectionDeleteOptions extends MdbaseApplicationRequestOptions {readonly confirmName:string}
/** Sign-in outside a popup: native shells (Capacitor `Browser.open`) and
 * browser extensions (`chrome.tabs.create`). The SDK still binds the URL to the
 * environment's Connect origin; `open` only displays it. */
export interface MdbaseSignInOpener {
  open(url:string):void|Promise<void>;
  /** Optional dismissal after sign-in finishes or is cancelled. */
  close?():void|Promise<void>;
  /** Appended as `return_url`; must equal one of the manifest's `redirect_uris`. */
  readonly returnUrl?:string;
}
export interface MdbaseConnectOptions {
  readonly signIn?:MdbaseSignInOpener;
  /** Drive `setForeground` from `document.visibilityState`, so returning from
   * the system browser or app switcher re-polls at once. Default false. */
  readonly followVisibility?:boolean;
}
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
  /** Reviewable setup of the open collection: `plan` for one review screen,
   * then `apply` that plan. `configure` is plan+apply with nothing to review. */
  readonly setup:MdbaseApplicationSetup;
  clearSelection(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Local presentation/selection only; never revoke consent or delete records. */
  forget(collectionId:string,options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Owner only, from an explicit confirmation: delete a collection for
   * everyone, on every device and app. `confirmName` is the name the person
   * typed; it must equal the collection's current name. A refusal rejects
   * with a `collection_delete_*` code for `describeError` and changes nothing
   * locally. On success the collection leaves `collections`. */
  deleteCollection(collectionId:string,options:MdbaseCollectionDeleteOptions):Promise<MdbaseApplicationSnapshot>;
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
    assess:refuse,configure:refuse,setup:Object.freeze({plan:refuse,apply:refuse}),clearSelection:refuse,forget:refuse,deleteCollection:refuse,setForeground(){throw unavailable();},close:refuse});
}
const browserHost=(origin:string)=>typeof Worker==="function"&&typeof MessageChannel==="function"&&currentAppOrigin()!==null&&isAppOrigin(origin,true);
function signInOpener(value:MdbaseSignInOpener|undefined):MdbaseSignInOpener|null{
  if(value===undefined)return null;
  const fail=():never=>{throw mdbaseError("invalid_request","Invalid sign-in opener","application_sign_in_opener");};
  if(!value||typeof value!=="object"||typeof value.open!=="function"||(value.close!==undefined&&typeof value.close!=="function"))return fail();
  const returnUrl=value.returnUrl;
  if(returnUrl!==undefined){
    let url:URL;try{url=new URL(returnUrl);}catch{return fail();}
    if(typeof returnUrl!=="string"||returnUrl.length>2048||url.username||url.password||url.hash||!isAppOrigin(urlOrigin(url),true))fail();
  }
  const open=value.open.bind(value),close=value.close?.bind(value);
  return Object.freeze({open,...(close?{close}:{}),...(returnUrl!==undefined?{returnUrl}:{})});
}
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
  private readonly signIn:MdbaseSignInOpener|null;
  constructor(declaration:MdbaseApplicationDeclaration,options:MdbaseConnectOptions={}){
    this.declaration=applicationDeclaration(declaration);compileApplicationManifest(this.declaration);
    this.signIn=signInOpener(options.signIn);
    if(!browserHost(this.declaration.origin)){this.app=unavailableApplication();return;}
    if(options.followVisibility===true)this.followVisibility();
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
      deleteCollection:(id:string,options:MdbaseCollectionDeleteOptions)=>this.track(async()=>{
        const selection=this.choose(),{confirmName,...request}=options??{} as MdbaseCollectionDeleteOptions;
        await this.call(runtime=>runtime.queue(()=>runtime.deleteCollection(id,confirmName,request)));
        if(selection.getSnapshot().requested.collectionId===id)await selection.select(null,request);
      }),
      assess:(options?:MdbaseApplicationRequestOptions)=>this.call(runtime=>runtime.queue(()=>runtime.assess(options))),
      configure:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.call(runtime=>runtime.queue(()=>runtime.configure(options)))),
      setup:Object.freeze({
        plan:(options?:MdbaseSetupPlanOptions)=>this.call(runtime=>runtime.queue(()=>runtime.planSetup(options))),
        apply:(plan:MdbaseSetupPlan,options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.call(runtime=>runtime.queue(()=>runtime.applySetup(plan,options)))),
      }),
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
      if(urlOrigin(moduleUrl)!==this.declaration.origin||currentAppOrigin()!==this.declaration.origin)throw mdbaseError("unavailable","Application module binding unavailable","application_worker_module_binding");
      const environment=this.environment();packagedApplicationAssets(this.declaration.environment,this.declaration.origin);
      // Registration resolves BEFORE any Worker, key, profile or DB allocation.
      const registered=await resolveApplicationRegistration({declaration:this.declaration,signal:this.lifetime.signal,isCurrent:()=>!this.closed});this.check();
      const declaration=rebindApplicationDeclaration(this.declaration,registered);
      if(registered.supersededDeclaredId)console.info(`mdbase: ${describeError("application_registration_id_superseded")!.developerMessage}`);
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
      if(!this.closed){
        const {problemDetail:_stale,...previous}=this.snapshot;
        // A registration refusal keeps only its re-validated code and manifest paths.
        const refusal=error instanceof MdbaseError&&error.reason==="application_registration_refused"?registrationRefusal(error.details):null;
        this.snapshot=Object.freeze({...previous,status:"blocked",problem:typeof error?.reason==="string"?error.reason:typeof error?.code==="string"?error.code:"application_entry_unavailable",
          ...(refusal?{problemDetail:Object.freeze({name:"MdbaseError",code:error.code,registration:refusal})}:{})});this.notify();
      }
      throw error;
    });
    this.initialization=pending;{const {problemDetail:_stale,...previous}=this.snapshot;this.snapshot=Object.freeze({...previous,status:"starting",problem:null});}this.notify();return pending;
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
      const lab=this.declaration.environment==="lab",current=()=>!this.closed;
      const host:ApplicationPortalHost=this.signIn?openerApplicationPortalHost(environment.cpOrigin,signal,current,this.signIn,lab):browserApplicationPortalHost(environment.cpOrigin,signal,current,lab);
      portal=reserveApplicationPortal(host);
    }catch(error){return Promise.reject(error);}
    return this.call(async runtime=>{await this.started(runtime,options);return runtime.queue(()=>runtime.authorizeReserved(portal,options,collectionHint));})
      .catch(error=>{try{portal.close();}catch{/* original stop failure retained by the portal */}throw error;});
  }
  private followVisibility():void{
    const doc=globalThis.document;if(!doc||typeof doc.addEventListener!=="function")return;
    const sync=()=>{if(!this.closed)this.app.setForeground(doc.visibilityState!=="hidden");};
    doc.addEventListener("visibilitychange",sync,{signal:this.lifetime.signal});sync();
  }
  private close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.lifetime.abort();this.selection?.close();
    this.closing=Promise.resolve().then(async()=>{
      // A registration/asset failure allocated no native resources; an installed
      // runtime always requires its original terminal ACK and UI/helper drains.
      await this.initialization?.catch(()=>{});await this.runtime?.close();
      {const {problemDetail:_stale,...previous}=this.snapshot;this.snapshot=Object.freeze({...previous,status:"closed",problem:null,selectedCollectionId:null});}this.runtime=null;this.notify();this.listeners.clear();this.nativeListeners.clear();
    });return this.closing;
  }
  application():MdbaseApplication{return this.app;}
  connection(collectionId:string):MdbaseApplicationConnection|null{return this.closed?null:this.runtime?.connection(collectionId)??null;}
}

