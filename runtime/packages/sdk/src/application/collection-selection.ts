import type {AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {AppInstallationCollection} from "../app-host/installation-sign-in.js";
import {ApplicationSelectionError,applicationStartTarget,type ApplicationBrowserSelection,type ApplicationSelectionSnapshot} from "./browser-selection.js";

export interface ApplicationSelectionRequestOptions {readonly signal?:AbortSignal}
/** The singleton's view of its ONE sign-in session (directly or via the Worker
 * client). Selection never touches keys, ports, leases or native switches:
 * `open` is the runtime's switch (retire the old generation first, then the
 * native select; same open scope is a no-op fast path). */
export interface ApplicationSelectionSession {
  getSnapshot():AppWebSignInSnapshot;
  subscribe(listener:()=>void):()=>void;
  open(collectionId:string,options?:ApplicationSelectionRequestOptions):Promise<unknown>;
  clear(options?:ApplicationSelectionRequestOptions):Promise<unknown>;
  /** MUST reserve the Connect popup synchronously, before its first await.
   * collectionHint asks Connect to preselect it (never consent by itself). */
  authorize(options?:ApplicationSelectionRequestOptions&{readonly collectionHint?:string|null}):Promise<unknown>;
}
/** Optional per-app last-used hint. A REQUESTED hint only, never approval. */
export interface ApplicationSelectionMemory {read():string|null;write(collectionId:string|null):void}
export interface ApplicationCollectionSelectionOptions {
  readonly browser:ApplicationBrowserSelection;
  readonly session:ApplicationSelectionSession;
  readonly memory?:ApplicationSelectionMemory;
  /** Opened at start only when already approved (see applicationStartTarget). */
  readonly preferredId?:string|null;
  readonly schedule?:(task:()=>void)=>void;
}
/**
 * - none: nothing requested; show the approved collections (or "add a collection").
 * - pending: a collection is requested but sign-in has not produced an approved list yet.
 * - opening / usable: the requested collection is approved and opening / open.
 * - approval_required: requested but not approved for this app. Offer approve() and
 *   chooseAnother(); problem "application_selection_not_approved" after a declined approval.
 * - approving: an approval popup/receipt is in progress.
 * - invalid: the URL request is malformed (typed problem); never silently replaced.
 * - blocked: the session failed to open the requested collection; see the session problem.
 */
export type ApplicationCollectionSelectionState="none"|"pending"|"opening"|"usable"|"approval_required"|"approving"|"invalid"|"blocked";
export interface ApplicationCollectionSelectionSnapshot {
  readonly state:ApplicationCollectionSelectionState;
  /** What the URL/user/memory asked for. displayName only when approved. */
  readonly requested:Readonly<{collectionId:string|null;source:ApplicationSelectionSnapshot["source"];displayName:string|null;approved:boolean}>;
  /** The collection the session actually has open (ready or setup_required). */
  readonly usable:AppInstallationCollection|null;
  readonly problem:ApplicationSelectionError["code"]|null;
}
const validId=(id:unknown):id is string=>typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)&&id!=="00000000-0000-0000-0000-000000000000";
const isOpen=(s:AppWebSignInSnapshot)=>s.status==="ready"||s.status==="setup_required";
/** Approved list is current and no session operation is opening/authorizing. */
const settled=(s:AppWebSignInSnapshot)=>s.signIn?.state==="paired"&&(s.status==="unselected"||s.status==="blocked"||isOpen(s));
const inFlight=(s:AppWebSignInSnapshot)=>s.status==="not_started"||s.status==="starting"||s.status==="signed_out"||s.status==="authorizing";
const approved=(s:AppWebSignInSnapshot,id:string|null)=>id===null?null:s.collections.find(c=>c.collectionId===id)??null;

/** SDK-owned collection selection: the URL is the request, the session decides
 * what is usable. A requested-but-unapproved collection is never replaced by
 * another approved one; only explicit user intent (select, chooseAnother, a
 * portal pick during approve) changes the request. No automatic open retries. */
export class ApplicationCollectionSelection {
  private readonly browser:ApplicationBrowserSelection;
  private readonly session:ApplicationSelectionSession;
  private readonly memory:ApplicationSelectionMemory|null;
  private readonly preferredId:string|null;
  private readonly schedule:(task:()=>void)=>void;
  private readonly listeners=new Set<()=>void>();
  private readonly stops:Array<()=>void>=[];
  private value:ApplicationCollectionSelectionSnapshot;
  private key="";
  private startTarget:ApplicationSelectionSnapshot|null=null;
  private startApplied=false;
  /** Last request auto-opened (null = auto-cleared); undefined = none yet. */
  private attempted:string|null|undefined=undefined;
  private lastRequested:string|null=null;
  private opening:Promise<void>|null=null;
  private approval:{readonly receipt:string|null;settled:boolean}|null=null;
  private declined:string|null=null;
  private remembered:string|null|undefined=undefined;
  private queued=false;
  private started=false;
  private closed=false;
  constructor(options:ApplicationCollectionSelectionOptions){
    this.browser=options.browser;this.session=options.session;this.memory=options.memory??null;
    this.preferredId=options.preferredId??null;this.schedule=options.schedule??(task=>{setTimeout(task,0);});
    this.value=this.derive();this.key=JSON.stringify(this.value);
  }
  getSnapshot():ApplicationCollectionSelectionSnapshot{return this.value;}
  subscribe(listener:()=>void):()=>void{this.check();this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  start():ApplicationCollectionSelectionSnapshot {
    this.check();if(this.started)return this.value;this.started=true;
    this.browser.start();
    this.stops.push(this.browser.subscribe(this.changed),this.session.subscribe(this.changed));
    this.changed();return this.value;
  }
  /** Open an approved collection (or request an unapproved one, which shows
   * approval_required). null clears the selection. Explicit intent retries. */
  select(collectionId:string|null,options:ApplicationSelectionRequestOptions&{readonly history?:"push"|"replace"}={}):Promise<ApplicationCollectionSelectionSnapshot> {
    this.check();this.startTarget=null;
    this.browser.select(collectionId,options.history?{history:options.history}:{});
    this.declined=null;this.refresh();
    if(collectionId===null)this.remember(null);
    return this.whenIdle(async()=>{
      const s=this.session.getSnapshot();
      if(this.requested().requestedCollectionId!==collectionId)return; // superseded by newer intent
      if(collectionId===null?s.selectedCollectionId===null&&s.status!=="opening":(s.selectedCollectionId===collectionId&&isOpen(s))||!approved(s,collectionId))return;
      await this.run(collectionId,options,true);
    }).then(()=>this.value);
  }
  /** Leave the current/requested collection and return to the chooser. The
   * request is removed with a pushed history entry, so Back restores it. */
  chooseAnother(options:ApplicationSelectionRequestOptions={}):Promise<ApplicationCollectionSelectionSnapshot>{return this.select(null,{...options,history:"push"});}
  /** Call synchronously from the user gesture. Opens the Connect approval
   * popup for `collectionId` (default: the current request; none = choose in
   * the portal). A collection picked in the portal wins and the URL follows;
   * otherwise the request opens once approved, or reports not_approved. */
  approve(collectionId?:string|null,options:ApplicationSelectionRequestOptions&{readonly history?:"push"|"replace"}={}):Promise<ApplicationCollectionSelectionSnapshot> {
    this.check();
    if(collectionId!==undefined&&collectionId!==null&&!validId(collectionId))return Promise.reject(new ApplicationSelectionError("application_selection_invalid"));
    // A handed-off approval (popup open, receipt pending) may be retried by a
    // new gesture, e.g. after the user closed the popup; one in hand-off may not.
    if(this.approval&&!this.approval.settled)return Promise.reject(new ApplicationSelectionError("application_selection_busy"));
    if(collectionId!==undefined&&collectionId!==null&&collectionId!==this.requested().requestedCollectionId){
      this.startTarget=null;this.browser.select(collectionId,options.history?{history:options.history}:{});
    }
    const receipt=this.session.getSnapshot().signIn?.collectionSelection?.requestId??null;
    let pending:Promise<unknown>;
    const collectionHint=collectionId===null?null:this.requested().requestedCollectionId;
    try{pending=this.session.authorize({...(options.signal?{signal:options.signal}:{}),collectionHint});}catch(error){return Promise.reject(error);} // popup reserved synchronously
    const approval={receipt,settled:false};
    this.approval=approval;this.declined=null;this.attempted=undefined;this.refresh();
    return pending.then(()=>{approval.settled=true;this.changed();return this.value;},error=>{if(this.approval===approval)this.approval=null;this.changed();throw error;});
  }
  /** Re-run approval for the open (or requested) collection, e.g. after access
   * was lost or the app needs a wider grant. Call from the user gesture. */
  reauthorize(options:ApplicationSelectionRequestOptions={}):Promise<ApplicationCollectionSelectionSnapshot> {
    this.check();const id=this.value.usable?.collectionId??this.requested().requestedCollectionId;
    if(id===null)return Promise.reject(new ApplicationSelectionError("application_selection_empty"));
    return this.approve(id,options);
  }
  close():void {
    if(this.closed)return;this.closed=true;
    for(const stop of this.stops.splice(0))try{stop();}catch{/* observers never own selection */}
    this.browser.close();this.listeners.clear();
  }
  private check():void{if(this.closed)throw new ApplicationSelectionError("application_selection_fenced");}
  private requested():ApplicationSelectionSnapshot {
    const url=this.browser.getSnapshot(),start=this.startTarget;
    return start&&url.source==="user"&&url.requestedCollectionId===start.requestedCollectionId?start:url;
  }
  private readonly changed=()=>{
    if(this.closed)return;this.refresh();
    if(this.queued||!this.started)return;this.queued=true;
    this.schedule(()=>{this.queued=false;void this.reconcile();});
  };
  private refresh():void {
    const id=this.requested().requestedCollectionId;
    if(id!==this.lastRequested){this.lastRequested=id;this.attempted=undefined;if(this.declined!==id)this.declined=null;}
    const next=this.derive(),key=JSON.stringify(next);
    if(next.state==="usable")this.remember(next.usable!.collectionId);
    if(key===this.key)return;
    this.key=key;this.value=Object.freeze(next);
    for(const listener of [...this.listeners])try{listener();}catch{/* observers never own selection */}
  }
  private remember(id:string|null):void {
    if(!this.memory||this.remembered===id)return;this.remembered=id;
    try{this.memory.write(id);}catch{/* hint storage is optional */}
  }
  private derive():ApplicationCollectionSelectionSnapshot {
    const s=this.session.getSnapshot(),r=this.requested(),id=r.requestedCollectionId,wanted=approved(s,id);
    const usable=isOpen(s)?approved(s,s.selectedCollectionId):null;
    let state:ApplicationCollectionSelectionState,problem:ApplicationCollectionSelectionSnapshot["problem"]=null;
    if(r.problem){state="invalid";problem=r.problem;}
    else if(this.approval)state="approving";
    else if(id===null)state="none";
    else if(usable?.collectionId===id)state="usable";
    else if(s.selectedCollectionId===id&&(s.status==="blocked"||s.status==="opening"))state=s.status==="blocked"?"blocked":"opening";
    else if(!settled(s))state="pending";
    else if(wanted)state="opening";
    else{state="approval_required";if(this.declined===id)problem="application_selection_not_approved";}
    return Object.freeze({state,problem,usable:usable?Object.freeze({...usable}):null,
      requested:Object.freeze({collectionId:id,source:r.source,displayName:wanted?.displayName??null,approved:wanted!==null})});
  }
  private async whenIdle(work:()=>Promise<void>):Promise<void>{while(this.opening)await this.opening;this.check();await work();}
  private run(id:string|null,options:ApplicationSelectionRequestOptions={},explicit=false):Promise<void> {
    this.attempted=id;
    const request=options.signal?{signal:options.signal}:{};
    const raw=Promise.resolve().then(()=>id===null?this.session.clear(request):this.session.open(id,request));
    // Failures surface through the session snapshot (blocked + typed problem);
    // the same request is never auto-retried, only by explicit select().
    const op=raw.then(()=>{},()=>{}).finally(()=>{if(this.opening===op){this.opening=null;this.changed();}});
    this.opening=op;
    return explicit?raw.then(()=>{}):op;
  }
  private async reconcile():Promise<void> {
    if(this.closed||this.opening)return;
    const s=this.session.getSnapshot();
    if(this.approval){
      if(!this.approval.settled||inFlight(s))return;
      this.finishApproval(s);
    }
    if(!settled(s))return;
    if(!this.startApplied){
      this.startApplied=true;
      if(this.browser.getSnapshot().source==="none"){
        let storedId:string|null=null;try{storedId=this.memory?.read()??null;}catch{/* optional hint */}
        const target=applicationStartTarget(this.browser.getSnapshot(),{storedId,preferredId:this.preferredId,collections:s.collections});
        if(target.requestedCollectionId!==null&&!target.problem){this.browser.select(target.requestedCollectionId,{history:"replace"});this.startTarget=target;this.refresh();}
      }
    }
    const r=this.requested(),id=r.requestedCollectionId;
    if(r.problem)return;
    if(id===null){if(this.attempted!==null&&s.selectedCollectionId!==null&&isOpen(s))void this.run(null);return;}
    if((s.selectedCollectionId===id&&isOpen(s))||!approved(s,id)||this.attempted===id)return;
    void this.run(id);
  }
  private finishApproval(s:AppWebSignInSnapshot):void {
    const receipt=this.approval!.receipt;this.approval=null;this.attempted=undefined;
    const pick=s.signIn?.collectionSelection,picked=pick&&pick.requestId!==receipt&&approved(s,pick.selectedCollectionId)?pick.selectedCollectionId:null;
    if(picked!==null){
      // The user's explicit portal choice replaces the request and opens once
      // (unless an owner session already opened it itself).
      if(picked!==this.requested().requestedCollectionId){this.startTarget=null;this.browser.select(picked,{history:"replace"});}
      this.refresh();
      if(s.selectedCollectionId===picked&&(isOpen(s)||s.status==="opening"))this.attempted=picked;else void this.run(picked);
      return;
    }
    const id=this.requested().requestedCollectionId;
    if(id!==null&&!approved(s,id))this.declined=id;
    this.refresh();
  }
}
