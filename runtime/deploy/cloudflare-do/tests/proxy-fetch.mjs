// TEST HARNESS ONLY: not imported by Worker/deploy artifacts.
// Correlate a single CORS fixture request, never retry an unexplained Worker500.
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const TAG='__logsvc_proxy_probe',LOG_CAP=16384;
function logPosition(path){try{return statSync(path).size;}catch{return null;}}
function disconnect(path,position,method,url){
  if(position===null)return false;
  let fd;
  try{
    fd=openSync(path,'r');const length=fstatSync(fd).size-position;
    if(length<=0||length>LOG_CAP)return false;
    const bytes=Buffer.alloc(length);let n=0;
    while(n<length){const got=readSync(fd,bytes,n,length-n,position+n);if(!got)break;n+=got;}
    const text=bytes.subarray(0,n).toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');
    return text.split('\n').some(line=>line.includes('Error inside ProxyWorker')&&
      line.includes(`: ${method} ${url} (failed after `)&&line.includes('Network connection lost.'));
  }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}
// agent:false guarantees a NEW client→dev-proxy socket. Forward Connection:close
// too, so the proxy's ordinary forwarding path requests closure on its inner hop.
// We do not patch Wrangler, assert native socket internals, or retry a second time.
export function freshHttp(url,init){
  return new Promise((resolve,reject)=>{
    const headers=new Headers(init.headers);headers.set('connection','close');
    if(typeof init.body==='string'&&!headers.has('content-type'))headers.set('content-type','text/plain;charset=UTF-8');
    const req=request(url,{method:init.method,headers:Object.fromEntries(headers),agent:false,signal:init.signal},res=>{
      const responseHeaders=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)responseHeaders.append(res.rawHeaders[i],res.rawHeaders[i+1]);
      const empty=[204,205,304].includes(res.statusCode)||init.method==='HEAD';
      if(empty)res.resume();
      resolve(new Response(empty?null:Readable.toWeb(res),{status:res.statusCode,statusText:res.statusMessage,headers:responseHeaders}));
    });
    req.once('error',reject);req.end(init.body);
  });
}
export function createProxyFetch({base,logPath,initialFetch=globalThis.fetch,freshFetch=freshHttp,
  emit=event=>console.log(JSON.stringify(event))}){
  const origin=new URL(base).origin;
  return async(input,init={})=>{
    const url=new URL(input);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.origin!==origin||url.searchParams.has(TAG))throw Error('local CORS test scope');
    // Only immutable/replayable fixture bytes, never a request stream or SDK
    // mutation lifecycle. Signed body/path stay byte-identical; query is a unique
    // TEST-only log correlation tag (the protocol signs pathname, not query).
    let body=init.body;
    if(body!==undefined&&body!==null&&typeof body!=='string'){
      if(!(body instanceof Uint8Array))throw Error('nonreplayable CORS fixture');
      body=Buffer.from(body);
    }
    const id=randomUUID();url.searchParams.set(TAG,id);
    const options={...init,method:(init.method??'GET').toUpperCase(),headers:new Headers(init.headers),body};
    const position=logPosition(logPath);
    let response,failure;
    try{response=await initialFetch(url.href,options);}catch(error){failure=error;}
    if(!failure&&response.status<500)return response;
    let evidence=false;
    // ProxyController writes asynchronously. Bounded local log observation only;
    // never a timer-based HTTP retry or permission to accept an unexplained500.
    for(let i=0;i<26;i++){
      evidence=disconnect(logPath,position,options.method,url.href);
      if(evidence)break;
      if(i<25)await delay(10);
    }
    if(!evidence){if(failure)throw failure;return response;}
    if(response?.body)await response.body.cancel();
    emit({event:'local_proxy_disconnect_retry',request:id,method:options.method,attempt:2,
      connection:'fresh-client-close',reason:'exact-request-wrangler-proxy-network-connection-lost'});
    return freshFetch(url.href,options); // ONE only; even another proxy500 fails.
  };
}
