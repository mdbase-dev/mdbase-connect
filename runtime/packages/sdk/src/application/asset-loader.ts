import {isMdbaseError,mdbaseError} from "../errors.js";

/** SDK build/packaging input only, not an application declaration option.
 * Hash integrity does NOT authenticate this descriptor or the release context. */
export interface ApplicationAsset {
  readonly url:string;
  readonly sha256:string;
  readonly bytes:number;
  readonly maxBytes:number;
}
export interface ApplicationAssetHost {
  readonly origin:string;
  readonly environment:"lab"|"production";
  readonly fetch?:typeof fetch;
}
const error=(reason:string)=>mdbaseError("unavailable","application asset unavailable",reason);
const fenced=()=>mdbaseError("cancelled","application asset read fenced","application_asset_fenced");
function check(signal:AbortSignal):void{if(signal.aborted)throw fenced();}

/** Private same-artifact transport. The SDK release generator supplies immutable
 * URLs/digests/byte counts from authenticated packaging, never the app or CP.
 * Owns each streaming reader until original work drains; no retry or fallback. */
export function applicationAssetLoader(input:ApplicationAsset,source:ApplicationAssetHost):
  (options:{signal:AbortSignal})=>Promise<Uint8Array>{
  const asset=Object.freeze({...input}),host=Object.freeze({...source});
  let url:URL,origin:URL;
  try{url=new URL(asset.url);origin=new URL(host.origin);}catch{throw error("application_asset_binding");}
  const loopback=["localhost","127.0.0.1","[::1]"].includes(origin.hostname);
  if(origin.origin!==host.origin||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=="/"
    ||!["lab","production"].includes(host.environment)||url.origin!==host.origin||url.username||url.password||url.search||url.hash
    ||(url.protocol!=="https:"&&!(host.environment==="lab"&&url.protocol==="http:"&&loopback))
    ||!/^[0-9a-f]{64}$/.test(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1
    ||!Number.isSafeInteger(asset.maxBytes)||asset.maxBytes<asset.bytes||asset.maxBytes>4*1024*1024)throw error("application_asset_binding");
  const fetcher=host.fetch??globalThis.fetch;
  if(typeof fetcher!=="function")throw error("application_asset_unavailable");
  return async({signal})=>{
    check(signal);
    let response:Response;
    try{response=await fetcher(url.href,{signal,credentials:"omit",cache:"no-store",redirect:"error"});}
    catch{check(signal);throw error("application_asset_fetch");}
    // Acquire response cleanup before checking cancellation after ignored-abort IO.
    const reader=response.body?.getReader();
    if(!reader){check(signal);throw error("application_asset_response");}
    let finished=false,closing:Promise<void>|null=null;
    const close=()=>closing??=Promise.resolve().then(async()=>{
      try{await reader.cancel();}catch{throw error("application_asset_stop_failed");}
    });
    const onAbort=()=>{void close().catch(()=>{});};
    signal.addEventListener("abort",onAbort,{once:true});
    try{
      check(signal);
      if(!response.ok||response.redirected||(response.url&&response.url!==url.href))throw error("application_asset_response");
      const length=response.headers.get("content-length");
      if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)!==asset.bytes))throw error("application_asset_binding");
      const bytes=new Uint8Array(asset.bytes);let offset=0;
      while(true){
        const part=await reader.read();check(signal);
        if(part.done){finished=true;break;}
        if(!(part.value instanceof Uint8Array)||part.value.byteLength>asset.bytes-offset)throw error("application_asset_binding");
        bytes.set(part.value,offset);offset+=part.value.byteLength;
      }
      if(offset!==asset.bytes)throw error("application_asset_binding");
      const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));check(signal);
      if(Array.from(digest,byte=>byte.toString(16).padStart(2,"0")).join("")!==asset.sha256)throw error("application_asset_binding");
      check(signal);return bytes;
    }catch(cause){
      check(signal);
      if(isMdbaseError(cause))throw cause;
      throw error("application_asset_response");
    }finally{
      signal.removeEventListener("abort",onAbort);
      try{if(!finished||signal.aborted)await close();}finally{reader.releaseLock();}
    }
  };
}
