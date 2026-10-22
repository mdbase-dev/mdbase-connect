import type { AppNativeAuthorizationContext, AppNativePreparation, AppNativeSelection } from "../app-host/native-sign-in.js";
import type { NativeCompletion } from "../app-grant/native-completion.js";
import { ApplicationWorkerError } from "./worker-protocol.js";
export type NativeAuthorizationCall = Readonly<{rpc:number;action:"prepare";value:AppNativeAuthorizationContext}|{rpc:number;action:"finish";value:AppNativeSelection}|{rpc:number;action:"cancel";value:null}>;
export type NativeAuthorizationResult = AppNativePreparation | NativeCompletion | null;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const fail=():never=>{throw new ApplicationWorkerError("application_worker_binding");};
function exact(v:unknown,keys:string):Record<string,unknown>{
  if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).sort().join()!==keys.split(",").sort().join())return fail();
  return v as Record<string,unknown>;
}
function id(v:unknown):void{if(typeof v!=="string"||!uuid.test(v)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v))fail();}
export function nativeAuthorizationCall(value:unknown):NativeAuthorizationCall{
  const c=exact(value,"rpc,action,value");if(!Number.isSafeInteger(c.rpc)||(c.rpc as number)<1||(c.rpc as number)>0xffffffff)fail();
  if(c.action==="cancel"){if(c.value!==null)fail();}
  else if(c.action==="prepare"){
    const v=exact(c.value,`requestId,accountId,appId,challenge${Object.hasOwn(c.value as object,"authorizationId")?",authorizationId":""}`);
    for(const key of ["requestId","accountId","appId"])id(v[key]);if(v.authorizationId!==undefined)id(v.authorizationId);
    if(typeof v.challenge!=="string"||!/^[0-9a-f]{64}$/.test(v.challenge))fail();
  }else if(c.action==="finish"){
    const v=exact(c.value,"requestId,authorizationRequestId,collectionId");for(const key of Object.keys(v))id(v[key]);
  }else fail();
  return Object.freeze({...c,value:c.value===null?null:Object.freeze({...c.value as object})}) as NativeAuthorizationCall;
}
export function nativePreparation(value:unknown):AppNativePreparation{
  const v=exact(value,"authorizationId,applicationId,manifestDigest");id(v.authorizationId);id(v.applicationId);
  if(typeof v.manifestDigest!=="string"||!/^[0-9a-f]{64}$/.test(v.manifestDigest))fail();
  return Object.freeze({...v}) as unknown as AppNativePreparation;
}
export function nativeAuthorizationReply(value:unknown):{rpc:number;ok:boolean;value?:NativeAuthorizationResult}{
  const v=value as Record<string,unknown>;
  if(!v||!Number.isSafeInteger(v.rpc)||typeof v.ok!=="boolean")return fail();
  exact(v,v.ok?"rpc,ok,value":"rpc,ok");
  if(v.ok && JSON.stringify(v.value).length>4096)fail();
  return v as unknown as {rpc:number;ok:boolean;value?:NativeAuthorizationResult};
}
