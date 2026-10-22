// Fresh CP metadata checks over substituted fetch; no managed-runtime evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlClient } from "../src/control.ts";
import { PITR_RUN } from "../src/pitr-phase.ts";
const active = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const deleted = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const binding = {run:PITR_RUN,active,deleted,codeConfigSha256:"aa".repeat(32),members:[
  ...[active,deleted].map((collection,i)=>({kind:"log",collection,namespace:"01".repeat(16),object:`0${i+1}`.repeat(32)})),
  {kind:"registry",collection:"00000000-0000-0000-0000-000000000000",namespace:"01".repeat(16),object:"03".repeat(32)},
  ...[active,deleted].map((collection,i)=>({kind:"hosted",collection,namespace:"02".repeat(16),object:`0${i+4}`.repeat(32)})),
]};
const config = {url:"https://connect-lab.mdbase.dev",token:"h".repeat(40),pitr:{binding,token:"p".repeat(40)}};
const identity = {collection:active,device:"11111111-1111-4111-a111-111111111111",kind:"hosted",signPublicKey:"aa".repeat(32),genesisSha256:"bb".repeat(32),policyKeyId:"cc".repeat(16)};
const grantIdentity={principal:"app-grant",collection:active,grant:"44444444-4444-4444-a444-444444444444",clientPublicKey:"ee".repeat(32),genesisSha256:identity.genesisSha256,policyKeyId:identity.policyKeyId};
const cpGenesisIdentity={principal:"control-plane",purpose:"pending-original-genesis",collection:active,genesisSha256:identity.genesisSha256,
  transportPublicKey:"07".repeat(32),issuerKeyId:"08".repeat(16),policyKeyId:identity.policyKeyId};
const cpCollectionIdentity={...cpGenesisIdentity,purpose:"collection"};
const {genesisSha256:_unused,...cpCommon}=cpGenesisIdentity;
const nilReadIdentity={...cpCommon,purpose:"registry-read",collection:"00000000-0000-0000-0000-000000000000",activeGenesisSha256:"bb".repeat(32),deletedGenesisSha256:"dd".repeat(32)};
const nilRecordIdentity={...nilReadIdentity,purpose:"deletion-record",subject:deleted,deletionId:identity.device,lifecycleEpoch:"1"};
const nilPeekIdentity={...cpGenesisIdentity,collection:nilReadIdentity.collection,purpose:"deletion-peek",subject:active};
const cpCases=[
  ["assertPitrCurrentCpNilPeek",nilPeekIdentity,"current-cp-nil-peek"],
  ["assertPitrCurrentCpCollection",cpCollectionIdentity,"current-cp-collection"],
  ["assertPitrCurrentCpNilRead",nilReadIdentity,"current-cp-nil-read"],
  ["assertPitrCurrentCpNilRecord",nilRecordIdentity,"current-cp-nil-record"],
];
const signal=()=>new AbortController().signal;
const reply = (i=identity,checkedAt=1000)=>({...i,run:PITR_RUN,current:true,checkedAt});
const client = (f,c=config,clock=()=>1000)=>new ControlClient(c,f,clock);
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test("fixed LAB configuration is detached, role-separated, and mandatory for current checks",async()=>{
  for(const c of [
    {...config,url:"https://cp.test"},
    {...config,pitr:{...config.pitr,token:config.token}},
    {...config,pitr:{...config.pitr,token:"short"}},
    {...config,pitr:{...config.pitr,binding:{...binding,run:"other"}}},
  ]) assert.throws(()=>client(()=>{throw Error("must not fetch");},c),{code:"invalid"});
  const ordinary=client(()=>{throw Error("must not fetch");},{url:config.url,token:config.token});
  await assert.rejects(ordinary.assertPitrCurrent(identity,signal()),{code:"invalid"});
  const b=structuredClone(binding),cfg={...config,pitr:{...config.pitr,binding:b}};
  const c=client(()=>Promise.resolve(Response.json(reply())),cfg);
  b.active=deleted;cfg.pitr.token="modified";
  assert.equal(await c.assertPitrCurrent(identity,signal()),undefined);
});

test("uses uncached POSTs and only the authority token, returns no reusable permit",async()=>{
  let calls=0;
  function fetchImpl(url,init){
    assert.equal(this,undefined);calls++;
    assert.equal(url,"https://connect-lab.mdbase.dev/internal/v1/next/lab-pitr/current");
    assert.equal(init.headers.authorization,`Bearer ${config.pitr.token}`);
    assert.equal(init.method,"POST");assert.equal(init.redirect,"manual");assert.equal(init.cache,"no-store");
    assert.deepEqual(JSON.parse(init.body),{run:PITR_RUN,...identity});
    return Promise.resolve(Response.json(reply()));
  }
  const c=client(fetchImpl);
  assert.equal(await c.assertPitrCurrent(identity,signal()),undefined);
  assert.equal(await c.assertPitrCurrent(identity,signal()),undefined);
  assert.equal(calls,2);
});

test("app-grant checks use a separate uncached exact principal, never a device identity",async()=>{
  let calls=0;
  const c=client(function(url,init){assert.equal(this,undefined);calls++;
    assert.equal(url,"https://connect-lab.mdbase.dev/internal/v1/next/lab-pitr/current-app-grant");
    assert.equal(init.headers.authorization,`Bearer ${config.pitr.token}`);assert.equal(init.cache,"no-store");
    assert.deepEqual(JSON.parse(init.body),{run:PITR_RUN,...grantIdentity});return Promise.resolve(Response.json(reply(grantIdentity)));
  });
  assert.equal(await c.assertPitrCurrentAppGrant(grantIdentity,signal()),undefined);
  await c.assertPitrCurrentAppGrant(grantIdentity,signal());assert.equal(calls,2);
  await assert.rejects(c.assertPitrCurrent(grantIdentity,signal()),{code:"invalid"});
  await assert.rejects(c.assertPitrCurrentAppGrant(identity,signal()),{code:"invalid"});assert.equal(calls,2);
});

test("app-grant invalid/nil/foreign/key identities reject before I/O",async()=>{
  let calls=0;const c=client(()=>{calls++;throw Error("must not fetch");});
  for(const i of [{...grantIdentity,collection:identity.device},{...grantIdentity,grant:"00000000-0000-0000-0000-000000000000"},
    {...grantIdentity,principal:"device"},{...grantIdentity,device:identity.device},{...grantIdentity,clientPublicKey:"00".repeat(32)},
    {...grantIdentity,clientPublicKey:"FF".repeat(32)}])await assert.rejects(c.assertPitrCurrentAppGrant(i,signal()),{code:"invalid"});
  const ordinary=client(()=>{calls++;throw Error("must not fetch");},{url:config.url,token:config.token});
  await assert.rejects(ordinary.assertPitrCurrentAppGrant(grantIdentity,signal()),{code:"invalid"});assert.equal(calls,0);
});

test("app-grant deny/stale/future/inexact echoes never establish authority",async()=>{
  for(const r of [null,{},reply(grantIdentity,0),reply(grantIdentity,1001),{...reply(grantIdentity),current:false},
    {...reply(grantIdentity),grant:identity.device},{...reply(grantIdentity),clientPublicKey:identity.signPublicKey},
    {...reply(grantIdentity),principal:"device"},{...reply(grantIdentity),extra:true},reply()]){
    const clock=()=>r?.checkedAt===0?5000:1000;
    await assert.rejects(client(()=>Promise.resolve(Response.json(r)),config,clock).assertPitrCurrentAppGrant(grantIdentity,signal()),{code:"unavailable"});
  }
  for(const status of [302,401,409,503]) await assert.rejects(client(()=>Promise.resolve(new Response(null,{status}))).assertPitrCurrentAppGrant(grantIdentity,signal()));
});

test("app-grant identity mutation and CP outage do not reuse a point observation",async()=>{
  const i={...grantIdentity},c=client(()=>{i.grant=identity.device;return Promise.resolve(Response.json(reply(grantIdentity)));});
  await assert.rejects(c.assertPitrCurrentAppGrant(i,signal()),{code:"unavailable"});
  let calls=0;const c2=client(()=>Promise.resolve(++calls===1?Response.json(reply(grantIdentity)):new Response(null,{status:503})));
  await c2.assertPitrCurrentAppGrant(grantIdentity,signal());await assert.rejects(c2.assertPitrCurrentAppGrant(grantIdentity,signal()),{code:"unavailable"});
});

test("app-grant current I/O retains fixed bytes/read-work/shared deadline",async t=>{
  await assert.rejects(client(()=>Promise.resolve(new Response("x".repeat(4097)))).assertPitrCurrentAppGrant(grantIdentity,signal()),{code:"invalid"});
  let reads=0,cancelled=false;const stream=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array());},cancel(){cancelled=true;}});
  await assert.rejects(client(()=>Promise.resolve(new Response(stream))).assertPitrCurrentAppGrant(grantIdentity,signal()),{code:"unavailable"});assert.ok(reads<=65);assert.equal(cancelled,true);
  t.mock.timers.enable({apis:["setTimeout"]});let resolve;
  const pending=client(()=>new Promise(r=>{resolve=r;})).assertPitrCurrentAppGrant(grantIdentity,signal());const refused=assert.rejects(pending,{code:"unavailable"});
  t.mock.timers.tick(5000);await refused;resolve(Response.json(reply(grantIdentity)));await turn();
});

test("CP pending-genesis uses separate exact original issuer/transport identity and no permit/cache",async()=>{
  let calls=0;const c=client((url,init)=>{calls++;assert.equal(url,"https://connect-lab.mdbase.dev/internal/v1/next/lab-pitr/current-cp-genesis");
    assert.equal(init.headers.authorization,`Bearer ${config.pitr.token}`);assert.equal(init.cache,"no-store");assert.equal(init.redirect,"manual");
    assert.deepEqual(JSON.parse(init.body),{run:PITR_RUN,...cpGenesisIdentity});return Promise.resolve(Response.json(reply(cpGenesisIdentity)));});
  assert.equal(await c.assertPitrCurrentCpGenesis(cpGenesisIdentity,signal()),undefined);await c.assertPitrCurrentCpGenesis(cpGenesisIdentity,signal());assert.equal(calls,2);
  for(const i of [identity,grantIdentity,{...cpGenesisIdentity,purpose:"nil"},{...cpGenesisIdentity,collection:"00000000-0000-0000-0000-000000000000"},
    {...cpGenesisIdentity,transportPublicKey:"00".repeat(32)},{...cpGenesisIdentity,device:identity.device},{...cpGenesisIdentity,issuerKeyId:"FF".repeat(16)}])await assert.rejects(c.assertPitrCurrentCpGenesis(i,signal()),{code:"invalid"});
  await assert.rejects(c.assertPitrCurrent(cpGenesisIdentity,signal()),{code:"invalid"});await assert.rejects(c.assertPitrCurrentAppGrant(cpGenesisIdentity,signal()),{code:"invalid"});assert.equal(calls,2);
});
test("CP pending-genesis rejects stale/inexact/failure/mutated replies",async()=>{
  for(const r of [reply(),reply(grantIdentity),reply(cpGenesisIdentity,1001),{...reply(cpGenesisIdentity),issuerKeyId:"09".repeat(16)},
    {...reply(cpGenesisIdentity),transportPublicKey:identity.signPublicKey},{...reply(cpGenesisIdentity),purpose:"nil"},{...reply(cpGenesisIdentity),extra:true}])
    await assert.rejects(client(()=>Promise.resolve(Response.json(r))).assertPitrCurrentCpGenesis(cpGenesisIdentity,signal()),{code:"unavailable"});
  const i={...cpGenesisIdentity};await assert.rejects(client(()=>{i.issuerKeyId="09".repeat(16);return Promise.resolve(Response.json(reply(cpGenesisIdentity)));}).assertPitrCurrentCpGenesis(i,signal()),{code:"unavailable"});
  await assert.rejects(client(()=>Promise.resolve(Response.json(reply(cpGenesisIdentity,0))),config,()=>5000).assertPitrCurrentCpGenesis(cpGenesisIdentity,signal()),{code:"unavailable"});
  let calls=0;const c=client(()=>Promise.resolve(++calls===1?Response.json(reply(cpGenesisIdentity)):new Response(null,{status:503})));
  await c.assertPitrCurrentCpGenesis(cpGenesisIdentity,signal());await assert.rejects(c.assertPitrCurrentCpGenesis(cpGenesisIdentity,signal()),{code:"unavailable"});
});
test("CP pending-genesis retains bytes/read/deadline bounds",async t=>{
  await assert.rejects(client(()=>Promise.resolve(new Response("x".repeat(4097)))).assertPitrCurrentCpGenesis(cpGenesisIdentity,signal()),{code:"invalid"});
  let reads=0;const stream=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array());}});
  await assert.rejects(client(()=>Promise.resolve(new Response(stream))).assertPitrCurrentCpGenesis(cpGenesisIdentity,signal()),{code:"unavailable"});assert.ok(reads<=65);
  t.mock.timers.enable({apis:["setTimeout"]});let resolve;const pending=client(()=>new Promise(r=>{resolve=r;})).assertPitrCurrentCpGenesis(cpGenesisIdentity,signal());
  const refused=assert.rejects(pending,{code:"unavailable"});t.mock.timers.tick(5000);await refused;resolve(Response.json(reply(cpGenesisIdentity)));await turn();
});

for(const [method,i,path] of cpCases){
  test(`${method} requires a distinct exact uncached CP purpose, no permit`,async()=>{
    let calls=0;const c=client((url,init)=>{calls++;assert.equal(url,`https://connect-lab.mdbase.dev/internal/v1/next/lab-pitr/${path}`);
      assert.equal(init.headers.authorization,`Bearer ${config.pitr.token}`);assert.equal(init.cache,"no-store");assert.equal(init.redirect,"manual");assert.deepEqual(JSON.parse(init.body),{run:PITR_RUN,...i});return Promise.resolve(Response.json(reply(i)));});
    assert.equal(await c[method](i,signal()),undefined);await c[method](i,signal());assert.equal(calls,2);
    for(const bad of [identity,grantIdentity,cpGenesisIdentity,...cpCases.filter(x=>x[0]!==method).map(x=>x[1]),null,{...i,extra:true},{...i,transportPublicKey:"00".repeat(32)},{...i,issuerKeyId:"FF".repeat(16)}])await assert.rejects(c[method](bad,signal()),{code:"invalid"});
    const ordinary=client(()=>{throw Error("must not fetch");},{url:config.url,token:config.token});await assert.rejects(ordinary[method](i,signal()),{code:"invalid"});assert.equal(calls,2);
    await assert.rejects(c.assertPitrCurrentCpGenesis(i,signal()),{code:"invalid"});await assert.rejects(c.assertPitrCurrentAppGrant(i,signal()),{code:"invalid"});await assert.rejects(c.assertPitrCurrent(i,signal()),{code:"invalid"});
  });
  test(`${method} rejects any changed echo/input, expiry and unavailable response`,async()=>{
    for(const [key,value] of Object.entries(i))await assert.rejects(client(()=>Promise.resolve(Response.json({...reply(i),[key]:typeof value==="string"?value+"0":null})))[method](i,signal()),{code:"unavailable"});
    for(const r of [null,{},reply(cpGenesisIdentity),reply(i,1001),{...reply(i),extra:true},{...reply(i),current:false},reply(i,0)])await assert.rejects(client(()=>Promise.resolve(Response.json(r)),config,()=>r?.checkedAt===0?5000:1000)[method](i,signal()),{code:"unavailable"});
    const changed={...i};await assert.rejects(client(()=>{changed.policyKeyId="ff".repeat(16);return Promise.resolve(Response.json(reply(i)));})[method](changed,signal()),{code:"unavailable"});
    let calls=0;const c=client(()=>Promise.resolve(++calls===1?Response.json(reply(i)):new Response(null,{status:503})));await c[method](i,signal());await assert.rejects(c[method](i,signal()),{code:"unavailable"});
  });
  test(`${method} retains byte/read/shared deadline bounds`,async t=>{
    await assert.rejects(client(()=>Promise.resolve(new Response("x".repeat(4097))))[method](i,signal()),{code:"invalid"});
    let reads=0,cancelled=false;const stream=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array());},cancel(){cancelled=true;}});
    await assert.rejects(client(()=>Promise.resolve(new Response(stream)))[method](i,signal()),{code:"unavailable"});assert.ok(reads<=65);assert.equal(cancelled,true);
    t.mock.timers.enable({apis:["setTimeout"]});let resolve;const pending=client(()=>new Promise(r=>{resolve=r;}))[method](i,signal());const refused=assert.rejects(pending,{code:"unavailable"});t.mock.timers.tick(5000);await refused;resolve(Response.json(reply(i)));await turn();
  });
}
test("CP collection/nil identity scopes and deletion tuples do not admit foreign or malformed subjects",async()=>{
  const c=client(()=>{throw Error("must not fetch");});
  await assert.rejects(c.assertPitrCurrentCpCollection({...cpCollectionIdentity,collection:identity.device},signal()),{code:"invalid"});
  for(const change of [{subject:identity.device},{collection:active},{genesisSha256:"bad"}])await assert.rejects(c.assertPitrCurrentCpNilPeek({...nilPeekIdentity,...change},signal()),{code:"invalid"});
  for(const change of [{collection:active},{activeGenesisSha256:"FF".repeat(32)},{deletedGenesisSha256:"bad"}])await assert.rejects(c.assertPitrCurrentCpNilRead({...nilReadIdentity,...change},signal()),{code:"invalid"});
  for(const change of [{subject:identity.device},{deletionId:nilReadIdentity.collection},{lifecycleEpoch:"0"},{lifecycleEpoch:"01"},{lifecycleEpoch:"18446744073709551616"}])await assert.rejects(c.assertPitrCurrentCpNilRecord({...nilRecordIdentity,...change},signal()),{code:"invalid"});
});

test("original app-runtime caller kind is not relabelled",async()=>{
  const i={...identity,kind:"app-runtime"};
  const c=client((_url,init)=>{assert.equal(JSON.parse(init.body).kind,"app-runtime");return Promise.resolve(Response.json(reply(i)));});
  await c.assertPitrCurrent(i,signal());
});

test("foreign/nil/inexact identities close before network",async()=>{
  let calls=0;const c=client(()=>{calls++;throw Error("must not fetch");});
  for(const i of [{...identity,collection:identity.device},{...identity,collection:"00000000-0000-0000-0000-000000000000"},
    {...identity,device:"00000000-0000-0000-0000-000000000000"},{...identity,kind:"app"},
    {...identity,current:true},{...identity,signPublicKey:"AA".repeat(32)},{...identity,policyKeyId:"x"}]){
    await assert.rejects(c.assertPitrCurrent(i,signal()),{code:"invalid"});
  }
  assert.equal(calls,0);
});

test("deny, unknown, stale, future, mismatched or partial CP observations never permit",async()=>{
  for(const r of [null,[],{},reply(identity,0),reply(identity,1001),reply(identity,1.5),
    {...reply(),current:false},{...reply(),current:"true"},{...reply(),run:"other"},
    {...reply(),device:deleted},{...reply(),kind:"cli"},{...reply(),genesisSha256:"ff".repeat(32)},
    {...reply(),policyKeyId:"ff".repeat(16)},{...reply(),extra:true},
    Object.fromEntries(Object.entries(reply()).filter(([k])=>k!=="checkedAt"))]){
    const clock=()=>r?.checkedAt===0?5000:1000;
    await assert.rejects(client(()=>Promise.resolve(Response.json(r)),config,clock).assertPitrCurrent(identity,signal()),{code:"unavailable"});
  }
});

test("redirects/refusals/unavailable statuses do not expose body or use cached success",async()=>{
  for(const status of [301,302,307,308,401,403,404,409,500,503]){
    let cancelled=0;
    const c=client(()=>Promise.resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{status})));
    await assert.rejects(c.assertPitrCurrent(identity,signal()));assert.equal(cancelled,1);
  }
  let n=0;const c=client(()=>Promise.resolve(++n===1?Response.json(reply()):new Response(null,{status:503})));
  await c.assertPitrCurrent(identity,signal());await assert.rejects(c.assertPitrCurrent(identity,signal()),{code:"unavailable"});
});

test("identity drift across fetch is closed, body was detached",async()=>{
  const i={...identity};let body;
  const c=client((_url,init)=>{body=JSON.parse(init.body);i.device=deleted;return Promise.resolve(Response.json(reply()));});
  await assert.rejects(c.assertPitrCurrent(i,signal()),{code:"unavailable"});assert.equal(body.device,identity.device);
});

test("bounds body bytes, strict UTF8, and read-work including EOF",async()=>{
  for(const body of ["x".repeat(4097),"not JSON",Uint8Array.of(0xff)]){
    await assert.rejects(client(()=>Promise.resolve(new Response(body))).assertPitrCurrent(identity,signal()),{code:"invalid"});
  }
  let pulls=0,cancelled=false;
  const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled=true;}});
  await assert.rejects(client(()=>Promise.resolve(new Response(stream))).assertPitrCurrent(identity,signal()),{code:"unavailable"});
  assert.equal(cancelled,true);assert.ok(pulls<=65,"at most one stream prefetch beyond64 reader calls");
});

test("deadline closes a stalled fetch and cancels its late body",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let resolve,transport,cancelled=false;
  const c=client((_url,init)=>{transport=init.signal;return new Promise(r=>{resolve=r;});});
  const pending=c.assertPitrCurrent(identity,signal());const refused=assert.rejects(pending,{code:"unavailable"});
  t.mock.timers.tick(5000);await refused;assert.equal(transport.aborted,true);
  resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})));await turn();assert.equal(cancelled,true);
});

test("deadline covers stalled reads and stalled cleanup",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let cancelled=false;
  const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}});
  const pending=client(()=>Promise.resolve(new Response(stream))).assertPitrCurrent(identity,signal());
  const refused=assert.rejects(pending,{code:"unavailable"});await turn();t.mock.timers.tick(5000);await refused;
  assert.equal(cancelled,true);
});

test("caller abort and network/stream exceptions use fixed diagnostics",async()=>{
  const privateMessage="Bearer private-token https://private.example/metadata";
  const a=new AbortController();a.abort(privateMessage);let fetched=false;
  await assert.rejects(client(()=>{fetched=true;throw Error(privateMessage);}).assertPitrCurrent(identity,a.signal),{code:"unavailable",message:"control plane unreachable (caller_aborted)"});
  assert.equal(fetched,false);
  await assert.rejects(client(()=>{throw Error(privateMessage);}).assertPitrCurrent(identity,signal()),{code:"unavailable",message:"control plane unreachable (network)"});
  const stream=new ReadableStream({pull(c){c.error(Error(privateMessage));}});
  await assert.rejects(client(()=>Promise.resolve(new Response(stream))).assertPitrCurrent(identity,signal()),{code:"unavailable",message:"control plane response unavailable"});
});
