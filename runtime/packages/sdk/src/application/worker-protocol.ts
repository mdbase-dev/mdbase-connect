import type {ApplicationDeclarationSnapshot} from "./declaration.js";
import {MdbaseError,isErrorCode} from "../errors.js";
import {AppInstallationSignInError} from "../app-host/installation-sign-in.js";
import type {AppWebSignInSnapshot} from "../app-host/web-sign-in-session.js";
import type {AppWebCollectionHandoff} from "../app-host/web-collection.js";

export const APPLICATION_WORKER_PROTOCOL="mdbn-application-worker/1";
export const APPLICATION_WORKER_MAX_ID=0xffffffff;
export type ApplicationWorkerAction="start"|"authorize"|"renewExpiredPairing"|"select"|"clearSelection"|"forget"|"foreground"|"close";
export type ApplicationWorkerBootstrap=readonly[typeof APPLICATION_WORKER_PROTOCOL,string,Readonly<ApplicationDeclarationSnapshot>];
/** ID zero is a bounded one-way visibility signal, not an operation/RPC.
 * Original asynchronous operations retain the sole positive-ID slot. */
export type ApplicationWorkerRequest=readonly[typeof APPLICATION_WORKER_PROTOCOL,string,number,ApplicationWorkerAction,string|boolean|null];
export interface ApplicationWorkerProblem {readonly code:string}
/** Private transport snapshot, NOT aggregate semantic READY. The SDK UI owner
 * must join current native evidence and all declaration-required facets. */
export type ApplicationWorkerEvent=
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
    !Number.isInteger(value[2])||value[2]<0||value[2]>APPLICATION_WORKER_MAX_ID||(value[2]===0&&value[3]!=="foreground"))return fail();
  const action=value[3],payload=value[4];
  if(!["start","authorize","renewExpiredPairing","select","clearSelection","forget","foreground","close"].includes(action))fail();
  if(action==="select"||action==="forget"){
    if(typeof payload!=="string"||!payload||payload.length>256||/[\u0000-\u001f\u007f]/.test(payload))fail();
  }else if(action==="authorize"){
    // Optional transient collection hint (canonical UUID) for Connect preselection.
    if(payload!==null&&(typeof payload!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload)||payload==="00000000-0000-0000-0000-000000000000"))fail();
  }else if(action==="foreground"){if(typeof payload!=="boolean")fail();}
  else if(payload!==null)fail();
  return Object.freeze([...value]) as ApplicationWorkerRequest;
}
/** Bounded code only. Never return messages, stacks, causes, response bodies,
 * account/installation identities, secrets or arbitrary rejection objects. */
export function applicationWorkerProblem(error:unknown):ApplicationWorkerProblem {
  try {
  if(error instanceof ApplicationWorkerError)return Object.freeze({code:error.code});
  if(error instanceof AppInstallationSignInError&&["binding","fenced","busy","account_confirmation_required","outcome_unknown","response","refused","expired","recovery_required"].includes(error.reason))return Object.freeze({code:error.reason});
  if(error instanceof MdbaseError&&isErrorCode(error.code)){
    const allowed=["application_packaged_assets_unavailable","application_production_trust_unavailable","application_asset_binding","application_asset_unavailable","application_asset_fetch","application_asset_response","application_asset_stop_failed","application_asset_fenced"];
    return Object.freeze({code:error.reason&&allowed.includes(error.reason)?error.reason:error.code});
  }
  }catch{/* hostile rejection/prototype/getter is not an error DTO producer */}
  return Object.freeze({code:"application_worker_unavailable"});
}
