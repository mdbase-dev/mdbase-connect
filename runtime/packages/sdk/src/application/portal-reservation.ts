import type {AppWebSignInPortal} from "../app-host/web-sign-in-session.js";

export class ApplicationPortalError extends Error {
  constructor(readonly reason:"application_popup_blocked"|"application_popup_fenced"|"application_popup_binding"|"application_popup_unavailable"|"application_popup_stop_failed") {
    super("application authorization popup unavailable");this.name="ApplicationPortalError";
  }
}
/** Private UI port only. Apps reach it solely through the narrower public
 * `signIn` opener (openerApplicationPortalHost), never directly. */
export interface ApplicationPopupWindow {navigate(uri:string):void;close():void}
export interface ApplicationPortalHost {
  readonly cpOrigin:string;
  readonly signal:AbortSignal;
  readonly allowLoopbackHttp?:boolean;
  isCurrent():boolean;
  /** MUST be synchronous and UI-gesture owned. */
  open():ApplicationPopupWindow|null;
}
const owned=new WeakSet<ApplicationPopupWindow>();
/** Reserve before ANY startup/expiry await. Window lifetime and original caller
 * remain pinned; this helper neither starts/retries authorization nor owns keys. */
export function reserveApplicationPortal(host:ApplicationPortalHost):AppWebSignInPortal {
  const origin=host.cpOrigin,signal=host.signal,current=host.isCurrent,open=host.open;
  const check=()=>{
    let active=false;try{active=!signal.aborted&&current()===true;}catch{/* stale host observations are fenced */}
    if(!active)throw new ApplicationPortalError("application_popup_fenced");
  };
  check();
  let cp:URL;try{cp=new URL(origin);}catch{throw new ApplicationPortalError("application_popup_binding");}
  const loopback=host.allowLoopbackHttp===true&&cp.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(cp.hostname);
  if(cp.origin!==origin||cp.username||cp.password||cp.search||cp.hash||cp.pathname!=="/"||(cp.protocol!=="https:"&&!loopback))throw new ApplicationPortalError("application_popup_binding");
  let window:ApplicationPopupWindow|null;
  try{window=open();}catch{throw new ApplicationPortalError("application_popup_unavailable");}
  if(window===null)throw new ApplicationPortalError("application_popup_blocked");
  if(owned.has(window))throw new ApplicationPortalError("application_popup_binding");
  owned.add(window);
  let stopped=false,stopFailure:ApplicationPortalError|null=null;
  const close=()=>{
    if(stopped){if(stopFailure)throw stopFailure;return;}
    stopped=true;signal.removeEventListener("abort",abort);
    try{window.close();}catch{stopFailure=new ApplicationPortalError("application_popup_stop_failed");throw stopFailure;}
    // Keep the original window reserved even after a successful close. It is
    // never a replacement resource for another operation or generation.
  };
  const abort=()=>{try{close();}catch{/* retained original physical stop failure */}};
  signal.addEventListener("abort",abort,{once:true});
  try{check();}catch(error){close();throw error;}
  return Object.freeze({close,navigate(uri:string){
    check();if(stopped)throw new ApplicationPortalError("application_popup_fenced");
    let url:URL;try{url=new URL(uri);}catch{throw new ApplicationPortalError("application_popup_binding");}
    if(url.origin!==origin||url.username||url.password)throw new ApplicationPortalError("application_popup_binding");
    try{window.navigate(url.href);}catch(error){if(error instanceof ApplicationPortalError)throw error;throw new ApplicationPortalError("application_popup_unavailable");}
    check();if(stopped)throw new ApplicationPortalError("application_popup_fenced");
  }});
}
const browserWindows=new WeakMap<Window,ApplicationPopupWindow>();
/** Default SDK UI adapter. No app callback, browser-runtime or manual URL input. */
export function browserApplicationPortalHost(cpOrigin:string,signal:AbortSignal,isCurrent:()=>boolean,allowLoopbackHttp=false):ApplicationPortalHost {
  return {cpOrigin,signal,isCurrent,allowLoopbackHttp,open(){
    const popup=globalThis.window.open("about:blank","_blank");
    if(!popup)return null;
    const original=browserWindows.get(popup);if(original)return original;
    const port:ApplicationPopupWindow={navigate(uri){
      if(popup.closed)throw new ApplicationPortalError("application_popup_fenced");
      popup.location.href=uri;
    },close(){popup.close();}};
    browserWindows.set(popup,port);return port;
  }};
}
/** System-browser/extension adapter for the public `signIn` opener. Opening is
 * deferred to the first CP-bound navigate; opener failures are not retried and
 * the pairing request persists, so `start()` resumes it in a later context. */
export function openerApplicationPortalHost(cpOrigin:string,signal:AbortSignal,isCurrent:()=>boolean,
  opener:{open(url:string):void|Promise<void>;close?():void|Promise<void>;readonly returnUrl?:string},allowLoopbackHttp=false):ApplicationPortalHost {
  return {cpOrigin,signal,isCurrent,allowLoopbackHttp,open(){
    let opened=false;
    return {navigate(uri){
      const url=new URL(uri);if(opener.returnUrl!==undefined)url.searchParams.set("return_url",opener.returnUrl);
      opened=true;void Promise.resolve().then(()=>opener.open(url.href)).catch(()=>{/* the app owns opener UI failures */});
    },close(){
      if(opened&&opener.close)void Promise.resolve().then(()=>opener.close!()).catch(()=>{/* best-effort dismissal */});
    }};
  }};
}
