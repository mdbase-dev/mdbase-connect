// OFFLINE fixtures only: CLI shape/crypto validation does not authenticate a release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReleaseBundle } from './release-components.mjs';
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
  const built=invoke('build-release-trust-bundle.mts',[input,output],{SOURCE_COMMIT:asset.source.commit,GITHUB_SHA:'c'.repeat(40),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1',PUBLISHER_QUALIFICATION_RUN_ID:'13',PUBLISHER_QUALIFICATION_RUN_ATTEMPT:'1'});
  assert.equal(built.status,0,built.stderr);
  const manifest=path.join(output,'release-trust-bundle.json'),payload=path.join(output,'next-trust/lab.json');
  assert.deepEqual(readFileSync(payload),readFileSync(assetPath));
  const args=[manifest,payload,asset.source.commit,asset.source.version,'lab',asset.control_plane_origin,asset.log_origin];
  assert.equal(invoke('verify-release-trust-asset.mts',args).status,0);
  for(const [position,value] of [[2,'d'.repeat(40)],[3,'0.1.0-beta.999'],[4,'production'],[5,'https://wrong.example'],[6,'https://wrong.example']]){
   const bad=[...args];bad[position]=value;assert.notEqual(invoke('verify-release-trust-asset.mts',bad).status,0);
  }
  writeFileSync(payload,readFileSync(payload).toString()+' ');assert.notEqual(invoke('verify-release-trust-asset.mts',args).status,0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
