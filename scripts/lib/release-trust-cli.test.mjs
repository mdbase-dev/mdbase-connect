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
