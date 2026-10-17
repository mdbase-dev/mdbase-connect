// OFFLINE fixtures only: CLI shape/crypto validation does not authenticate a release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReleaseBundle } from './release-components.mjs';
import { buildTrustBundle } from './release-trust-bundle.mjs';
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')}}`:JSON.stringify(value);
const root=path.resolve(import.meta.dirname,'../..');
const runner=path.join(root,'services/server/node_modules/.bin/tsx');
const assetPath=path.join(root,'config/next-trust/lab.json');
const asset=JSON.parse(readFileSync(assetPath));
function invoke(script,args,env={}){return spawnSync(runner,[path.join(root,'scripts',script),...args],{cwd:root,encoding:'utf8',env:{...process.env,...env}});}
test('committed staging asset has independent beta.130 context and real certified pins (offline, NOT publication authentication)',()=>{
 const stagingPath=path.join(root,'config/next-trust/staging.json');
 const staging=JSON.parse(readFileSync(stagingPath));
 const commit='215c23a487f9a5ce931b732cf49ab2e5f8a3da7d',version='0.1.0-beta.130';
 assert.equal(staging.environment,'staging');
 assert.equal(staging.control_plane_origin,'https://connect-staging.mdbase.dev');
 assert.equal(staging.log_origin,'https://log-staging.mdbase.dev');
 assert.deepEqual(staging.source,{repository:'mdbase-dev/mdbase-connect',commit,version});
 assert.deepEqual(staging.roots.map(r=>r.key_id),['ed034ffa359b2e6086fdb05fb6bab2de']);
 assert.deepEqual(staging.policy_keys.map(p=>p.key_id),['6d730f62b69b214537485aa70016d116']);
 assert.notEqual(staging.roots[0].public_key,asset.roots[0].public_key);
 const dir=mkdtempSync(path.join(tmpdir(),'trust-staging-asset-'));
 try {
  // Synthetic image/run metadata ONLY to exercise the publisher's reference
  // encoder/validator. These are not a real inventory, signature or authority.
  const contract=JSON.parse(readFileSync(path.join(root,'config/release-components.json')));
  const records=contract.components.map((c,i)=>({component:c.id,commit,image:c.image+'@sha256:'+String(i+1).repeat(64)}));
  const release=buildReleaseBundle(contract,records,{commit,version,mdbaseRsRevision:'b'.repeat(40),qualificationRunId:10,qualificationRunAttempt:1,publicationRunId:11,publicationRunAttempt:1});
  const input=path.join(dir,'image.json'),output=path.join(dir,'output');writeFileSync(input,JSON.stringify(release));
  const built=invoke('build-release-trust-bundle.mts',[input,output,'staging'],{SOURCE_COMMIT:commit,GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',PUBLISHER_QUALIFICATION_RUN_ID:'13',PUBLISHER_QUALIFICATION_RUN_ATTEMPT:'1'});
  assert.equal(built.status,0,built.stderr);
  const copied=path.join(output,'next-trust/staging.json');assert.deepEqual(readFileSync(copied),readFileSync(stagingPath));
  const args=[path.join(output,'release-trust-bundle.json'),copied,commit,version,'staging','https://connect-staging.mdbase.dev','https://log-staging.mdbase.dev'];
  const checked=invoke('verify-release-trust-asset.mts',args);assert.equal(checked.status,0,checked.stderr);
  for(const [position,value] of [[2,'d'.repeat(40)],[3,'0.1.0-beta.129'],[4,'production'],[5,'https://connect.mdbase.dev']]){
   const bad=[...args];bad[position]=value;assert.notEqual(invoke('verify-release-trust-asset.mts',bad).status,0);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('reference CLI preserves exact LAB bytes and refuses wrong externally supplied context/tamper', async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'trust-cli-test-'));
 try {
  const contract=JSON.parse(readFileSync(path.join(root,'config/release-components.json')));
  const records=contract.components.map((c,i)=>({component:c.id,commit:asset.source.commit,image:c.image+'@sha256:'+String(i+1).repeat(64)}));
  const release=buildReleaseBundle(contract,records,{commit:asset.source.commit,version:asset.source.version,mdbaseRsRevision:'b'.repeat(40),qualificationRunId:10,qualificationRunAttempt:1,publicationRunId:11,publicationRunAttempt:1});
  const input=path.join(dir,'image.json'),output=path.join(dir,'output');writeFileSync(input,JSON.stringify(release));
  const built=invoke('build-release-trust-bundle.mts',[input,output,'lab'],{SOURCE_COMMIT:asset.source.commit,GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',PUBLISHER_QUALIFICATION_RUN_ID:'13',PUBLISHER_QUALIFICATION_RUN_ATTEMPT:'1'});
  assert.equal(built.status,0,built.stderr);
  const sandbox=path.join(dir,'sandbox');mkdirSync(path.join(sandbox,'scripts'),{recursive:true});
  mkdirSync(path.join(sandbox,'config/next-trust'),{recursive:true});
  copyFileSync(path.join(root,'scripts/build-release-trust-bundle.mts'),path.join(sandbox,'scripts/build-release-trust-bundle.mts'));
  copyFileSync(path.join(root,'config/release-components.json'),path.join(sandbox,'config/release-components.json'));
  symlinkSync(path.join(root,'services'),path.join(sandbox,'services'));
  symlinkSync(path.join(root,'scripts/lib'),path.join(sandbox,'scripts/lib'));
  const missing=path.join(dir,'missing-stage-output');
  const invokeSandbox=environment=>spawnSync(runner,[path.join(sandbox,'scripts/build-release-trust-bundle.mts'),input,missing,environment],{cwd:root,encoding:'utf8',env:{...process.env,SOURCE_COMMIT:asset.source.commit,GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',PUBLISHER_QUALIFICATION_RUN_ID:'13',PUBLISHER_QUALIFICATION_RUN_ATTEMPT:'1'}});
  assert.notEqual(invokeSandbox('staging').status,0);assert.equal(existsSync(missing),false);
  copyFileSync(assetPath,path.join(sandbox,'config/next-trust/staging.json'));
  assert.notEqual(invokeSandbox('staging').status,0);assert.equal(existsSync(missing),false); // LAB relabel refused
  for(const environment of ['production','../lab',''])assert.notEqual(invokeSandbox(environment).status,0);
  const repeat=invoke('build-release-trust-bundle.mts',[input,output,'lab'],{SOURCE_COMMIT:asset.source.commit,GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',PUBLISHER_QUALIFICATION_RUN_ID:'13',PUBLISHER_QUALIFICATION_RUN_ATTEMPT:'1'});
  assert.notEqual(repeat.status,0); // create-only output, no replacement
  const manifest=path.join(output,'release-trust-bundle.json'),payload=path.join(output,'next-trust/lab.json');
  assert.deepEqual(readFileSync(payload),readFileSync(assetPath));
  const args=[manifest,payload,asset.source.commit,asset.source.version,'lab',asset.control_plane_origin,asset.log_origin];
  assert.equal(invoke('verify-release-trust-asset.mts',args).status,0);
  for(const [position,value] of [[2,'d'.repeat(40)],[3,'0.1.0-beta.999'],[4,'production'],[5,'https://wrong.example'],[6,'https://wrong.example']]){
   const bad=[...args];bad[position]=value;assert.notEqual(invoke('verify-release-trust-asset.mts',bad).status,0);
  }
  writeFileSync(payload,readFileSync(payload).toString()+' ');assert.notEqual(invoke('verify-release-trust-asset.mts',args).status,0);
  for (const environment of ['staging', 'production']) {
  const cpOrigin = environment === 'production' ? 'https://connect.mdbase.dev' : 'https://stage.example';
  // OFFLINE structure/certificate test only. Reusing public LAB fixture pins here
  // creates no staging authority; the real manifest must be independently signed.
  const stageBytes=Buffer.from(canonical({...asset,environment,control_plane_origin:cpOrigin}));
  writeFileSync(path.join(sandbox,`config/next-trust/${environment}.json`),stageBytes);
  rmSync(missing,{recursive:true,force:true});
  const stageBuilt=invokeSandbox(environment);assert.equal(stageBuilt.status,0,stageBuilt.stderr);
  assert.deepEqual(readFileSync(path.join(missing,`next-trust/${environment}.json`)),stageBytes);
  const builtStageInventory=JSON.parse(readFileSync(path.join(missing,'release-trust-bundle.json')));
  assert.equal(builtStageInventory.trustAssets[0].path,`next-trust/${environment}.json`);
  assert.equal(builtStageInventory.trustAssets[0].environment,environment);
  const stageManifest=buildTrustBundle({imageBundleBytes:Buffer.from(JSON.stringify(release)),assetBytes:stageBytes,
   publication:{workflow:'publish-images.yml',runId:12,runAttempt:1,publisherCommit:'c'.repeat(40)},
   qualification:{workflow:'server-ci.yml',runId:13,runAttempt:1}});
  const stagePayload=path.join(dir,'staging.json'),stageInventory=path.join(dir,'staging-manifest.json');
  writeFileSync(stagePayload,stageBytes);writeFileSync(stageInventory,JSON.stringify(stageManifest));
  const stageArgs=[stageInventory,stagePayload,asset.source.commit,asset.source.version,environment,cpOrigin,asset.log_origin];
  assert.equal(invoke('verify-release-trust-asset.mts',stageArgs).status,0);
  for(const [position,value] of [[4,'lab'],[4,environment === 'production' ? 'staging' : 'production'],[5,asset.control_plane_origin],[6,'https://wrong.example']]){
   const bad=[...stageArgs];bad[position]=value;assert.notEqual(invoke('verify-release-trust-asset.mts',bad).status,0);
  }
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
