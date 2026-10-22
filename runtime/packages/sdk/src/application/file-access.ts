import {mdbaseError} from "../errors.js";
import type {FileAccessGate,FileAction} from "../files.js";
import type {AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {compileApplicationManifest} from "./manifest.js";

/** What an app asks for at the moment of use. Only file actions today. */
export interface MdbaseAccessRequest {readonly files:readonly FileAction[]}
export interface MdbaseAccessRequestOptions {
  /** One line shown to the person in Connect, at most 140 characters. */
  readonly reason:string;
  /** Aborting closes the Connect window and resolves `cancelled`. */
  readonly signal?:AbortSignal;
}
/** `granted`: the open collection's connection may now use `actions` (every
 * file action it is allowed, reads included). `declined`: the person said no.
 * `cancelled`: the window was closed, the request expired or was aborted. */
export type MdbaseAccessResult=
  |{readonly status:"granted";readonly actions:readonly FileAction[]}
  |{readonly status:"declined"}
  |{readonly status:"cancelled"};

const ACTIONS:readonly FileAction[]=["list","read","add","replace","move","delete"];
export interface FileAccessDeclaration {readonly required:readonly FileAction[];readonly optional:readonly FileAction[]}
/** Null when the manifest declares no files: nothing is gated or requestable. */
export function fileAccessDeclaration(compiled:ReturnType<typeof compileApplicationManifest>):FileAccessDeclaration|null{
  const files=compiled.manifest.requirements.files as {readonly optional?:readonly FileAction[]}|undefined;
  if(!files)return null;
  return Object.freeze({required:Object.freeze([...(compiled.files?.actions??[])]),optional:Object.freeze([...(files.optional??[])])});
}
export function consentedFileActions(snapshot:AppWebSignInSnapshot,collectionId:string):readonly FileAction[]{
  return snapshot.collections.find(c=>c.collectionId===collectionId)?.fileActions??[];
}
const refused=(action:FileAction,declared:boolean)=>declared
  ?mdbaseError("forbidden",`File action ${action} needs requestAccess first`,"access_required")
  :mdbaseError("forbidden",`File action ${action} is not declared`,"access_undeclared");
export function fileAccessGate(declaration:FileAccessDeclaration,consented:()=>readonly FileAction[]):FileAccessGate{
  const allows=(action:FileAction)=>declaration.required.includes(action)||(declaration.optional.includes(action)&&consented().includes(action));
  return Object.freeze({allows,check(action:FileAction){if(!allows(action))throw refused(action,declaration.optional.includes(action));}});
}
/** Validate synchronously, in the user gesture. Returns the actions still to
 * ask for (empty: already allowed). */
export function missingFileActions(declaration:FileAccessDeclaration|null,request:MdbaseAccessRequest,options:MdbaseAccessRequestOptions,consented:readonly FileAction[]):readonly FileAction[]{
  const files=request?.files,reason=options?.reason;
  if(!Array.isArray(files)||!files.length||files.some(a=>!ACTIONS.includes(a))||new Set(files).size!==files.length)
    throw mdbaseError("invalid_request","Invalid file actions","access_invalid");
  if(typeof reason!=="string"||!reason.trim()||reason.length>140||/[\u0000-\u001f\u007f\u2028\u2029]/.test(reason))
    throw mdbaseError("invalid_request","Reason must be one line, 1-140 characters","access_invalid");
  const missing:FileAction[]=[];
  for(const action of files){
    if(declaration?.required.includes(action))continue;
    if(!declaration?.optional.includes(action))throw refused(action,false);
    if(!consented.includes(action))missing.push(action);
  }
  return Object.freeze(missing);
}
/** Every file action the open connection may now use. */
export function grantedResult(files:{readonly grant:{readonly actions:readonly FileAction[]}|null},declaration:FileAccessDeclaration|null,consented:readonly FileAction[]):MdbaseAccessResult{
  const actions=files.grant?.actions??[...new Set([...(declaration?.required??[]),...consented])];
  return Object.freeze({status:"granted",actions:Object.freeze([...actions])});
}
interface FileAccessPort {
  start():Promise<AppWebSignInSnapshot>;
  poll(requestId:string):Promise<unknown>;
  native():AppWebSignInSnapshot;
  granted():MdbaseAccessResult;
}
const CANCELLED:MdbaseAccessResult=Object.freeze({status:"cancelled"});
const DECLINED:MdbaseAccessResult=Object.freeze({status:"declined"});
/** Wait up to 1.5 s, or until the person closes the window (true). */
function tick(signal:AbortSignal,portal:{readonly closed:boolean}):Promise<boolean>{
  return new Promise(resolve=>{
    let n=0;const done=(closed:boolean)=>{clearInterval(timer);signal.removeEventListener("abort",abort);resolve(closed);},abort=()=>done(false);
    const timer=setInterval(()=>{if(portal.closed)done(true);else if(++n>=3)done(false);},500);
    signal.addEventListener("abort",abort,{once:true});
  });
}
/** Start the request, then read its outcome until granted, declined or
 * cancelled. A closed window gets one last read: Connect records an approval
 * before its window can close. */
export async function awaitFileAccess(port:FileAccessPort,portal:{close():void;readonly closed:boolean},signal:AbortSignal):Promise<MdbaseAccessResult>{
  const finish=(result:MdbaseAccessResult)=>{try{portal.close();}catch{/* the window may already be gone */}return result;};
  let started:AppWebSignInSnapshot;
  try{started=await port.start();}catch(error){if(signal.aborted)return finish(CANCELLED);throw error;}
  const id=started.fileAccess?.requestId;
  for(let last=false;;){
    const current=port.native().fileAccess;
    if(!id||current?.requestId!==id)return finish(CANCELLED);
    if(current.state==="granted")return finish(port.granted());
    if(current.state==="declined")return finish(DECLINED);
    if(current.state==="expired"||last||signal.aborted)return finish(CANCELLED);
    last=await tick(signal,portal);
    if(signal.aborted)return finish(CANCELLED);
    await port.poll(id).catch(()=>{});
  }
}
