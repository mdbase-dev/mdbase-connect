// Actual outer Worker/actor/WASM/SQLite paths in local workerd, synthetic signers.
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
export async function corsCases({base,token,transport,encode,decode,map,sha,h,fetch=globalThis.fetch}) {
  const origins=['http://127.0.0.1:48218','https://lab.tasknotes-app.pages.dev'];
  const signing='authorization,content-type,x-mdbase-nonce,x-mdbase-sig';
  const preflight=(origin,method='POST',headers=signing)=>fetch(`${base}/v1/rpc`,{method:'OPTIONS',headers:{...(origin?{origin}:{}),'access-control-request-method':method,'access-control-request-headers':headers}});
  function cors(r,origin){assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.match(r.headers.get('vary'),/(^|,\s*)Origin(,|$)/i);assert.equal(r.headers.get('access-control-allow-credentials'),null);}
  for(const origin of origins){
    let r=await preflight(origin);assert.equal(r.status,204);cors(r,origin);assert.equal(await r.text(),'');
    assert.equal(r.headers.get('access-control-allow-methods'),'GET, POST, PUT');
    assert.equal(r.headers.get('access-control-max-age'),'7200','allowed preflights are cacheable');
    for(const name of signing.split(','))assert.ok(r.headers.get('access-control-allow-headers').split(',').map(x=>x.trim()).includes(name));
    r=await fetch(`${base}/v1/nonce`,{headers:{origin}});assert.equal(r.status,200);cors(r,origin);assert.match(await r.text(),/^[0-9a-f]{64}$/);
    for(const authorization of [undefined,'Bearer invalid']){
      r=await fetch(`${base}/v1/rpc`,{method:'POST',headers:{origin,...(authorization?{authorization}:{})},body:'not authenticated'});
      assert.equal(r.status,401);cors(r,origin);
      assert.match(r.headers.get('x-mdbase-next-nonce'),/^[0-9a-f]{64}$/);
      assert.ok(r.headers.get('access-control-expose-headers').split(',').map(x=>x.trim()).includes('x-mdbase-next-nonce'));
    }
  }
  for(const origin of [undefined,'null','https://evil.test','https://lab.tasknotes-app.pages.dev.evil.test','http://127.0.0.1:48219','https://app.tasknotes.dev','https://lab.tasknotes-app.pages.dev/']){
    const r=await preflight(origin);assert.equal(r.status,403);assert.equal(await r.text(),'');assert.equal(r.headers.get('access-control-allow-origin'),null);assert.equal(r.headers.get('access-control-max-age'),null);
    const real=await fetch(`${base}/health`,{headers:origin?{origin}:{}});assert.equal(real.status,200);cors(real,null);
  }
  for(const [method,headers] of [['DELETE',signing],['POST','cookie'],['POST','authorization,x-arbitrary']]){
    const r=await preflight(origins[0],method,headers);assert.equal(r.status,403);assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  // Preflight cannot consume the body or read auth keys/native bindings, even
  // when the signed-RPC header names are requested. Explicit poisoned getters.
  for(const [origin,configured,expected] of [[origins[0],undefined,204],['https://evil.test',undefined,403],[origins[0],'*',503],[origins[0],'',403]]){
    const r=await fetch(`${base}/__test/ingress`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'OPTIONS',size:65536,corsMetadataOnly:true,...(configured!==undefined?{corsOrigins:configured}:{}),headers:{origin,'access-control-request-method':'POST','access-control-request-headers':signing}})});
    assert.equal(r.status,200);const observed=await r.json();assert.equal(observed.status,expected);
    for(const field of ['emitted','pulls','forwarded','r2writes'])assert.equal(observed[field],0,field);
    if(expected!==503)assert.deepEqual(observed.response,[]);
  }
  const c=Buffer.alloc(16,0x6b),body=encode(map([[0,0],[1,71],[2,'head'],[3,map([[0,c]])]]));
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/v1/ws?c=6b6b6b6b-6b6b-6b6b-6b6b-6b6b6b6b6b6b`, { headers: { origin: origins[0] } });
  let upgrade;
  socket.once('upgrade', response => { upgrade = response; });
  try {
    await once(socket, 'open');
    assert.equal(upgrade.statusCode, 101);
    assert.equal(upgrade.headers['access-control-allow-origin'], origins[0]);
    assert.match(upgrade.headers.vary, /Origin/i);
  } finally { const closed = once(socket, 'close'); socket.terminate(); await closed; }
  const n=Buffer.from(await(await fetch(`${base}/v1/nonce`)).text(),'hex');
  const digest=h('mdbase/v1/ls-http',Buffer.concat([Buffer.from('head\0/v1/rpc\0'),c,sha(Buffer.from(token)),sha(body),n]));
  const headers={origin:origins[0],authorization:`Bearer ${token}`,'x-mdbase-nonce':n.toString('hex'),'x-mdbase-sig':'00'.repeat(64)};
  let r=await fetch(`${base}/v1/rpc`,{method:'POST',headers,body});assert.equal(r.status,200);cors(r,origins[0]);
  let error=decode(Buffer.from(await r.arrayBuffer())).get(3);assert.equal(error.get(0),'unauthenticated');assert.equal(error.get(1),'possession');
  headers['x-mdbase-sig']=sign(null,digest,transport).toString('hex');
  r=await fetch(`${base}/v1/rpc`,{method:'POST',headers,body});assert.equal(r.status,200);cors(r,origins[0]);
  error=decode(Buffer.from(await r.arrayBuffer())).get(3);assert.equal(error.get(0),'not_found','good possession reaches authenticated dispatch; bad proof did not consume nonce');
  r=await fetch(`${base}/v1/rpc`,{method:'POST',headers,body});assert.equal(r.status,200);cors(r,origins[0]);
  error=decode(Buffer.from(await r.arrayBuffer())).get(3);assert.equal(error.get(0),'unauthenticated');assert.equal(error.get(1),'replay');
  console.log('PASS CORS: exact origins, preflight/zero effects, nonce/401/actor responses/WebSocket upgrade, possession and nonce replay unchanged');
}
