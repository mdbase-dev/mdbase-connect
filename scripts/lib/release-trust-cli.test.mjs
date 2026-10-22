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
for(const [environment,rootId,policyId] of [
 ['staging','ed034ffa359b2e6086fdb05fb6bab2de','6d730f62b69b214537485aa70016d116'],
 ['production','70a2bd532b5544dfb77617d4040ca6a2','c580fb092af10eb030605bd6e478e6f1'],
]) test(`committed ${environment} asset has independent pinned-release context and real certified pins (offline, NOT publication authentication)`,()=>{
 const assetPath=path.join(root,`config/next-trust/${environment}.json`);
 const prepared=JSON.parse(readFileSync(assetPath));
 const [commit,version]=environment==='staging'?['6c3bf8eb391dae81028b07d8a7996e1272c34d87','0.1.0-beta.136']:['f45df4598a5bff891de68eec3431ec7744885067','0.1.0-beta.134'];
 const suffix=environment==='staging'?'-staging':'',cp=`https://connect${suffix}.mdbase.dev`,log=`https://log${suffix}.mdbase.dev`;
 assert.equal(prepared.environment,environment);
 assert.equal(prepared.control_plane_origin,cp);
 assert.equal(prepared.log_origin,log);
 assert.deepEqual(prepared.source,{repository:'mdbase-dev/mdbase-connect',commit,version});
 assert.deepEqual(prepared.roots.map(r=>r.key_id),[rootId]);
 assert.deepEqual(prepared.policy_keys.map(p=>p.key_id),[policyId]);
 assert.notEqual(prepared.roots[0].public_key,asset.roots[0].public_key);
 const other=JSON.parse(readFileSync(path.join(root,`config/next-trust/${environment==='staging'?'production':'staging'}.json`)));
 assert.notEqual(prepared.roots[0].public_key,other.roots[0].public_key);
 assert.notEqual(prepared.policy_keys[0].certificate.policy_public_key,other.policy_keys[0].certificate.policy_public_key);
 const dir=mkdtempSync(path.join(tmpdir(),`trust-${environment}-asset-`));
 try {
  // Synthetic image/run metadata ONLY to exercise the publisher's reference
  // encoder/validator. These are not a real inventory, signature or authority.
  const contract=JSON.parse(readFileSync(path.join(root,'config/release-components.json')));
  const records=contract.components.map((c,i)=>({component:c.id,commit,image:c.image+'@sha256:'+String(i+1).repeat(64)}));
  const release=buildReleaseBundle(contract,records,{commit,version,mdbaseRsRevision:'b'.repeat(40),qualificationRunId:10,qualificationRunAttempt:1,publicationRunId:11,publicationRunAttempt:1});
  const input=path.join(dir,'image.json'),output=path.join(dir,'output');writeFileSync(input,JSON.stringify(release));
  const built=invoke('build-release-trust-bundle.mts',[input,output,environment],{SOURCE_COMMIT:commit,GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',PUBLISHER_QUALIFICATION_RUN_ID:'13',PUBLISHER_QUALIFICATION_RUN_ATTEMPT:'1'});
  assert.equal(built.status,0,built.stderr);
  const copied=path.join(output,`next-trust/${environment}.json`);assert.deepEqual(readFileSync(copied),readFileSync(assetPath));
  const args=[path.join(output,'release-trust-bundle.json'),copied,commit,version,environment,cp,log];
  const checked=invoke('verify-release-trust-asset.mts',args);assert.equal(checked.status,0,checked.stderr);
  for(const [position,value] of [[2,'d'.repeat(40)],[3,'0.1.0-beta.129'],[4,other.environment],[5,other.control_plane_origin],[6,other.log_origin]]){
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
