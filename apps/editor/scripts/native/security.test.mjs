import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { parse } from 'yaml';
import { assertProtocolArchive, productionPin } from './originals.mjs';
import { assertEntryAsset, smoke } from './smoke.mjs';
import { verifyProvenanceBundle } from '../../../../scripts/continuous-sdk-release.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const source='abcdef123456'+'0'.repeat(28);

it('passes identity policy in the DSSE second argument and refuses a wrong certificate identity',async()=>{
 const identity='https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-sdk-npm.yml@refs/heads/main';
 // Model sigstore's overloaded API: a third argument is discarded for DSSE.
 const verify=async(bundle,options)=>{
  if(options?.certificateIdentityURI && bundle.identity!==options.certificateIdentityURI)throw Error('certificate identity refused');
  assert.equal(options.certificateIssuer,'https://token.actions.githubusercontent.com');
  assert.equal(options.tlogThreshold,1);assert.equal(options.ctLogThreshold,1);
 };
 await verifyProvenanceBundle({identity},{identity},verify);
 await assert.rejects(verifyProvenanceBundle({identity:'https://github.com/other/repository/.github/workflows/publish.yml@refs/heads/main'},{identity},verify),/identity refused/);
 const auth=await readFile(root+'apps/editor/scripts/native/authentication.mjs','utf8');
 assert.match(auth,/prove=provenSource/,'Editor must use the same corrected live SDK verifier');
});
it('cryptographically refuses a real public npm bundle when its certificate identity differs from policy',{timeout:120000},async()=>{
 const {pin}=await productionPin(root);
 const response=await fetch(pin.publication.attestations,{signal:AbortSignal.timeout(30000),redirect:'error'});
 assert.equal(response.ok,true);
 const proofs=(await response.json()).attestations.filter(a=>a.predicateType==='https://slsa.dev/provenance/v1');
 assert.equal(proofs.length,1);
 const identity=`https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-sdk-npm.yml@${pin.publication.ref}`;
 await verifyProvenanceBundle(proofs[0].bundle,{identity});
 await assert.rejects(verifyProvenanceBundle(proofs[0].bundle,{identity:'https://github.com/other/repo/.github/workflows/publish.yml@refs/heads/main'}),
  error=>error.code==='UNTRUSTED_SIGNER_ERROR');
});
it('refuses any direct protocol bytes that differ from the SDK authenticated bundled archive',async()=>{
 const {pin,bytes}=await productionPin(root);
 const pkg=JSON.parse(await readFile(root+'apps/editor/package.json','utf8'));
 const protocol=await readFile(root+'apps/editor/'+pkg.dependencies['@mdbase-dev/connect-protocol'].slice(5));
 assertProtocolArchive(pin,bytes,protocol);
 assert.throws(()=>assertProtocolArchive(pin,bytes,Buffer.from('different archive')),/byte-identical/);
 assert.throws(()=>assertProtocolArchive({...pin,bundledDependencies:pin.bundledDependencies.map(d=>({...d,sha256:'0'.repeat(64)}))},bytes,protocol),/metadata mismatch/);
});
it('protected jobs only execute workflow-owned helpers, with ancestry checks before candidate data and upload',async()=>{
 const {jobs}=parse(await readFile(root+'.github/workflows/editor-pages.yml','utf8'));
 for(const name of ['native-inputs','native-deploy','production-recovery']) {
  const job=jobs[name],checkout=job.steps.filter(s=>s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout[0].with.ref,'${{ github.sha }}');
  const ancestry=job.steps.findIndex(s=>s.run?.includes('refs.mjs'));
  if(name!=='production-recovery')assert.ok(ancestry>0);
  for(const step of job.steps) {
   assert.notEqual(step['working-directory'],'candidate');
   assert.doesNotMatch(step.run??'',/(?:node|bash|source|import|cd)\s+[^\n]*candidate/);
  }
  assert.notEqual(job.defaults?.run?.['working-directory'],'candidate');
  const candidate=job.steps.findIndex(s=>s.with?.path==='candidate');
  if(candidate>=0)assert.ok(ancestry<candidate);
 }
 const deploy=jobs['native-deploy'],upload=deploy.steps.find(s=>s.id==='upload');
 assert.match(upload.run,/refs\.mjs/);
 assert.equal(upload['timeout-minutes'],7);
 assert.ok(deploy.steps.every(step=>step['timeout-minutes']>0),'all protected preparation and publication steps have independent bounds');
 assert.ok(deploy.steps.reduce((sum,step)=>sum+step['timeout-minutes'],0)<deploy['timeout-minutes'],'job deadline must outlive every step bound, including recovery and receipts');
 for(const step of deploy.steps.filter(s=>s.id==='deployment')) {
  assert.match(step.if,/always\(\)/);
  assert.match(step.if,/upload.outcome == 'failure'/);assert.match(step.if,/upload.outcome == 'cancelled'/);
 }
 assert.doesNotMatch(JSON.stringify(deploy),/rollback\.mjs recover/);
 assert.equal(deploy.steps[0].run,'test "$GITHUB_RUN_ATTEMPT" = 1');
 const point=deploy.steps.findIndex(s=>s.with?.name?.startsWith('editor-production-recovery-point-'));
 assert.ok(point>=0 && point<deploy.steps.indexOf(upload),'recovery point is stored before upload');
 const smokeJob=jobs['production-smoke'];
 assert.equal(smokeJob.environment,undefined);
 assert.doesNotMatch(JSON.stringify(smokeJob),/secrets\./);
 assert.ok(smokeJob.steps.filter(s=>s.uses?.startsWith('actions/checkout@')).every(s=>s.with.ref==='${{ github.sha }}'));
 assert.equal(smokeJob.needs,'native-deploy');
 const recovery=jobs['production-recovery'];
 assert.match(recovery.if,/^always\(\)/);
 assert.match(recovery.if,/native-deploy.result != 'skipped'/);
 assert.match(recovery.if,/production-smoke.result != 'success'/);
 assert.doesNotMatch(recovery.if,/native-deploy.result == 'success'/);
 assert.equal(recovery.steps.find(s=>s.run?.includes('rollback.mjs')).run.match(/rollback\.mjs (\w+)/)[1],'recover');
});
function browserDouble({pageError=false,fence=false,csp=false,entrySource=source,missingSignIn=false}={}) {
 const listeners={},events=[];
 const page={on:(event,fn)=>{listeners[event]=fn;},
  goto:async(url,options)=>{
   events.push(url);assert.equal(options.waitUntil,'networkidle');
   if(pageError)listeners.pageerror(Error('private error never retained'));
   if(fence)listeners.console({text:()=> 'readiness_fenced'});
   if(csp)listeners.console({text:()=>"Loading https://static.cloudflareinsights.com/beacon.min.js violates Content Security Policy"});
   return {status:()=>200};
  },
  locator:selector=>selector==='body'?{innerText:async()=>''}:{evaluateAll:async()=>[`https://editor.mdbase.dev/assets/index-a1-${entrySource.slice(0,12)}.js`]},
  getByRole:(role,options)=>{assert.equal(role,'button');assert.equal(options.name,'Sign in');return {waitFor:async()=>{if(missingSignIn)throw Error('not visible');}};}
 };
 const context={newPage:async()=>page,newCDPSession:async()=>({send:async(method,args)=>{events.push(method);if(method.endsWith('setCacheDisabled'))assert.equal(args.cacheDisabled,true);}}),
  request:{get:async()=>({ok:()=>true,body:async()=>Buffer.from('entry')})}};
 return {events,chromium:{launch:async()=>({newContext:async options=>{assert.equal(options.serviceWorkers,'block');assert.match(options.extraHTTPHeaders['Cache-Control'],/no-store/);return context;},close:async()=>events.push('closed')})}};
}
it('smoke checks a fresh source-bound entry and sign-in, ignores beacon CSP console noise, but refuses page errors and fences',async()=>{
 const good=browserDouble({csp:true});
 assert.equal((await smoke(good.chromium,source)).ok,true);
 assert.ok(good.events.includes('Network.setCacheDisabled'));assert.ok(good.events.includes('closed'));
 assert.throws(()=>assertEntryAsset('https://editor.mdbase.dev/assets/index-other.js',source),/source-mismatch/);
 for(const options of [{pageError:true},{fence:true},{missingSignIn:true},{entrySource:'1'.repeat(40)}]) {
  const bad=browserDouble(options);
  await assert.rejects(smoke(bad.chromium,source));assert.ok(bad.events.includes('closed'));
 }
});
