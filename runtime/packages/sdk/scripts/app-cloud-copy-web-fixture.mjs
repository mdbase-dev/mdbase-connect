/** LOCAL TEST composition carrier. Actual browser custody/OPFS/host/CP/native
 * LS; identity/credential/release/service-generation fixtures and same-origin
 * loopback proxy are NOT production auth, BUILD release or deployed CORS proof. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
export async function runCloudCopyWebFixture({
  artifact,
  cpOrigin,
  logOrigin,
  trust,
  collection,
  actors,
  playwrightModule,
  sqliteWasmDist,
  installationSignIn = false,
}) {
  if (!playwrightModule || !sqliteWasmDist || actors.length !== (installationSignIn ? 1 : 2))
    throw Error("explicit owned browser fixture actors required");
  const pw = await import(pathToFileURL(playwrightModule).href),
    out = resolve("target/cloud-copy-web-fixture"),
    profile = resolve(out, `profile-${process.pid}`);
  await mkdir(out, { recursive: true });
  const helperSource = `export {AppWebCloudCopyHost} from './packages/sdk/src/app-host/cloud-copy-host.ts';export {AppProtectedInstallationSignIn} from './packages/sdk/src/app-host/installation-sign-in.ts';export {AppWasmRuntime} from './packages/sdk/src/app-host/wasm-runtime.ts';export {openOwnedAppWorker,appInstallationLockName,appReplicaLockName} from './packages/sdk/src/app-host/owner.ts';export {appLocalConnector} from './packages/sdk/src/app-host/local-facade.ts';export {MdbaseClient} from './packages/sdk/src/client.ts';export {AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex} from './packages/obsidian-runtime/src/index/appSqliteIndex.ts';`;
  const helpers = (
    await build({
      stdin: {
        contents: helperSource,
        resolveDir: process.cwd(),
        sourcefile: "cloud-copy-web-helpers.ts",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
    })
  ).outputFiles[0].contents;
  const wasm = await readFile(resolve(artifact)),
    assets = new Map([
      ["/helpers.js", ["text/javascript", helpers]],
      ["/app.wasm", ["application/wasm", wasm]],
    ]);
  const sqlite = pathToFileURL(resolve(sqliteWasmDist) + "/");
  for (const name of [
    "index.mjs",
    "sqlite3.wasm",
    "sqlite3-opfs-async-proxy.js",
  ])
    assets.set(`/sqlite/${name}`, [
      name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      await readFile(new URL(name, sqlite)),
    ]);
  const worker = `
import init from '/sqlite/index.mjs';
import {AppWebCloudCopyHost,AppProtectedInstallationSignIn,AppWasmRuntime,AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex} from '/helpers.js';
let host,flow,ctrl,fixture,release,request,httpCalls=0,nativeOpens=0,current=false,initialized=false,state,sqlTurns=0,stage='idle';
const nativeOpen=AppWasmRuntime.prototype.openDeviceConsuming;AppWasmRuntime.prototype.openDeviceConsuming=function(options){nativeOpens++;return nativeOpen.call(this,options);};
const setup=async offline=>{fixture=await(await fetch('/fixture.json')).json();release={...fixture.trust,trustedRoots:fixture.trust.trustedRoots.map(v=>Uint8Array.from(v)),policyPins:Uint8Array.from(fixture.trust.policyPins)};
 request=(url,opts)=>{httpCalls++;if(offline)throw Error('owned offline network fixture');const u=new URL(url),prefix=u.origin===fixture.trust.cpOrigin?'/proxy/cp':u.origin===fixture.trust.logOrigin?'/proxy/log':null;if(!prefix||fixture.installationSignIn&&u.pathname==='/v1/next/devices')throw Error('owned fixture target/registration refused');return fetch(prefix+u.pathname+u.search,opts);};};
const rpc=async m=>{
 if(m.op==='stop'){current=false;ctrl?.abort();await host?.close();await flow?.close();return true;}
 if(m.op==='sign-in'){
  if(ctrl||initialized)throw Error('duplicate sign-in');stage='selected-account';ctrl=new AbortController();current=true;await setup(m.offline);
  flow=await AppProtectedInstallationSignIn.open({origin:location.origin,cpOrigin:fixture.trust.cpOrigin,appId:'tasknotes-web',environment:'lab',mode:m.mode,signal:ctrl.signal,locks:navigator.locks,fetch:request});await flow.start();await flow.exchange();return flow.view();
 }
 if(m.op==='confirm-account'){return flow.confirmSelectedAccount(m.account);}
 if(m.op==='fence'){current=false;return true;}
 if(m.op==='attach'){host.attachDataFacade(m.port);return true;}
 if(m.op==='inspect'){const rows=state.index.run({mode:'Autocommit',stmts:[{sql:'SELECT k FROM st_meta',params:[]}]})[0].values;return{sqlTurns,keyringPersisted:rows.some(v=>typeof v.value==='string'&&/keyring/i.test(v.value))};}
 if(m.op!=='init'||initialized||m.owned!==true)throw Error('owned web initialization refused');
 initialized=true;current=true;if(!ctrl){ctrl=new AbortController();await setup(m.offline);}const signal=ctrl.signal,actor=fixture.actors[m.actor],scope=m.scope;
 const session={accountId:scope.account,connectorId:actor.connectorId,deviceId:actor.deviceId,installationId:scope.installation,kind:'app-runtime',cpOrigin:fixture.trust.cpOrigin,logOrigin:fixture.trust.logOrigin,approvalMode:'password-ak1',isCurrent:()=>current,connectorBearer:async({signal})=>{if(signal.aborted||!current)throw Error('owned auth fixture fenced');return actor.bearer;}};
 const installation={scope:Object.freeze({account:scope.account,installation:scope.installation}),isCurrent:()=>current};
 const loadRuntime=async({signal})=>new Uint8Array(await(await fetch('/app.wasm',{signal,credentials:'omit',redirect:'error'})).arrayBuffer());
 stage='original-device';if(fixture.installationSignIn){
  host=await AppWebCloudCopyHost.openInstallationDevice({signIn:flow,installation,release,origin:location.origin,signal,loadRuntime,allowLoopbackHttp:true});
  if(flow.view().state!=='paired'){stage='attest';await host.attestInstallation();await flow.exchange();await host.completeInstallationSignIn();}
 }else host=await AppWebCloudCopyHost.openOriginalDevice({session,installation,release,origin:location.origin,mode:m.mode,signal,fetch:request,allowLoopbackHttp:true,loadRuntime});
 if(nativeOpens!==1)throw Error('second native device open');
 const deviceHttpCalls=httpCalls;stage='bootstrap';const metadata=await host.bootstrapCloudCopy({scope,collectionCurrent:()=>current,purpose:'join',outcomeMode:m.mode,signal,fetch:request,allowLoopbackHttp:true});const bootstrapHttpCalls=httpCalls-deviceHttpCalls;if(m.mode==='existing'&&(deviceHttpCalls!==0||bootstrapHttpCalls!==0))throw Error('owned warm credential/bootstrap replay');
 stage='sqlite';await host.openCollectionSql({signal,replicaId:actor.replicaId,endpoint:37,openSql:async({scope,signal})=>{
  if(signal.aborted||!current)throw Error('owned SQL scope fenced');const sqlite=await init({print:()=>{},printErr:()=>{}});state=await openAppSahpoolIndex(sqlite,scope);
  const run=state.index.run.bind(state.index);state.index.run=(...args)=>{sqlTurns++;return run(...args);};
  const bridge=new AppBinaryIndexHost(state.index),sql={import:x=>appSqlHost(bridge,x),fence:()=>bridge.fence(),get needsRecovery(){return bridge.needsRecovery;}},v=sqlite.version.libVersion.split('.').map(Number),opened=state.index.info.opened;
  return{sql,opened:opened==='Fresh'?'fresh':opened==='Unclean'?'unclean':'existing',sqliteVersion:v[0]*1000000+v[1]*1000+v[2],close:async()=>{state.index.close();await state.pool.pauseVfs();}};
 }});
 if(!m.offline){stage='log';await host.startCollectionLog({signal,fetch:request,allowLoopbackHttp:true});}
 stage='verified-read';await host.waitForVerifiedRead({signal});
 const receipt=host.registeredReceipt();if(nativeOpens!==1)throw Error('native reopened during collection continuation');return{nativeOpens,opened:state.index.info.opened,durability:state.index.info.durability,sqlTurns,deviceHttpCalls,bootstrapHttpCalls,expectedGenesis:metadata.expectedGenesis,originalPublic:[...receipt.signPublicKey,...receipt.kemPublicKey,...receipt.noisePublicKey]};
};
onmessage=async({data:m})=>{try{postMessage({id:m.id,value:await rpc(m)});}catch{postMessage({id:m.id,error:true,stage});}};
`;
  assets.set("/worker.js", ["text/javascript", worker]);
  const main = `
import {openOwnedAppWorker,appInstallationLockName,appReplicaLockName,appLocalConnector,MdbaseClient} from '/helpers.js';
window.runWebHost=async(scope,data)=>{let raw,id=0,client,connector,result;const rpc=(op,extra={},transfer=[])=>new Promise((yes,no)=>{const rid=++id,t=setTimeout(()=>no(Error('owned web RPC timeout '+op)),25000),on=({data})=>{if(data.id!==rid)return;clearTimeout(t);raw.removeEventListener('message',on);if(data.error)window.lastWebStage=data.stage;data.error?no(Error('owned web fixture failed '+data.stage)):yes(data.value);};raw.addEventListener('message',on);raw.postMessage({id:rid,op,...extra},transfer);});
 const fixture=await(await fetch('/fixture.json')).json();
 if(fixture.installationSignIn){raw=new Worker('/worker.js',{type:'module'});const selected=await rpc('sign-in',data);if(selected.accountId!==scope.account)throw Error('foreign selected account');await rpc('confirm-account',{account:selected.accountId});scope={account:selected.accountId,installation:selected.installationId,collection:scope.collection};}
 const owner=await openOwnedAppWorker({locks:navigator.locks,scope,create:()=>{raw??=new Worker('/worker.js',{type:'module'});return{stop:()=>rpc('stop'),terminate:()=>raw.terminate()};},initialize:async(_w,_signal,s,authority)=>{const held=(await navigator.locks.query()).held;if(!authority.isCurrent()||![appInstallationLockName(s),appReplicaLockName(s)].every(n=>held.some(l=>l.name===n)))throw Error('owned web locks missing');result=await rpc('init',{...data,scope:s,owned:authority.isCurrent()});},closeTimeoutMs:1500});
 try{const channel=new MessageChannel();await rpc('attach',{port:channel.port1},[channel.port1]);connector=appLocalConnector(channel.port2,{...scope,isCurrent:()=>true});client=await MdbaseClient.connect({app:{name:'owned-web-fixture',version:'1'},connector,reconnect:false});const records=await client.query({limit:1},undefined,AbortSignal.timeout(5000)),description=await client.describe(AbortSignal.timeout(5000)),inspected=await rpc('inspect');if(!Array.isArray(description.contracts)||inspected.keyringPersisted||inspected.sqlTurns===0)throw Error('owned web read assertions failed');await rpc('fence');let refused=false;try{await client.query({limit:1},undefined,AbortSignal.timeout(5000));}catch{refused=true;}if(!refused)throw Error('owned late-fenced read admitted');return{...result,sqlTurns:inspected.sqlTurns,typedQuery:true,strictDescribe:true,contracts:description.contracts.length,lateFenceRefused:true};}finally{client?.close();connector?.close();await owner.close();if((await navigator.locks.query()).held.length)throw Error('owned web locks retained');}
};
`;
  assets.set("/main.js", ["text/javascript", main]);
  // TEST same-origin loopback proxy forwards exact authenticated requests to real
  // services. Deliberately NOT a deployed cross-origin/CORS acceptance shortcut.
  let origin;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("cross-origin-opener-policy", "same-origin");
      res.setHeader("cross-origin-embedder-policy", "require-corp");
      const asset = assets.get(req.url);
      if (asset) {
        res.setHeader("content-type", asset[0]);
        res.end(asset[1]);
        return;
      }
      if (req.url === "/fixture.json") {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(
          JSON.stringify({
            actors,
            installationSignIn,
            trust: {
              ...trust,
              trustedRoots: trust.trustedRoots.map((v) => Array.from(v)),
              policyPins: Array.from(trust.policyPins),
            },
          }),
        );
        return;
      }
      if (
        req.url?.startsWith("/proxy/cp/v1/") ||
        req.url?.startsWith("/proxy/log/v1/")
      ) {
        const cp = req.url.startsWith("/proxy/cp/");
        const target = cp ? cpOrigin : logOrigin,
          path = req.url.slice(cp ? 9 : 10);
        let size = 0;
        const chunks = [];
        for await (const part of req) {
          size += part.length;
          if (size > 17 * 1024 * 1024) throw Error("owned proxy request bound");
          chunks.push(part);
        }
        const headers = {};
        for (const k of [
          "authorization",
          "content-type",
          "accept",
          "range",
          "x-mdbase-nonce",
          "x-mdbase-sig",
          "origin",
        ])
          if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
        const reply = await fetch(`${target}${path}`, {
          method: req.method,
          headers,
          ...(!["GET", "HEAD"].includes(req.method)
            ? { body: Buffer.concat(chunks) }
            : {}),
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(15000),
        });
        if (!reply.body) throw Error("owned proxy missing response");
        const reader = reply.body.getReader(),
          parts = [];
        let count = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            count += value.length;
            if (count > 17 * 1024 * 1024)
              throw Error("owned proxy response bound");
            parts.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const body = Buffer.concat(parts, count);
        res.statusCode = reply.status;
        for (const k of ["content-type", "content-range", "etag"])
          if (reply.headers.has(k)) res.setHeader(k, reply.headers.get(k));
        res.end(body);
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        '<!doctype html><title>Owned cloud-copy web fixture</title><script type="module" src="/main.js"></script>',
      );
    } catch {
      res.statusCode = 502;
      res.end("owned fixture proxy unavailable");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  origin = installationSignIn ? trust.cpOrigin : localOrigin;
  const scopes = actors.map((a) => ({
    account: a.accountId,
    installation: a.installationId,
    collection,
  }));
  async function run(context, actor, mode, offline = false) {
    if (installationSignIn) await context.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({url: `${localOrigin}${url.pathname}${url.search}`});
      await route.fulfill({response});
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.runWebHost === "function");
    try {
      return await page.evaluate(
        ({ scope, data }) => window.runWebHost(scope, data),
        { scope: scopes[actor], data: { actor, mode, offline } },
      );
    } catch {
      throw Error(
        "owned web initialization failed at " +
          (await page.evaluate(() => window.lastWebStage ?? "worker-load")),
      );
    } finally {
      await page.close();
    }
  }
  let context;
  try {
    context = await pw.chromium.launchPersistentContext(profile, {
      headless: true,
    });
    const cold = [];
    for (let i = 0; i < actors.length; i++) cold.push(await run(context, i, "fresh"));
    await context.close();
    context = null;
    context = await pw.chromium.launchPersistentContext(profile, {
      headless: true,
    });
    const warm = [];
    for (let i = 0; i < actors.length; i++) warm.push(await run(context, i, "existing"));
    for (let i = 0; i < actors.length; i++) {
      assert.deepEqual(warm[i].originalPublic, cold[i].originalPublic);
      assert.equal(warm[i].expectedGenesis, cold[i].expectedGenesis);
    }
    const offline = await run(context, 0, "existing", true);
    assert.deepEqual(offline.originalPublic, cold[0].originalPublic);
    assert(offline.typedQuery && offline.strictDescribe);
    const result = {
      browser: context.browser()?.version(),
      actualHostClass: true,
      actualWorkerTwoLocks: true,
      actualBrowserProviderCustodyOutcomes: true,
      actualOpfsDisposableSql: true,
      actualCpDeviceRegistrationCloudJoin: !installationSignIn,
      actualProtectedInstallationSignInCloudJoin: installationSignIn,
      sameNativeDeviceIntoCollection: cold.every(v => v.nativeOpens === 1) && warm.every(v => v.nativeOpens === 1),
      actualNativeLs: true,
      actualNativeReadGateAndDataFacade: true,
      sameOriginalTupleAfterBrowserRestart: true,
      sameProtectedCompletionBeforeHttp: true,
      warmOfflineTypedRead: true,
      strictEmptyDescribe: true,
      lateFacadeFenceRefused: true,
      zeroLocksAfterTermination: true,
      actors: actors.length,
      sqlTurns: {
        cold: cold.map((v) => v.sqlTurns),
        warm: warm.map((v) => v.sqlTurns),
        offline: offline.sqlTurns,
      },
      identityAndCredentialSelectionIsTestFixture: !installationSignIn,
      seededAccountSessionAndPortalActionsAreFixtures: installationSignIn,
      releaseAndGenerationAreTestFixtures: true,
      loopbackProxyNotDeployedCors: true,
      productionAuthenticatedProducer: false,
      productionRelease: false,
      populatedTaskCatalog: false,
      taskSaved: false,
      physicalDurability: false,
      labAccess: false,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await context?.close();
    await new Promise((r) => server.close(r));
    await rm(profile, {recursive: true, force: true});
  }
}
