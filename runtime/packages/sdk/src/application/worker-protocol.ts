import type {ApplicationDeclarationSnapshot} from "./declaration.js";
import {MdbaseError,isErrorCode} from "../errors.js";
import {AppInstallationSignInError} from "../app-host/installation-sign-in.js";
import {AppCollectionDeleteError,COLLECTION_DELETE_CODES} from "../app-host/collection-delete.js";
import type {AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {AppWebCollectionHandoff} from "../app-host/web-collection.js";

export const APPLICATION_WORKER_PROTOCOL="mdbn-application-worker/1";
export const APPLICATION_WORKER_MAX_ID=0xffffffff;
export type ApplicationWorkerAction="start"|"authorize"|"renewExpiredPairing"|"select"|"clearSelection"|"forget"|"refreshCollections"|"signOut"|"deleteCollection"|"requestFileAccess"|"pollFileAccess"|"foreground"|"approvalClosed"|"close";
/** `deleteCollection` payload: [collection UUID, typed confirmation name].
 * `requestFileAccess` payload: [collection UUID, file actions, reason]. */
export type ApplicationWorkerPayload=string|boolean|null|readonly[string,string]|readonly[string,readonly string[],string];
export type ApplicationWorkerBootstrap=readonly[typeof APPLICATION_WORKER_PROTOCOL,string,Readonly<ApplicationDeclarationSnapshot>];
/** ID zero is a bounded one-way UI signal (visibility, or `approvalClosed`:
 * the person closed the held approval window), not an operation/RPC.
 * Original asynchronous operations retain the sole positive-ID slot. */
export type ApplicationWorkerRequest=readonly[typeof APPLICATION_WORKER_PROTOCOL,string,number,ApplicationWorkerAction,ApplicationWorkerPayload];
export interface ApplicationWorkerProblem {readonly code:string}
/** Private transport snapshot, NOT aggregate semantic READY. The SDK UI owner
 * must join current native evidence and all declaration-required facets. */
export type ApplicationWorkerEvent=
  |readonly[typeof APPLICATION_WORKER_PROTOCOL,string,"nativeAuthorization",number,import("./native-authorization-rpc.js").NativeAuthorizationCall]
  |readonly[typeof APPLICATION_WORKER_PROTOCOL,string,"nativeSnapshot",0,AppWebSignInSnapshot]
  |readonly[typeof APPLICATION_WORKER_PROTOCOL,string,"reply",number,{readonly ok:true;readonly snapshot:AppWebSignInSnapshot}|{readonly ok:false;readonly problem:ApplicationWorkerProblem}]
  |readonly[typeof APPLICATION_WORKER_PROTOCOL,string,"portal",number,{readonly action:"navigate";readonly uri:string}|{readonly action:"close"}]
  |readonly[typeof APPLICATION_WORKER_PROTOCOL,string,"handoff",number,AppWebCollectionHandoff]
  |readonly[typeof APPLICATION_WORKER_PROTOCOL,string,"fatal",0,ApplicationWorkerProblem];
export class ApplicationWorkerError extends Error {
  constructor(readonly code:"application_worker_binding"|"application_worker_busy"|"application_worker_fenced"|"application_worker_unavailable"|"application_worker_stop_failed"){
    super("SDK application Worker unavailable");this.name="ApplicationWorkerError";
  }
}
export function applicationWorkerBinding(value:unknown):value is string{return typeof value==="string"&&/^[a-zA-Z0-9_-]{16,128}$/.test(value);}
export function applicationWorkerRequest(value:unknown,binding:string):ApplicationWorkerRequest {
  const fail=():never=>{throw new ApplicationWorkerError("application_worker_binding");};
  if(!Array.isArray(value)||value.length!==5||value[0]!==APPLICATION_WORKER_PROTOCOL||value[1]!==binding||
    !Number.isInteger(value[2])||value[2]<0||value[2]>APPLICATION_WORKER_MAX_ID||(value[2]===0&&value[3]!=="foreground"&&value[3]!=="approvalClosed")||(value[2]!==0&&value[3]==="approvalClosed"))return fail();
  const action=value[3],payload=value[4];
  if(!["start","authorize","renewExpiredPairing","select","clearSelection","forget","refreshCollections","signOut","deleteCollection","requestFileAccess","pollFileAccess","foreground","approvalClosed","close"].includes(action))fail();
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if(action==="requestFileAccess"){
    if(!Array.isArray(payload)||payload.length!==3||typeof payload[0]!=="string"||!uuid.test(payload[0])||!Array.isArray(payload[1])||!payload[1].length||payload[1].length>6||
      payload[1].some((a:unknown)=>typeof a!=="string"||!["list","read","add","replace","move","delete"].includes(a))||typeof payload[2]!=="string"||!payload[2]||payload[2].length>140)fail();
    return Object.freeze([value[0],value[1],value[2],action,Object.freeze([payload[0],Object.freeze([...payload[1]]),payload[2]])]) as ApplicationWorkerRequest;
  }
  if(action==="pollFileAccess"){if(typeof payload!=="string"||!uuid.test(payload))fail();}
  else if(action==="select"||action==="forget"){
    if(typeof payload!=="string"||!payload||payload.length>256||/[\u0000-\u001f\u007f]/.test(payload))fail();
  }else if(action==="deleteCollection"){
    if(!Array.isArray(payload)||payload.length!==2||typeof payload[0]!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload[0])||
      typeof payload[1]!=="string"||!payload[1]||payload[1].length>1024)fail();
    return Object.freeze([value[0],value[1],value[2],action,Object.freeze([payload[0],payload[1]])]) as ApplicationWorkerRequest;
  }else if(action==="authorize"){
    // Optional transient collection hint (canonical UUID) for Connect preselection.
    if(payload!==null&&(typeof payload!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload)||payload==="00000000-0000-0000-0000-000000000000"))fail();
  }else if(action==="foreground"){if(typeof payload!=="boolean")fail();}
  else if(action==="approvalClosed"){if(payload!==true)fail();}
  else if(payload!==null)fail();
  return Object.freeze([...value]) as ApplicationWorkerRequest;
}
/** Bounded code only. Never return messages, stacks, causes, response bodies,
 * account/installation identities, secrets or arbitrary rejection objects. */
export function applicationWorkerProblem(error:unknown):ApplicationWorkerProblem {
  try {
  if(error instanceof ApplicationWorkerError)return Object.freeze({code:error.code});
  if(error instanceof AppCollectionDeleteError&&(COLLECTION_DELETE_CODES as readonly string[]).includes(error.code))return Object.freeze({code:error.code});
  if(error instanceof AppInstallationSignInError&&["binding","fenced","busy","open_in_another_tab","account_confirmation_required","outcome_unknown","unavailable","response","refused","expired","recovery_required"].includes(error.reason))return Object.freeze({code:error.reason});
  if(error instanceof MdbaseError&&isErrorCode(error.code)){
    const allowed=["sign_out_failed","application_packaged_assets_unavailable","application_production_trust_unavailable","application_asset_binding","application_asset_unavailable","application_asset_fetch","application_asset_response","application_asset_stop_failed","application_asset_fenced"];
    return Object.freeze({code:error.reason&&allowed.includes(error.reason)?error.reason:error.code});
  }
  }catch{/* hostile rejection/prototype/getter is not an error DTO producer */}
  return Object.freeze({code:"application_worker_unavailable"});
}
