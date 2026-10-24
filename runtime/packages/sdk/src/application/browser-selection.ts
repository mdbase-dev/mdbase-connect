import {isAppOrigin,urlOrigin} from "../app-host/app-origin.js";
/** SDK-private browser selection policy. URL/stored IDs are REQUESTED hints,
 * never approval, identity, native access or current semantic readiness. */
export interface ApplicationBrowserSelectionOptions {readonly parameter?:string;readonly fallbackPath?:string}
export interface ApplicationSelectionSnapshot {
  readonly requestedCollectionId:string|null;
  readonly source:"none"|"url"|"user"|"stored"|"preferred"|"sole";
  readonly problem:ApplicationSelectionError["code"]|null;
}
export interface ApplicationSelectionBrowserPort {
  href():string;
  write(href:string,history:"push"|"replace"):void;
  listen(listener:()=>void):()=>void;
}
export class ApplicationSelectionError extends Error {
  constructor(readonly code:"application_selection_binding"|"application_selection_invalid"|"application_selection_empty"|"application_selection_duplicate"|"application_selection_metadata"|"application_selection_fenced"|"application_selection_not_approved"|"application_selection_busy"){
    super("SDK collection selection unavailable");this.name="ApplicationSelectionError";
  }
}
const validId=(id:unknown):id is string=>typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)&&id!=="00000000-0000-0000-0000-000000000000";
const state=(requestedCollectionId:string|null,source:ApplicationSelectionSnapshot["source"],problem:ApplicationSelectionSnapshot["problem"]=null):ApplicationSelectionSnapshot=>Object.freeze({requestedCollectionId,source,problem});
/** Clear precedence: any URL request/error blocks silent fallback; stored hint
 * next (even if not admitted yet), then genuinely admitted preferred/sole.
 * Unknown hints stay requested for the SDK's targeted approval path. */
export function applicationStartTarget(url:ApplicationSelectionSnapshot,options:{readonly storedId?:string|null;readonly preferredId?:string|null;readonly collections:readonly{readonly collectionId:string}[]}):ApplicationSelectionSnapshot {
  if(url.source!=="none")return url;
  if(options.storedId!==undefined&&options.storedId!==null)return validId(options.storedId)?state(options.storedId,"stored"):state(null,"stored","application_selection_invalid");
  if(options.collections.length>1024||options.collections.some(value=>!validId(value.collectionId))||new Set(options.collections.map(value=>value.collectionId)).size!==options.collections.length)return state(null,"none","application_selection_metadata");
  if(options.preferredId!==undefined&&options.preferredId!==null)return validId(options.preferredId)&&options.collections.some(value=>value.collectionId===options.preferredId)?state(options.preferredId,"preferred"):state(null,"preferred","application_selection_metadata");
  return options.collections.length===1?state(options.collections[0]!.collectionId,"sole"):state(null,"none");
}
export class ApplicationBrowserSelection {
  private readonly port:ApplicationSelectionBrowserPort|null;
  private readonly origin:string;
  private readonly parameter:string;
  private readonly fallback:string;
  private readonly listeners=new Set<()=>void>();
  private snapshot:ApplicationSelectionSnapshot=state(null,"none");
  private stopListening:(()=>void)|null=null;
  private started=false;
  private closed=false;
  constructor(origin:string,options:ApplicationBrowserSelectionOptions={},port:ApplicationSelectionBrowserPort|null=null){
    let base:URL,fallback:URL;
    try{base=new URL(origin);fallback=new URL(options.fallbackPath??"/",base);}catch{throw new ApplicationSelectionError("application_selection_binding");}
    const parameter=options.parameter??"collection";
    if(!isAppOrigin(origin,true)||urlOrigin(base)!==origin||urlOrigin(fallback)!==origin||fallback.username||fallback.password||fallback.search||fallback.hash||
      typeof parameter!=="string"||! /^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(parameter)||["code","state","error","error_description"].includes(parameter))throw new ApplicationSelectionError("application_selection_binding");
    this.origin=origin;this.parameter=parameter;this.fallback=fallback.href;this.port=port;
  }
  getSnapshot():ApplicationSelectionSnapshot{return this.snapshot;}
  subscribe(listener:()=>void):()=>void{this.check();this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  start():ApplicationSelectionSnapshot {
    this.check();if(this.started)return this.snapshot;this.started=true;
    this.stopListening=this.port?.listen(()=>{if(!this.closed)this.publish(this.read());})??null;
    this.publish(this.read());return this.snapshot;
  }
  private check():void{if(this.closed)throw new ApplicationSelectionError("application_selection_fenced");}
  private url():URL {
    let url:URL;try{url=new URL(this.port!.href());}catch{throw new ApplicationSelectionError("application_selection_binding");}
    if(urlOrigin(url)!==this.origin||url.username||url.password)throw new ApplicationSelectionError("application_selection_binding");return url;
  }
  private read():ApplicationSelectionSnapshot {
    if(!this.port)return state(null,"none");
    let values:string[];try{values=this.url().searchParams.getAll(this.parameter);}catch{return state(null,"url","application_selection_binding");}
    if(values.length===0)return state(null,"none");
    if(values.length!==1)return state(null,"url","application_selection_duplicate");
    if(values[0]==="")return state(null,"url","application_selection_empty");
    if(!validId(values[0]))return state(null,"url","application_selection_invalid");
    return state(values[0],"url");
  }
  private publish(snapshot:ApplicationSelectionSnapshot):void {
    if(this.snapshot.requestedCollectionId===snapshot.requestedCollectionId&&this.snapshot.source===snapshot.source&&this.snapshot.problem===snapshot.problem)return;
    this.snapshot=snapshot;for(const listener of [...this.listeners]){try{listener();}catch{/* observer never owns selection */}}
  }
  select(collectionId:string|null,options:{readonly history?:"push"|"replace"}={}):ApplicationSelectionSnapshot {
    this.check();if(collectionId!==null&&!validId(collectionId))throw new ApplicationSelectionError("application_selection_invalid");
    const history=options.history??"replace";if(history!=="push"&&history!=="replace")throw new ApplicationSelectionError("application_selection_binding");
    if(this.port){
      const url=this.url(),before=url.href;
      if(collectionId===null)url.searchParams.delete(this.parameter);else url.searchParams.set(this.parameter,collectionId);
      // Deliberate SDK selection fixes duplicate/invalid hints, preserving all
      // unrelated query/hash/path. Callback cleanup belongs to its validated
      // authorization owner, not arbitrary code/state parameter deletion here.
      if(url.href!==before)this.port.write(url.href,history);
    }
    this.publish(state(collectionId,collectionId===null?"none":"user"));return this.snapshot;
  }
  /** Same-origin return-path policy; never navigate to a caller-supplied origin. */
  returnUrl(value:string):string {
    this.check();try{const url=new URL(value,this.origin);if(urlOrigin(url)===this.origin&&!url.username&&!url.password)return url.href;}catch{/* use declared base-path */}return this.fallback;
  }
  close():void {if(this.closed)return;this.closed=true;const stop=this.stopListening;this.stopListening=null;stop?.();this.listeners.clear();}
}
/** SDK browser adapter, not an app option. Native/testing policy has no location
 * and uses the same requested-ID semantics without fabricating a browser URL. */
export function browserApplicationSelectionPort():ApplicationSelectionBrowserPort|null {
  if(typeof window==="undefined"||!window.location||!window.history)return null;
  const owner=window;
  return Object.freeze({href:()=>owner.location.href,write:(href:string,history:"push"|"replace")=>{
    if(history==="push")owner.history.pushState(owner.history.state,"",href);else owner.history.replaceState(owner.history.state,"",href);
  },listen:(listener:()=>void)=>{owner.addEventListener("popstate",listener);return()=>owner.removeEventListener("popstate",listener);}});
}
