// Hermetic classification/one-shot/socket tests, not provider operations.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createProxyFetch,freshHttp} from './proxy-fetch.mjs';
mkdirSync('.wrangler',{recursive:true});
const base='http://127.0.0.1:19999';
const message=(method,url)=>`Error inside ProxyWorker (the affected request failed; the dev server continues): ${method} ${url} (failed after 1 attempt): Network connection lost.\n`;
async function fixture(run){const dir=mkdtempSync(resolve('.wrangler/proxy-fetch-unit-')),logPath=join(dir,'wrangler.log');writeFileSync(logPath,'',{mode:0o600});try{await run(logPath);}finally{rmSync(dir,{recursive:true});}}
test('Worker-generated500 does not retry or change its status/body',()=>fixture(async logPath=>{
 let count=0;const r=new Response('Worker error',{status:500});const f=createProxyFetch({base,logPath,initialFetch:async()=>{count++;return r;},freshFetch:()=>assert.fail('must not retry Worker500'),emit:()=>assert.fail('no proxy event')});
 const out=await f(base+'/v1/rpc',{method:'OPTIONS'});assert.equal(out,r);assert.equal(out.status,500);assert.equal(await out.text(),'Worker error');assert.equal(count,1);
}));
test('exact unique request proxy500 gets ONE replay, stable signed bytes/header/path, safe event',()=>fixture(async logPath=>{
 const data=Buffer.from('synthetic-private-body'),headers={authorization:'Bearer synthetic-private-token','x-mdbase-sig':'synthetic-private-signature'};let seen,events=[],calls=0;
 const f=createProxyFetch({base,logPath,initialFetch:async(url,init)=>{calls++;seen={url,body:Buffer.from(init.body),authorization:init.headers.get('authorization')};appendFileSync(logPath,message('POST',url));data.fill(0);headers.authorization='changed';return new Response('proxy',{status:500});},
  freshFetch:async(url,init)=>{calls++;assert.equal(url,seen.url);assert.equal(new URL(url).pathname,'/v1/rpc');assert.deepEqual(init.body,seen.body);assert.equal(init.headers.get('authorization'),seen.authorization);return new Response('ok');},emit:e=>events.push(e)});
 const out=await f(base+'/v1/rpc',{method:'POST',headers,body:data});assert.equal(out.status,200);assert.equal(calls,2);assert.equal(events.length,1);assert.equal(events[0].attempt,2);assert.equal(events[0].connection,'fresh-client-close');assert.match(events[0].request,/^[0-9a-f-]{36}$/);
 for(const privateValue of ['synthetic-private-body','synthetic-private-token','synthetic-private-signature'])assert.equal(JSON.stringify(events).includes(privateValue),false);
}));
for(const mode of ['old-log','wrong-request','wrong-method','no-proxy','no-disconnect','oversized-window'])
 test(`does not retry ${mode} evidence`,()=>fixture(async logPath=>{
  if(mode==='old-log')appendFileSync(logPath,message('OPTIONS',base+'/v1/rpc'));
  let called=0;const f=createProxyFetch({base,logPath,initialFetch:async(url)=>{called++;
   if(mode==='wrong-request')appendFileSync(logPath,message('OPTIONS',url.replace(/__logsvc_proxy_probe=[^&]+/,'__logsvc_proxy_probe=another')));
   if(mode==='wrong-method')appendFileSync(logPath,message('GET',url));
   if(mode==='no-proxy')appendFileSync(logPath,`Native Worker error: OPTIONS ${url}: Network connection lost.\n`);
   if(mode==='no-disconnect')appendFileSync(logPath,`Error inside ProxyWorker: OPTIONS ${url} (failed after 1 attempt): Other error.\n`);
   if(mode==='oversized-window')appendFileSync(logPath,'x'.repeat(16385)+message('OPTIONS',url));
   return new Response('genuine error',{status:500});},freshFetch:()=>assert.fail('unproven failure must not replay')});
  const out=await f(base+'/v1/rpc',{method:'OPTIONS'});assert.equal(out.status,500);assert.equal(called,1);
 }));
test('second proxy500 still fails; no recursive retry',()=>fixture(async logPath=>{
 let count=0,events=0;const f=createProxyFetch({base,logPath,initialFetch:async url=>{count++;appendFileSync(logPath,message('OPTIONS',url));return new Response('proxy',{status:500});},freshFetch:async url=>{count++;appendFileSync(logPath,message('OPTIONS',url));return new Response('second failure',{status:500});},emit:()=>events++});
 const out=await f(base+'/v1/rpc',{method:'OPTIONS'});assert.equal(out.status,500);assert.equal(await out.text(),'second failure');assert.equal(count,2);assert.equal(events,1);
}));
test('ProxyController asynchronous log is correlated before retry',()=>fixture(async logPath=>{
 let count=0;const f=createProxyFetch({base,logPath,initialFetch:async url=>{count++;setTimeout(()=>appendFileSync(logPath,message('OPTIONS',url)),30);return new Response('proxy',{status:500});},freshFetch:async()=>{count++;return new Response(null,{status:204});},emit:()=>{}});
 assert.equal((await f(base+'/v1/rpc',{method:'OPTIONS'})).status,204);assert.equal(count,2);
}));
test('transport exceptions require exact log; response successes never retry',()=>fixture(async logPath=>{
 const original=new TypeError('synthetic transport');let fresh=0;
 for(const evidence of [false,true]){
  const f=createProxyFetch({base,logPath,initialFetch:async url=>{if(evidence)appendFileSync(logPath,message('POST',url));throw original;},freshFetch:async()=>{fresh++;return new Response('ok');},emit:()=>{}});
  if(evidence)assert.equal((await f(base+'/v1/rpc',{method:'POST',body:'fixture'})).status,200);
  else await assert.rejects(f(base+'/v1/rpc',{method:'POST',body:'fixture'}),e=>e===original);
 }
 assert.equal(fresh,1);
 const f=createProxyFetch({base,logPath,initialFetch:async url=>{appendFileSync(logPath,message('GET',url));return new Response('ok');},freshFetch:()=>assert.fail('success must not replay')});assert.equal((await f(base+'/v1/nonce')).status,200);
}));
test('rejects foreign targets, caller correlation tags and nonreplayable streams before network',()=>fixture(async logPath=>{
 const f=createProxyFetch({base,logPath,initialFetch:()=>assert.fail('invalid scope must not send')});
 for(const url of ['http://localhost:19999/v1/rpc','http://127.0.0.1:20000/v1/rpc','https://production.test','http://127.0.0.1:19999/v1/rpc?__logsvc_proxy_probe=x'])await assert.rejects(f(url));
 await assert.rejects(f(base+'/v1/rpc',{method:'POST',body:new ReadableStream()}),/nonreplayable/);
}));
test('fresh HTTP retry has a distinct TCP socket, Connection close, unchanged body/headers',()=>fixture(async logPath=>{
 const requests=[];const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push({socket:req.socket,body:Buffer.concat(chunks).toString(),headers:req.headers,url:req.url});
  if(requests.length===1){appendFileSync(logPath,message(req.method,`http://${req.headers.host}${req.url}`));res.writeHead(500);res.end('proxy');}
  else {res.writeHead(200);res.end('ok');}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const local=`http://127.0.0.1:${server.address().port}`;
 try{const events=[];const f=createProxyFetch({base:local,logPath,emit:e=>events.push(e)});const out=await f(local+'/v1/rpc',{method:'POST',headers:{authorization:'Bearer fixture'},body:'unchanged'});
  assert.equal(out.status,200);assert.equal(await out.text(),'ok');assert.equal(requests.length,2);assert.notEqual(requests[0].socket,requests[1].socket);assert.equal(requests[1].headers.connection,'close');assert.equal(requests[1].headers.authorization,'Bearer fixture');assert.equal(requests[1].body,'unchanged');assert.equal(requests[0].url,requests[1].url);assert.equal(events.length,1);
  const empty=createServer((req,res)=>{res.writeHead(204);res.end();});empty.listen(0,'127.0.0.1');await once(empty,'listening');try{const r=await freshHttp(`http://127.0.0.1:${empty.address().port}/`,{method:'OPTIONS'});assert.equal(r.status,204);assert.equal(await r.text(),'');}finally{empty.closeAllConnections();await new Promise(resolve=>empty.close(resolve));}
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));
