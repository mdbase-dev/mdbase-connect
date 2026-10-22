import {applicationDeclaration,rebindApplicationDeclaration,type ApplicationDeclarationSnapshot,type MdbaseApplicationDeclaration} from "./declaration.js";
import {describeDiagnostic} from "../describe-error.js";
import {currentAppOrigin,isAppOrigin,urlOrigin} from "../app-host/app-origin.js";
import {compileApplicationManifest} from "./manifest.js";
import {declaredReturnUrl} from "./return-url.js";
import {resolveApplicationRegistration} from "./registration.js";
import {packagedApplicationAssets} from "./packaged-assets.js";
import {appReleaseTrust} from "./packaged-trust.js";
import {applicationLoopbackAllowed} from "./local-build.js";
import {selectAppEnvironment} from "../app-host/app-environment.js";
import {ApplicationRuntime,type MdbaseApplicationSnapshot as RuntimeSnapshot} from "./runtime.js";
import {ApplicationBrowserSelection,browserApplicationSelectionPort} from "./browser-selection.js";
import {ApplicationCollectionSelection,type ApplicationCollectionSelectionSnapshot,type ApplicationSelectionMemory,type ApplicationSelectionSession} from "./collection-selection.js";
import {APPLICATION_WORKER_PROTOCOL} from "./worker-protocol.js";
import {browserApplicationPortalHost,openerApplicationPortalHost,reserveApplicationPortal,type ApplicationPortalHost} from "./portal-reservation.js";
import {MdbaseError,mdbaseError} from "../errors.js";
import {awaitFileAccess,consentedFileActions,fileAccessDeclaration,grantedResult,missingFileActions,type MdbaseAccessRequest,type MdbaseAccessRequestOptions,type MdbaseAccessResult} from "./file-access.js";
import {registrationRefusal} from "./registration-refusal.js";
import type {MdbaseClient} from "../client.js";
import type {FilesApi} from "../files.js";
import type {MdbasePeopleClient} from "../people.js";
import type {TimersApi} from "../timers.js";
import type {AppWebSignInPortal,AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import {waitForAppSignInRelease,type AppLockWaitPort,type AppReplicaScope} from "../app-host/owner.js";
import {ApplicationTabs,type ApplicationTabLocks} from "./tabs.js";
import {probeBrowserCapabilities} from "./browser-capabilities.js";
import {appSaveState,appStoragePolicy,type AppStoragePolicy} from "../app-host/status.js";
/** Resolves when the document is (or becomes) visible; non-document hosts count as visible. */
function whenVisible(signal:AbortSignal):Promise<void>{
  const doc=globalThis.document;if(!doc||typeof doc.addEventListener!=="function"||doc.visibilityState!=="hidden")return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const done=()=>{if(doc.visibilityState==="hidden")return;doc.removeEventListener("visibilitychange",done);signal.removeEventListener("abort",stop);resolve();};
    const stop=()=>{doc.removeEventListener("visibilitychange",done);reject(signal.reason);};
    doc.addEventListener("visibilitychange",done);signal.addEventListener("abort",stop,{once:true});
  });
}
import type {MdbaseApplicationSetup,MdbaseSetupPlan,MdbaseSetupPlanOptions} from "./setup.js";
import {applicationPhase,SLOW_OPENING_MS,type MdbasePhase} from "./phase.js";
import {summarizeStatus,type StatusSummary,type TransportHealth} from "../status.js";
import type {WriteLedgerSnapshot} from "../write-ledger.js";
import {applicationForgotten,type ApplicationForgottenStore} from "./forgotten.js";
import {applicationSessionHint,type ApplicationSessionHint,type ApplicationSessionHintStore} from "./session-hint.js";
import type {AppWebSignOutResult} from "../app-host/web-sign-in-session.js";
import type {SyncStatus} from "../wire.js";
import {ApplicationPrivateCollections,withPrivateCollections} from "./private-collections.js";

export type MdbaseApplicationFacet="capabilities"|"contracts"|"configuration"|"files"|"people"|"notifications";
export interface MdbaseApplicationProblem {readonly code:string}
/** A declared type the app cannot use: its definition has an error-level issue.
 * Listed only with `readiness: {typeIssues: "degrade"}`. Pass an entry to
 * `describeError` for the copy; show the rest of the collection as usual. */
export interface MdbaseUnavailableType {
  readonly name:string;
  readonly path:string;
  readonly contract:{readonly id:string;readonly version:string};
  readonly problem:MdbaseApplicationProblem;
}
export interface MdbaseApplicationAssessment {
  readonly status:"ready"|"setup_required"|"incompatible";
  readonly problem:MdbaseApplicationProblem|null;
  /** Present only when types degrade and at least one declared type is unusable. */
  readonly unavailableTypes?:readonly MdbaseUnavailableType[];
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
  /** R1: the one derived state for UI. Switch on `phase.kind`; never hand-roll
   * a ready check from `status`/`readiness`. Always set by the SDK entry. */
  readonly phase?:MdbasePhase;
  /** Sync of the open collection (null until it is ready). */
  readonly sync?:StatusSummary|null;
  /** R2: unconfirmed and refused writes of the open collection, and the save
   * state to show (null until it is ready). Survives a reload. */
  readonly writes?:WriteLedgerSnapshot|null;
  /** On-device storage policy for this origin, read by the SDK (null where the
   * SDK cannot tell). `persistent` is the browser's answer, never a durability
   * claim: only a log-confirmed receipt counts as saved. */
  readonly storage?:AppStoragePolicy|null;
  /** Pending replica edits on nonpersistent storage: set after 30 seconds
   * continuously pending, or immediately while disconnected. Normal online
   * edits do not flash a warning. Null at zero pending or with persistence. */
  readonly saveWarning?:"storage_may_be_evicted"|null;
  /** Connect pages for this account (SDK-4). Null where the SDK cannot run. */
  readonly links?:MdbaseLinks|null;
}
/** SDK-4: Connect pages an app links to rather than building its own. */
export interface MdbaseLinks {
  /** The account page: profile, collections, sign-in. */
  readonly account:string;
  /** Apps with access to the account's collections; revoke access there. */
  readonly manageAccess:string;
}
export interface MdbaseApplicationRequestOptions {readonly signal?:AbortSignal}
export interface MdbaseCollectionDeleteOptions extends MdbaseApplicationRequestOptions {readonly confirmName:string}
export interface MdbaseSignOutOptions extends MdbaseApplicationRequestOptions {
  /** Sign out even though changes on this device have not reached mdbase yet;
   * they are lost. Without it, signOut rejects with `sign_out_pending_writes`. */
  readonly discard?:boolean;
}
/** Sign-in outside a popup: native shells (Capacitor `Browser.open`) and
 * browser extensions (`chrome.tabs.create`). The SDK still binds the URL to the
 * environment's Connect origin; `open` only displays it. */
export interface MdbaseSignInOpener {
  open(url:string):void|Promise<void>;
  /** Optional dismissal after sign-in finishes or is cancelled. */
  close?():void|Promise<void>;
  /** Appended as `return_url`. Must exactly equal one of the manifest's
   * `redirect_uris`: an https URL on the homepage origin, or a native app's
   * private-use scheme derived from the manifest ID (RFC 8252), e.g.
   * `dev.example.app://auth/mdbase/callback` for ID `dev.example.app`. */
  readonly returnUrl?:string;
}
export interface MdbaseConnectOptions {
  readonly signIn?:MdbaseSignInOpener;
  /** Drive `setForeground` from `document.visibilityState`, and sync at once
   * when the page regains focus or the network comes back. A hidden page only
   * finishes sending pending writes (for at most two minutes). Default true;
   * false leaves `setForeground` to the app. */
  readonly followVisibility?:boolean;
  /** Readiness policy. `typeIssues: "degrade"` keeps the collection ready when
   * one of the app's own types has an error-level definition issue, and lists
   * it in `readiness.assessment.unavailableTypes`; the app must then treat
   * that type as unavailable. Default "block". Issues on definitions the app
   * does not declare never affect readiness. */
  readonly readiness?:{readonly typeIssues?:"block"|"degrade"};
  /** SDK-10: list this browser's Private collections (kept on the person's
   * computers) in `collections` and open them by the same selection. Default
   * true; false for an app that lists them itself through the app-grant entry. */
  readonly privateCollections?:boolean;
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
  /** Call from the user gesture the first time the app needs an optional file
   * action (for example adding an image). Resolves `granted` at once when it
   * is already allowed; otherwise opens Connect for the open collection with
   * your one-line reason. No reload: the connection and app state stay. An
   * action the manifest does not declare rejects with `access_undeclared`.
   * File writes the person has not allowed reject with `access_required`. */
  requestAccess(request:MdbaseAccessRequest,options:MdbaseAccessRequestOptions):Promise<MdbaseAccessResult>;
  /** Call from the user gesture: re-approve the open/requested collection. */
  reauthorize(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
  /** Re-read the approved collection list now (for example when a switcher
   * opens). Focus and visibility already refresh it. */
  refreshCollectionList?(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
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
  /** Sign out of mdbase on this device: ends the server session and removes
   * this browser's sign-in data, keys and cached collections for the account.
   * Rejects with `sign_out_pending_writes` (a `conflict`) while changes have not
   * reached mdbase, unless `{discard: true}`. Resolves signed out; Sign in works
   * again without a reload, and a reload stays signed out. A server sign-out
   * that could not complete (offline) still signs this device out; it shows
   * in `signOutResult`. Optional for other implementations of this interface. */
  signOut?(options?:MdbaseSignOutOptions):Promise<MdbaseApplicationSnapshot>;
  /** SDK-10. Call from the user gesture (reserves the popup synchronously):
   * give this app one of the person's Private collections (kept on their
   * computers), then open it. It joins `collections` with `kind: "private"`.
   * Optional for other implementations of this interface. */
  addPrivateCollection?(options?:MdbaseApplicationRequestOptions):Promise<MdbaseApplicationSnapshot>;
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
  const base={status:"blocked" as const,signIn:null,collections:Object.freeze([]),selectedCollectionId:null,problem:problem.code,timing:null,readiness,selection:noSelection};
  const snapshot:MdbaseApplicationSnapshot=Object.freeze({...base,phase:applicationPhase(base),sync:null,writes:null,links:null});
  const refuse=()=>Promise.reject(unavailable());
  return Object.freeze({getSnapshot:()=>snapshot,subscribe:()=>()=>{},start:refuse,authorize:refuse,select:refuse,approve:refuse,reauthorize:refuse,refreshCollectionList:refuse,requestAccess:refuse,chooseAnother:refuse,
    assess:refuse,configure:refuse,setup:Object.freeze({plan:refuse,apply:refuse}),clearSelection:refuse,forget:refuse,deleteCollection:refuse,setForeground(){throw unavailable();},close:refuse,signOut:refuse});
}
const browserHost=(origin:string)=>typeof Worker==="function"&&typeof MessageChannel==="function"&&currentAppOrigin()!==null&&isAppOrigin(origin,true);
function signInOpener(value:MdbaseSignInOpener|undefined,declaration:ApplicationDeclarationSnapshot):MdbaseSignInOpener|null{
  if(value===undefined)return null;
  const fail=():never=>{throw mdbaseError("invalid_request","Invalid sign-in opener","application_sign_in_opener");};
  if(!value||typeof value!=="object"||typeof value.open!=="function"||(value.close!==undefined&&typeof value.close!=="function"))return fail();
  const returnUrl=value.returnUrl;
  if(returnUrl!==undefined){
    if(!declaredReturnUrl(returnUrl,declaration.manifest,applicationLoopbackAllowed(declaration.environment)))fail();
  }
  const open=value.open.bind(value),close=value.close?.bind(value);
  return Object.freeze({open,...(close?{close}:{}),...(returnUrl!==undefined?{returnUrl}:{})});
}
/** Page-side sign-out follow-up: the app's Web Push subscription (created on
 * the page by `registerWebPush`) and console diagnostics. Never throws. */
async function signOutDiagnostics(result:AppWebSignOutResult):Promise<void>{
  let push=true;
  if(result.webPush){
    const container=(globalThis.navigator as {serviceWorker?:ServiceWorkerContainer}|undefined)?.serviceWorker;
    let timer:ReturnType<typeof setTimeout>|undefined;
    if(container&&typeof container.getRegistration==="function")push=await Promise.race([(async()=>{
      const subscription=await (await container.getRegistration())?.pushManager?.getSubscription();
      return subscription?await subscription.unsubscribe():true;
    })().catch(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),5_000);})]).finally(()=>clearTimeout(timer));
  }
  try{
    if(result.server==="incomplete")console.warn("mdbase: signed out on this device, but mdbase could not be reached to end the session. This device stays listed under the account until it is removed there.");
    if(result.local==="incomplete"||!push)console.warn("mdbase: signed out, but some local data on this device could not be removed.");
  }catch{/* no console */}
}
/** Last-used collection, a REQUESTED hint only (never approval). Optional storage. */
function selectionMemory(namespace:string):ApplicationSelectionMemory{
  const key=`mdbase.${namespace}.selected-collection.v1`;
  return Object.freeze({read:()=>{try{return globalThis.localStorage?.getItem(key)??null;}catch{return null;}},
    write:(id:string|null)=>{try{if(id===null)globalThis.localStorage?.removeItem(key);else globalThis.localStorage?.setItem(key,id);}catch{/* hint storage is optional */}}});
}
/** The application entry. New code: `createMdbase(declaration)`, the same
 * entry with a strict snapshot; `MdbaseConnect` keeps its name for one cut.
 * Declaration-only public entry. Construction is IO-free; SDK registration,
 * same-artifact Worker and original profile/SQL start lazily on the first
 * action. The URL names the requested collection; sign-in approval decides what
 * opens. No app factories, private authority hooks, replacement actors or
 * transport-only READY. */
export class MdbaseConnect implements MdbaseApplicationEntry {
  private readonly app:MdbaseApplication;private readonly declaration:Readonly<ApplicationDeclarationSnapshot>;
  private readonly compiled:ReturnType<typeof compileApplicationManifest>;
  private readonly lifetime=new AbortController();private readonly listeners=new Set<()=>void>();private readonly nativeListeners=new Set<()=>void>();
  private readonly selection:ApplicationCollectionSelection|null=null;private readonly memory:ApplicationSelectionMemory|null=null;
  private runtime:ApplicationRuntime|null=null;private initialization:Promise<ApplicationRuntime>|null=null;
  private closing:Promise<void>|null=null;private closed=false;private foreground=true;
  /** Page lifecycle: bumped on every pagehide; set while the page is hidden. */
  private incarnation=0;private hidden:{readonly resume:boolean}|null=null;
  /** This page's tab group (leader or follower), and the current election. */
  private tabs:ApplicationTabs|null=null;private election:AbortController|null=null;private signingOut=false;
  private snapshot:RuntimeSnapshot=Object.freeze({status:"not_started",signIn:null,collections:Object.freeze([]),selectedCollectionId:null,problem:null,timing:null,readiness:emptyReadiness});
  private composed:{base:RuntimeSnapshot;selection:ApplicationCollectionSelectionSnapshot;revision:number;hint:ApplicationSessionHint|null;value:MdbaseApplicationSnapshot}|null=null;
  private readonly hint:ApplicationSessionHintStore|null=null;private readonly forgotten:ApplicationForgottenStore|null=null;
  private handledApproval:unknown=null;private refreshing:Promise<unknown>|null=null;private refreshedAt=0;
  /** Bumped by state outside base/selection: the slow-opening timer and sync. */
  private revision=0;
  private readonly links:MdbaseLinks|null=null;private readonly cpOrigin:string|null=null;
  private opening:{readonly id:string;slow:boolean;timer:ReturnType<typeof setTimeout>}|null=null;
  private syncing:{readonly id:string;readonly stop:()=>void;status:SyncStatus|null;writes:()=>WriteLedgerSnapshot|null}|null=null;
  /** On-device storage policy for this origin; null where it cannot be read. */
  private storagePolicy:AppStoragePolicy|null=null;
  private pendingSave:{readonly id:string;readonly since:number;timer:ReturnType<typeof setTimeout>|null}|null=null;
  private readonly signIn:MdbaseSignInOpener|null;private readonly typeIssues:"block"|"degrade";
  /** SDK-10: this tab's Private collections (page-side thin clients, never the Worker). */
  private readonly privates:ApplicationPrivateCollections|null=null;
  private readonly overlaid=new WeakMap<object,{revision:number;value:object}>();
  constructor(declaration:MdbaseApplicationDeclaration,options:MdbaseConnectOptions={}){
    this.declaration=applicationDeclaration(declaration);this.compiled=compileApplicationManifest(this.declaration);
    const typeIssues=options.readiness?.typeIssues??"block";
    if(typeIssues!=="block"&&typeIssues!=="degrade")throw new TypeError('readiness.typeIssues must be "block" or "degrade"');
    this.typeIssues=typeIssues;
    this.signIn=signInOpener(options.signIn,this.declaration);
    if(!browserHost(this.declaration.origin)){this.app=unavailableApplication();return;}
    try{const cp=this.environment().cpOrigin;this.cpOrigin=cp;this.hint=applicationSessionHint(this.declaration.storage.applicationNamespace,cp);this.forgotten=applicationForgotten(this.declaration.storage.applicationNamespace,cp);this.links=Object.freeze({account:`${cp}/account`,manageAccess:`${cp}/account/applications`});}catch{/* no links where the environment is unknown */}
    if(options.followVisibility!==false)this.followVisibility();
    this.followPageLifecycle();this.followFocus();this.followStoragePolicy();
    this.memory=selectionMemory(this.declaration.storage.applicationNamespace);
    if(options.privateCollections!==false)this.privates=new ApplicationPrivateCollections({declaration:this.declaration,onChange:()=>{this.revision++;this.notify();}});
    this.selection=new ApplicationCollectionSelection({browser:new ApplicationBrowserSelection(this.declaration.origin,{},browserApplicationSelectionPort()),
      session:this.selectionSession(),memory:this.memory});
    this.selection.subscribe(()=>{this.unforgetApproved();this.notify(false);});
    const view=()=>this.getSnapshot();
    this.app=Object.freeze({getSnapshot:view,subscribe:(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};},
      start:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.call(runtime=>this.started(runtime,options)).catch(error=>{
        // Open in another tab is a wait, not a failure: the snapshot says so and
        // this tab takes over by itself when the other one lets go.
        const native=this.runtime?.getNativeSnapshot();
        if((error as {code?:unknown})?.code==="open_in_another_tab"&&native?.status==="blocked"&&native.problem==="open_in_another_tab")return;
        throw error;
      })),
      authorize:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().approve(undefined,options)),
      approve:(id?:string|null,options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().approve(id,options)),
      reauthorize:(options?:MdbaseApplicationRequestOptions)=>{
        const id=this.privates?.state()?.collectionId??null;
        return id?this.track(()=>this.choose().approve(id,options)):this.track(()=>this.choose().reauthorize(options));
      },
      addPrivateCollection:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().approve(undefined,options)),
      refreshCollectionList:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>Promise.all([this.call(runtime=>runtime.queue(()=>runtime.refreshCollections(options))),this.privates?.refresh(this.account()).catch(()=>{})])),
      requestAccess:(request:MdbaseAccessRequest,options:MdbaseAccessRequestOptions)=>this.requestAccess(request,options),
      // The person switching collections: a pushed history entry, so Back
      // returns to the previous one. SDK corrections replace the entry.
      select:(id:string,options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().select(id,{...options,history:"push"})),
      clearSelection:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().select(null,options)),
      chooseAnother:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.choose().chooseAnother(options)),
      forget:(id:string,options?:MdbaseApplicationRequestOptions)=>this.track(async()=>{
        // SDK-3: hidden on this device for this account, across reloads; a later
        // approval shows it again. Without a signed-in account, the session forgets it.
        const selection=this.choose(),account=this.account();
        if(this.privates?.has(id)){
          // A Private grant lives in this browser only: forgetting it drops it.
          await this.privates.forget(id);
          if(selection.getSnapshot().requested.collectionId===id)await selection.select(null,options);
          return;
        }
        if(account&&this.forgotten){
          this.forgotten.add(account,id);this.revision++;
          if(selection.getSnapshot().requested.collectionId===id||(this.runtime?.getSnapshot()??this.snapshot).selectedCollectionId===id)await selection.select(null,options);
          this.notify(false);return;
        }
        await this.call(runtime=>runtime.queue(()=>runtime.forget(id,options)));
        if(selection.getSnapshot().requested.collectionId===id)await selection.select(null,options);
      }),
      deleteCollection:(id:string,options:MdbaseCollectionDeleteOptions)=>this.track(async()=>{
        const selection=this.choose(),{confirmName,...request}=options??{} as MdbaseCollectionDeleteOptions;
        await this.call(runtime=>runtime.queue(()=>runtime.deleteCollection(id,confirmName,request)));
        if(selection.getSnapshot().requested.collectionId===id)await selection.select(null,request);
      }),
      assess:(options?:MdbaseApplicationRequestOptions)=>this.privates?.isOpen()?this.privates.assess():this.call(runtime=>runtime.queue(()=>runtime.assess(options))),
      configure:(options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.privates?.isOpen()?this.privates.configure(options):this.call(runtime=>runtime.queue(()=>runtime.configure(options)))),
      setup:Object.freeze({
        plan:(options?:MdbaseSetupPlanOptions)=>this.privates?.isOpen()?this.privates.plan(options):this.call(runtime=>runtime.queue(()=>runtime.planSetup(options))),
        apply:(plan:MdbaseSetupPlan,options?:MdbaseApplicationRequestOptions)=>this.track(()=>this.privates?.isOpen()?this.privates.apply(plan,options):this.call(runtime=>runtime.queue(()=>runtime.applySetup(plan,options)))),
      }),
      setForeground:(active:boolean)=>this.setForeground(active),close:()=>this.close(),
      signOut:(options?:MdbaseSignOutOptions)=>this.signOut(options)});
  }
  /** SDK-10: the session's snapshot with this tab's Private collections listed
   * and, while one is open, as the selected collection. Stable per change. */
  private withPrivate<T extends AppWebSignInSnapshot>(raw:T):T{
    const privates=this.privates;if(!privates)return raw;
    const last=this.overlaid.get(raw);if(last&&last.revision===privates.revision)return last.value as T;
    const value=withPrivateCollections(raw,privates.entries(),privates.state());
    this.overlaid.set(raw,{revision:privates.revision,value});return value;
  }
  private getSnapshot():MdbaseApplicationSnapshot{
    const raw=this.withPrivate(this.runtime?.getSnapshot()??this.snapshot),selection=this.selection?.getSnapshot()??noSelection,last=this.composed;
    // While starting, and in a second tab, show the last paired session from this browser (P4).
    const hint=raw.signIn===null&&(raw.status==="starting"||(raw.status==="blocked"&&raw.problem==="open_in_another_tab"))?this.hint?.read()??null:null;
    if(last&&last.base===raw&&last.selection===selection&&last.revision===this.revision&&last.hint===hint)return last.value;
    const shown=hint?Object.freeze({...raw,signIn:hint.signIn,collections:hint.collections}):raw;
    // SDK-3: hide forgotten collections (an explicitly opened one stays listed).
    const hidden=this.forgotten?.read(shown.signIn?.accountId)??null;
    const base=hidden?.size&&shown.collections.some(c=>hidden.has(c.collectionId)&&c.collectionId!==shown.selectedCollectionId)
      ?Object.freeze({...shown,collections:Object.freeze(shown.collections.filter(c=>!hidden.has(c.collectionId)||c.collectionId===shown.selectedCollectionId))}):shown;
    const id=base.selectedCollectionId,connection=id&&!this.closed?this.privates?.connection(id)??this.runtime?.connection(id)??null:null;
    let phase=applicationPhase({...base,selection},{connection,previous:last?.value.phase??null,...(this.cpOrigin?{cpOrigin:this.cpOrigin}:{})});
    phase=this.trackOpening(phase);
    const sync=this.trackSync(phase,base.problem,base.transport??null,base.live??null);
    const writes=this.syncing?.writes()??null;
    const saveWarning=this.trackSaveWarning();
    const value:MdbaseApplicationSnapshot=Object.freeze({...base,selection,phase,sync,writes,storage:this.storagePolicy,saveWarning,links:this.links});
    this.composed={base:raw,selection,revision:this.revision,hint,value};return value;
  }
  /** One grace window per continuously pending replica, not per edit or request. */
  private trackSaveWarning():"storage_may_be_evicted"|null{
    const syncing=this.syncing,status=syncing?.status,count=status?.pending??0;
    if(this.pendingSave&&(this.closed||this.hidden||!count||this.pendingSave.id!==syncing?.id))this.clearPendingSave();
    if(this.closed||this.hidden||!syncing||!status||!count)return null;
    if(!this.pendingSave){
      const pending={id:syncing.id,since:performance.now(),timer:null as ReturnType<typeof setTimeout>|null};
      pending.timer=setTimeout(()=>{if(this.pendingSave!==pending)return;pending.timer=null;this.revision++;this.notify(false);},30_000);
      this.pendingSave=pending;
    }
    return appSaveState(count,this.storagePolicy??{persistent:false,installed:false},{pendingForMs:performance.now()-this.pendingSave.since,connection:status.connection}).warning;
  }
  private clearPendingSave():void{
    if(this.pendingSave?.timer!==null&&this.pendingSave?.timer!==undefined)clearTimeout(this.pendingSave.timer);
    this.pendingSave=null;
  }
  /** SDK-9: one timer per opening collection; `slow` after SLOW_OPENING_MS. */
  private trackOpening(phase:MdbasePhase):MdbasePhase{
    const id=phase.kind==="opening"?phase.collectionId:null;
    if(this.opening&&this.opening.id!==id){clearTimeout(this.opening.timer);this.opening=null;}
    if(id===null||this.closed)return phase;
    if(!this.opening){
      const opening={id,slow:false,timer:setTimeout(()=>{if(this.opening!==opening)return;opening.slow=true;this.revision++;this.notify(false);},SLOW_OPENING_MS)};
      this.opening=opening;
    }
    return phase.kind==="opening"&&this.opening.slow?{...phase,slow:true}:phase;
  }
  /** Follow the open collection's sync status while it is ready. */
  private trackSync(phase:MdbasePhase,problem:string|null,transport:TransportHealth|null,live:boolean|null):StatusSummary|null{
    const id=phase.kind==="ready"?phase.collectionId:null;
    if(this.syncing&&this.syncing.id!==id){try{this.syncing.stop();}catch{/* observer only */}this.syncing=null;}
    if(phase.kind!=="ready"||this.closed)return null;
    if(!this.syncing){
      const records=phase.connection.records;
      let status:SyncStatus|null=null;try{status=records.status;}catch{/* not yet known */}
      const syncing:{readonly id:string;stop:()=>void;status:SyncStatus|null;writes:()=>WriteLedgerSnapshot|null}={id:phase.collectionId,stop:()=>{},status,writes:()=>null};
      const changed=()=>{if(this.syncing!==syncing)return;this.revision++;this.getSnapshot();this.notify(false);};
      let offStatus=()=>{},offWrites=()=>{};
      try{offStatus=records.onStatus(next=>{syncing.status=next;changed();});}catch{/* status stays as read */}
      try{const ledger=records.ledger;offWrites=ledger.subscribe(changed);syncing.writes=()=>{try{return ledger.getSnapshot();}catch{return null;}};}catch{/* no ledger */}
      syncing.stop=()=>{offStatus();offWrites();};
      this.syncing=syncing;
    }
    // A transport that cannot deliver writes makes pending ones "saved on this device".
    try{phase.connection.records.setTransportDeferred(transport!==null);}catch{/* observer only */}
    return this.syncing.status?summarizeStatus(this.syncing.status,problem,transport,live):null;
  }
  private nativeAuthorization(call:import("./native-authorization-rpc.js").NativeAuthorizationCall,portal:import("../app-host/web-sign-in-session.js").AppWebSignInPortal,signal:AbortSignal):Promise<import("./native-authorization-rpc.js").NativeAuthorizationResult>{
    if(!this.privates || this.closed || this.hidden)return Promise.reject(mdbaseError("unavailable","Native authorization unavailable"));
    return this.privates.nativeAuthorization(call,portal,AbortSignal.any([signal,this.lifetime.signal]));
  }
  private account():string|null{return (this.runtime?.getSnapshot()??this.snapshot).signIn?.accountId??null;}
  /** SDK-3: approving a forgotten collection again shows it again. */
  private unforgetApproved():void{
    const last=this.selection?.getSnapshot().lastApproval??null,account=this.account();
    if(!last||last===this.handledApproval)return;
    this.handledApproval=last;
    if(account&&last.collectionId&&(last.outcome==="added"||last.outcome==="unchanged")&&this.forgotten?.remove(account,last.collectionId))this.revision++;
  }
  /** SDK-2: re-read the approved list when the app is shown or focused again
   * (an approval in Connect, another app or another device). No polling. */
  private followFocus():void{
    const win=typeof window==="undefined"?undefined:window,doc=globalThis.document;
    if(!win||typeof win.addEventListener!=="function")return;
    const refresh=()=>{if(doc?.visibilityState!=="hidden")this.refreshCollections();};
    win.addEventListener("focus",refresh,{signal:this.lifetime.signal});
    if(doc&&typeof doc.addEventListener==="function")doc.addEventListener("visibilitychange",refresh,{signal:this.lifetime.signal});
  }
  private refreshCollections():void{
    const runtime=this.runtime,now=Date.now();
    // focus and visibilitychange arrive together: one read.
    if(!runtime||this.closed||this.hidden||this.refreshing||now-this.refreshedAt<2_000)return;
    const s=runtime.getNativeSnapshot();
    if(s.signIn?.state!=="paired"||(s.status!=="unselected"&&s.status!=="ready"&&s.status!=="setup_required"))return;
    this.refreshedAt=now;
    void this.privates?.refresh(s.signIn.accountId).catch(()=>{});
    this.refreshing=runtime.queue(()=>runtime.refreshCollections()).catch(()=>{}).finally(()=>{this.refreshing=null;});
  }
  /** Request persistence once at app start, then re-read the policy when the
   * page is shown again. A denial never blocks startup. Where the browser cannot
   * say — no `navigator.storage`, no document — the policy stays null and the
   * save warning assumes the conservative non-persistent state. */
  private followStoragePolicy():void{
    const storage=globalThis.navigator?.storage as {persisted():Promise<boolean>;persist?():Promise<boolean>}|undefined;
    if(!storage||typeof storage.persisted!=="function")return;
    const installed=()=>{try{return globalThis.matchMedia?.("(display-mode: standalone)").matches===true||(globalThis.navigator as {standalone?:unknown})?.standalone===true;}catch{return false;}};
    const refresh=(requestPersistence=false)=>{if(this.closed)return;void appStoragePolicy(storage,installed(),requestPersistence).then(policy=>{
      if(this.closed||(this.storagePolicy?.persistent===policy.persistent&&this.storagePolicy?.installed===policy.installed))return;
      this.storagePolicy=policy;this.revision++;this.notify(false);
    }).catch(()=>{/* conservative state kept */});};
    const doc=globalThis.document;
    if(doc&&typeof doc.addEventListener==="function")doc.addEventListener("visibilitychange",()=>{if(doc.visibilityState!=="hidden")refresh();},{signal:this.lifetime.signal});
    refresh(true);
  }
  private notify(native=true):void{
    // SDK-10: read this browser's Private collections once per signed-in account.
    const s=this.runtime?.getSnapshot();
    const account=s?.signIn?.state==="paired"?s.signIn.accountId:null;
    if(account&&!this.closed&&!this.hidden){
      this.privates?.bind(account,s?.signIn?.nativeGrants ?? []);
      this.privates?.ensure(account);
    }
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
      getSnapshot:()=>this.withPrivate(this.runtime?.getNativeSnapshot()??this.snapshot),
      subscribe:(listener:()=>void)=>{this.nativeListeners.add(listener);return()=>{this.nativeListeners.delete(listener);};},
      open:(id:string,options:MdbaseApplicationRequestOptions={})=>this.call(async runtime=>{
        const privates=this.privates,hosted=runtime.getNativeSnapshot().collections.some(c=>c.collectionId===id);
        if(!privates||hosted||!privates.has(id)){privates?.close();return runtime.queue(()=>runtime.select(id,options));}
        // A Private collection opens in this page: leave the hosted one first.
        if(runtime.getNativeSnapshot().selectedCollectionId!==null)await runtime.queue(()=>runtime.clearSelection(options));
        const account=runtime.getNativeSnapshot().signIn?.accountId,installation=runtime.getNativeSnapshot().signIn?.installationId;
        if(!account||!installation)throw mdbaseError("unauthenticated","Sign in before opening a collection");
        // Waiting for the person's computer can take minutes: the snapshot shows
        // it, and a later selection replaces it, so the selection does not wait.
        void privates.openCollection(id,{account,installation}).catch(()=>{/* the snapshot reports the typed problem */});
      }),
      clear:(options:MdbaseApplicationRequestOptions={})=>{this.privates?.close();return this.call(runtime=>runtime.queue(()=>runtime.clearSelection(options)));},
      authorize:(options:MdbaseApplicationRequestOptions&{readonly collectionHint?:string|null}={})=>this.authorize(options,options.collectionHint??null),
      // SDK-10: a URL naming a Private collection waits for this browser's grant list.
      listing:()=>this.privates?.listing(this.account())??false,
    });
  }
  private check():void{if(this.closed||this.hidden||this.lifetime.signal.aborted)throw mdbaseError("cancelled","Application entry fenced","application_entry_fenced");}
  private environment(){return selectAppEnvironment({environment:this.declaration.environment,appOrigin:this.declaration.origin,release:appReleaseTrust()});}
  private initialize():Promise<ApplicationRuntime>{
    if(this.initialization)return this.initialization;
    const incarnation=this.incarnation;
    const pending=Promise.resolve().then(async()=>{
      this.check();
      // Classic IIFE/relocated/foreign factories are unsupported. No DOM,
      // currentScript, guessed CDN/path or application-supplied loader fallback.
      if(typeof import.meta.url!=="string")throw unavailable();
      const moduleUrl=new URL(import.meta.url);
      if(urlOrigin(moduleUrl)!==this.declaration.origin||currentAppOrigin()!==this.declaration.origin)throw mdbaseError("unavailable","Application module binding unavailable","application_worker_module_binding");
      const environment=this.environment();packagedApplicationAssets(this.declaration.environment,this.declaration.origin);
      // A browser below the SDK's feature floor fails here, once, with a typed
      // problem — before any registration, Worker, key or storage allocation.
      const capabilities=await probeBrowserCapabilities();this.check();
      if(!capabilities.ok)throw mdbaseError("unavailable","This browser can't run mdbase",{reason:capabilities.problem,details:new Map([["missing",capabilities.missing.join(",")]])});
      // Registration resolves BEFORE any Worker, key, profile or DB allocation.
      const registered=await resolveApplicationRegistration({declaration:this.declaration,signal:this.lifetime.signal,isCurrent:()=>!this.closed});this.check();
      // A pagehide during registration superseded this start: no Worker for it.
      if(incarnation!==this.incarnation)throw mdbaseError("cancelled","Application entry fenced","application_entry_fenced");
      const declaration=rebindApplicationDeclaration(this.declaration,registered);
      if(registered.supersededDeclaredId)console.info(`mdbase: ${describeDiagnostic("application_registration_id_superseded")}`);
      const signInScope=Object.freeze({cpOrigin:environment.cpOrigin,appId:declaration.id});
      const install=(runtime:ApplicationRuntime)=>{
        this.runtime=runtime;runtime.subscribe(()=>{this.hint?.observe(runtime.getNativeSnapshot());this.observeSignOut(runtime);if(runtime.getNativeSnapshot().signIn?.state==="paired")this.tabs?.signedIn();this.notify();this.awaitOtherTab(runtime,signInScope);});runtime.setForeground(this.foreground);this.notify();return runtime;
      };
      // One session per app per browser: lead (run the Worker) or join the leader.
      const tabs=this.tabsFor(signInScope),election=new AbortController();this.election?.abort();this.election=election;
      const role=tabs?await tabs.elect(AbortSignal.any([this.lifetime.signal,election.signal])):{kind:"leader" as const};
      if(this.closed||this.hidden||incarnation!==this.incarnation||election.signal.aborted){
        if(role.kind==="follower")role.leave();else tabs?.resign();
        throw mdbaseError("cancelled","Application entry fenced","application_entry_fenced");
      }
      if(role.kind==="follower")return install(new ApplicationRuntime({declaration,compiledManifest:this.compiled,typeIssues:this.typeIssues,cpOrigin:environment.cpOrigin,port:role.port,binding:role.binding,releaseWorker:()=>role.leave(),nativeAuthorization:(call,portal,signal)=>this.nativeAuthorization(call,portal,signal)}));
      const channel=new MessageChannel(),binding=crypto.randomUUID();let worker:Worker;
      // Literal module-relative form so app bundlers emit the SDK Worker chunk.
      try{worker=new Worker(new URL("./worker.js",import.meta.url),{type:"module"});}catch{tabs?.resign();channel.port1.close();channel.port2.close();throw mdbaseError("unavailable","Application Worker construction unavailable","application_worker_unavailable");}
      const failed=(event:Event)=>{event.preventDefault();channel.port1.dispatchEvent(new MessageEvent("messageerror"));tabs?.fault();};worker.addEventListener("error",failed);
      const runtime=new ApplicationRuntime({declaration,compiledManifest:this.compiled,typeIssues:this.typeIssues,cpOrigin:environment.cpOrigin,port:channel.port1,binding,releaseWorker:()=>{worker.removeEventListener("error",failed);worker.terminate();tabs?.resign();},nativeAuthorization:(call,portal,signal)=>this.nativeAuthorization(call,portal,signal)});
      try{worker.postMessage([APPLICATION_WORKER_PROTOCOL,binding,declaration],[channel.port2]);}catch{
        // No startup request was accepted; the original bootstrap transfer failed.
        worker.removeEventListener("error",failed);worker.terminate();tabs?.resign();channel.port1.close();channel.port2.close();throw mdbaseError("unavailable","Application bootstrap unavailable","application_worker_binding");
      }
      // Other tabs of this app attach to this Worker through this page.
      tabs?.lead({attach:(port,id)=>worker.postMessage([APPLICATION_WORKER_PROTOCOL,binding,"attach",id],[port]),detach:id=>worker.postMessage([APPLICATION_WORKER_PROTOCOL,binding,"detach",id])});
      return install(runtime);
    }).catch(error=>{
      // Nothing native was allocated (no runtime installed), so a later explicit
      // action may retry; registration itself retries only its exact upsert.
      const current=this.initialization===pending;if(current)this.initialization=null;
      if(!this.closed&&current){
        const {problemDetail:_stale,...previous}=this.snapshot;
        // A registration refusal keeps only its re-validated code and manifest paths.
        const refusal=error instanceof MdbaseError&&error.reason==="application_registration_refused"?registrationRefusal(error.details):null;
        this.snapshot=Object.freeze({...previous,status:"blocked",problem:typeof error?.reason==="string"?error.reason:typeof error?.code==="string"?error.code:"application_entry_unavailable",
          ...(refusal?{problemDetail:Object.freeze({name:"MdbaseError",code:error.code,registration:refusal})}:{})});this.notify();
      }
      throw error;
    });
    this.initialization=pending;{const {problemDetail:_stale,signOutResult:_done,...previous}=this.snapshot;this.snapshot=Object.freeze({...previous,status:"starting",problem:null});}this.notify();return pending;
  }
  private async call<T>(action:(runtime:ApplicationRuntime)=>Promise<T>):Promise<T>{this.check();const runtime=await this.initialize();this.check();return action(runtime);}
  /** Sign-in start is idempotent in the native session; every lifecycle action
   * that needs the protected request runs it first. */
  private started(runtime:ApplicationRuntime,options?:MdbaseApplicationRequestOptions):Promise<unknown>{
    this.choose();const status=runtime.getNativeSnapshot().status;
    return status==="not_started"||status==="starting"||(status==="blocked"&&!runtime.getNativeSnapshot().signIn)?runtime.queue(()=>runtime.start(options)):Promise.resolve();
  }
  /** Reserve the SDK popup synchronously in the user gesture, before any await. */
  private reservePortal(options:{readonly signal?:AbortSignal}){
    this.check();const environment=this.environment(),signal=options.signal?AbortSignal.any([this.lifetime.signal,options.signal]):this.lifetime.signal;
    const lab=applicationLoopbackAllowed(this.declaration.environment),current=()=>!this.closed;
    const host:ApplicationPortalHost=this.signIn?openerApplicationPortalHost(environment.cpOrigin,signal,current,this.signIn,lab):browserApplicationPortalHost(environment.cpOrigin,signal,current,lab);
    return {portal:reserveApplicationPortal(host),signal};
  }
  private requestAccess(request:MdbaseAccessRequest,options:MdbaseAccessRequestOptions):Promise<MdbaseAccessResult>{
    try{
      this.check();const runtime=this.runtime,native=runtime?.getNativeSnapshot(),id=native?.selectedCollectionId??null;
      const declaration=fileAccessDeclaration(this.compiled),consented=()=>id&&runtime?consentedFileActions(runtime.getNativeSnapshot(),id):[];
      const missing=missingFileActions(declaration,request,options,consented());
      const connection=id?runtime!.connection(id):null;
      if(!runtime||!id||!connection)throw mdbaseError("invalid_request","requestAccess needs an open collection","access_no_collection");
      const granted=()=>grantedResult(connection.files,declaration,consented());
      if(!missing.length)return Promise.resolve(granted());
      const {portal,signal}=this.reservePortal(options);
      return awaitFileAccess({granted,native:()=>runtime.getNativeSnapshot(),
        start:()=>runtime.queue(()=>runtime.requestFileAccess(portal,id,missing,options.reason,{signal})),
        poll:requestId=>runtime.queue(()=>runtime.pollFileAccess(requestId))},portal,signal);
    }catch(error){return Promise.reject(error);}
  }
  private authorize(options:MdbaseApplicationRequestOptions={},collectionHint:string|null=null):Promise<unknown>{
    let portal:AppWebSignInPortal;try{portal=this.reservePortal(options).portal;}catch(error){return Promise.reject(error);}
    return this.call(async runtime=>{await this.started(runtime,options);return runtime.queue(()=>runtime.authorizeReserved(portal,options,collectionHint));})
      .catch(error=>{try{portal.close();}catch{/* original stop failure retained by the portal */}throw error;});
  }
  /** UX-011. The Worker session signs out and erases; then this entry drops
   * that runtime the way the back/forward-cache path does (incarnation, no
   * initialization), so the next action starts a fresh Worker and a fresh
   * pairing, and clears its own page storage (session hint, last collection,
   * forgotten collections). */
  private async signOut(options:MdbaseSignOutOptions={}):Promise<MdbaseApplicationSnapshot>{
    const runtime=await this.call(async runtime=>{await this.started(runtime,options);return runtime;});
    this.signingOut=true;
    try{await runtime.queue(()=>runtime.signOut(options));}finally{this.signingOut=false;}
    const result=runtime.getNativeSnapshot().signOutResult??null;
    await this.signedOut(runtime,result);
    if(result)await signOutDiagnostics(result);
    return this.getSnapshot();
  }
  /** Drop the signed-out runtime the way the back/forward-cache path does
   * (incarnation, no initialization), so the next action starts afresh, and
   * clear this page's storage (session hint, last and forgotten collections). */
  private async signedOut(runtime:ApplicationRuntime,result:NonNullable<RuntimeSnapshot["signOutResult"]>|null,leaderGone=false):Promise<void>{
    // Leading tab: followers learn it was a sign-out, not a handover.
    if(!leaderGone)this.tabs?.signedOut();
    this.clearPendingSave();
    ++this.incarnation;if(this.runtime===runtime)this.runtime=null;this.initialization=null;
    this.snapshot=Object.freeze({status:"signed_out",signIn:null,collections:Object.freeze([]),selectedCollectionId:null,problem:null,timing:null,readiness:emptyReadiness,...(result?{signOutResult:result}:{})});
    this.hint?.clear();this.forgotten?.clear();this.handledApproval=null;
    // SDK-10: this browser's Private grants belong to the signed-out account too.
    await this.privates?.forgetAll().catch(()=>{});
    try{this.memory?.write(null);}catch{/* optional hint storage */}
    if(this.selection&&!this.closed){this.selection.resync();await this.selection.select(null,{history:"replace"}).catch(()=>{});}
    this.revision++;this.notify();
    // The leader's Worker is gone with its session: nothing to acknowledge.
    if(leaderGone){runtime.abandon();return;}
    // The session already closed everything; this is the Worker's terminal ACK.
    await runtime.close().catch(()=>{/* a failed stop leaves no session: it was erased */});
  }
  /** Another tab signed out of the one shared session: this tab is signed out too. */
  private observeSignOut(runtime:ApplicationRuntime):void{
    const result=runtime.getNativeSnapshot().signOutResult;
    if(!result||this.signingOut||this.closed||this.runtime!==runtime)return;
    void this.signedOut(runtime,result);
  }
  private tabsFor(scope:Readonly<{cpOrigin:string;appId:string}>):ApplicationTabs|null{
    if(this.tabs)return this.tabs;
    const locks=globalThis.navigator?.locks as ApplicationTabLocks|undefined,Channel=globalThis.BroadcastChannel;
    if(!locks||typeof locks.request!=="function"||typeof Channel!=="function")return null;
    // The SDK module URL is per build: tabs on different builds never share a Worker.
    this.tabs=new ApplicationTabs({...scope,build:import.meta.url},{locks,BroadcastChannel:Channel},this.leaderLost,this.signedInElsewhere);
    return this.tabs;
  }
  /** The leader tab went away: start again, as the new leader or a follower of it.
   * If it went because the session signed out, this tab is signed out too: it
   * neither leads nor starts a new session (its snapshot may not have arrived). */
  private readonly leaderLost=(signedOut:boolean):void=>{
    if(this.closed||this.hidden)return;
    const runtime=this.runtime,active=runtime!==null||this.initialization!==null;
    this.election?.abort();this.election=null;
    if(signedOut&&runtime&&!this.signingOut)void this.signedOut(runtime,runtime.getNativeSnapshot().signOutResult??null,true);
    else if(signedOut&&active){++this.incarnation;this.initialization=null;}
    // Nothing to run here (signed out, or never started): let another tab lead.
    if(!active||signedOut){this.tabs?.resign();return;}
    ++this.incarnation;this.initialization=null;this.runtime=null;
    runtime?.abandon();
    const {problemDetail:_stale,...previous}=this.snapshot;
    this.snapshot=Object.freeze({...previous,status:"starting",problem:null,selectedCollectionId:null,readiness:emptyReadiness});
    this.notify();
    this.selection?.resync();
    void this.app.start().catch(()=>{/* the snapshot reports the typed problem */});
  };
  /** Every tab signed out, then another tab signed in again: follow that
   * session as this tab would on load (no second sign-in or approval). */
  private readonly signedInElsewhere=():void=>{
    if(this.closed||this.hidden||this.signingOut||this.runtime!==null||this.initialization!==null||this.snapshot.status!=="signed_out")return;
    this.selection?.resync();
    void this.app.start().catch(()=>{/* the snapshot reports the typed problem */});
  };
  private setForeground(active:boolean):void{this.foreground=active;this.runtime?.setForeground(active);}
  private followVisibility():void{
    const doc=globalThis.document;if(!doc||typeof doc.addEventListener!=="function")return;
    // Not through this.app: this runs from the constructor, before it exists.
    const sync=()=>{if(!this.closed)this.setForeground(doc.visibilityState!=="hidden");};
    const wake=()=>{if(doc.visibilityState!=="hidden")sync();};
    doc.addEventListener("visibilitychange",sync,{signal:this.lifetime.signal});
    const win=typeof window==="undefined"?undefined:window;
    if(win&&typeof win.addEventListener==="function"){win.addEventListener("focus",wake,{signal:this.lifetime.signal});win.addEventListener("online",wake,{signal:this.lifetime.signal});}
    sync();
  }
  /** Back/forward cache: a page parked there is frozen with its Worker, which
   * would keep holding the collection lease and block the next document of
   * this app ("busy"). On pagehide, stop the Worker synchronously (a frozen
   * page cannot finish an async stop); on a persisted pageshow, start a fresh
   * one so the restored page works again. A non-persisted pagehide (unload)
   * stops it the same way: the page is going anyway, and the lease is free at
   * once for the document that replaces it. Browser Window contexts only. */
  private followPageLifecycle():void{
    const win=typeof window==="undefined"?undefined:window;
    if(!win||typeof win.addEventListener!=="function")return;
    win.addEventListener("pagehide",this.pageHidden,{signal:this.lifetime.signal});
    win.addEventListener("pageshow",this.pageShown,{signal:this.lifetime.signal});
    // A frozen page (a background tab the browser froze) runs no script, so it
    // can serve no other tab: stop like a parked page, start again on resume.
    const doc=globalThis.document;
    if(doc&&typeof doc.addEventListener==="function"){
      doc.addEventListener("freeze",()=>this.pageHidden(),{signal:this.lifetime.signal});
      doc.addEventListener("resume",()=>this.pageShown({persisted:true} as PageTransitionEvent),{signal:this.lifetime.signal});
    }
  }
  private readonly pageHidden=():void=>{
    if(this.closed||this.hidden)return;
    const runtime=this.runtime,resume=runtime!==null||this.initialization!==null;
    ++this.incarnation;this.hidden=Object.freeze({resume});this.clearPendingSave();
    // A start still registering is superseded (incarnation); an installed one stops now.
    this.initialization=null;this.runtime=null;
    this.election?.abort();this.election=null;
    runtime?.abandon();
    // Leadership and presence go now; other tabs carry on without this one.
    this.tabs?.release();
    const {problemDetail:_stale,...previous}=this.snapshot;
    this.snapshot=Object.freeze({...previous,status:resume?"starting":this.snapshot.status,problem:null,selectedCollectionId:null,readiness:emptyReadiness});
  };
  private readonly pageShown=(event:PageTransitionEvent):void=>{
    const hidden=this.hidden;if(this.closed||!hidden||!event.persisted)return;
    this.hidden=null;this.notify();
    if(!hidden.resume)return;
    // Same path as the app's first start: fresh registration check, Worker and
    // session; selection then reopens the requested collection.
    this.selection?.resync();
    void this.app.start().catch(()=>{/* the snapshot reports the typed problem */});
  };
  /** Fallback when tabs cannot share one Worker: another tab of this app on a
   * different build (or one still letting go during a leader handover) holds the
   * sign-in slot. Wait for it to be released (that tab closes, reloads or is
   * parked in the back/forward cache), then start again by the bfcache-restore
   * path. A hidden tab waits until it is shown, so it never takes over from a
   * tab the user is reloading. Only Web Lock waits: no timers, no network. */
  private awaitingOtherTab=false;
  private awaitOtherTab(runtime:ApplicationRuntime,scope:Readonly<{cpOrigin:string;appId:string}>):void{
    const native=runtime.getNativeSnapshot(),locks=globalThis.navigator?.locks as AppLockWaitPort|undefined;
    if(this.awaitingOtherTab||this.closed||native.status!=="blocked"||native.problem!=="open_in_another_tab"||!locks)return;
    this.awaitingOtherTab=true;const incarnation=this.incarnation,signal=this.lifetime.signal;
    const current=()=>!this.closed&&!this.hidden&&incarnation===this.incarnation&&this.runtime===runtime;
    void waitForAppSignInRelease(locks,scope,signal).then(()=>whenVisible(signal)).then(()=>{
      this.awaitingOtherTab=false;if(!current())return;
      this.selection?.resync();
      void this.app.start().catch(()=>{/* the snapshot reports the typed problem; a lost race waits again */});
    },()=>{this.awaitingOtherTab=false;});
  }
  private close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.lifetime.abort();this.selection?.close();this.election?.abort();this.privates?.dispose();
    if(this.opening){clearTimeout(this.opening.timer);this.opening=null;}
    this.clearPendingSave();
    if(this.syncing){try{this.syncing.stop();}catch{/* observer only */}this.syncing=null;}
    this.closing=Promise.resolve().then(async()=>{
      // A registration/asset failure allocated no native resources; an installed
      // runtime always requires its original terminal ACK and UI/helper drains.
      await this.initialization?.catch(()=>{});await this.runtime?.close();this.tabs?.release();
      {const {problemDetail:_stale,...previous}=this.snapshot;this.snapshot=Object.freeze({...previous,status:"closed",problem:null,selectedCollectionId:null});}this.runtime=null;this.notify();this.listeners.clear();this.nativeListeners.clear();
    });return this.closing;
  }
  application():MdbaseApplication{return this.app;}
  connection(collectionId:string):MdbaseApplicationConnection|null{return this.closed?null:this.privates?.connection(collectionId)??this.runtime?.connection(collectionId)??null;}
}

