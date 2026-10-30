// Fixed selector/dispatch guards only; this never dispatches a workflow or signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../packages/protocol/package.json',import.meta.url));
const {parse}=require('yaml');
const workflow=parse(readFileSync(new URL('../../.github/workflows/publish-images.yml',import.meta.url),'utf8'));
test('fixed LAB/staging/production selector does not schedule image publication',()=>{
 assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options,['lab-trust','staging-trust','production-trust']);
 const guard=workflow.jobs.changes.if;
 assert.ok(guard.includes("github.event_name == 'workflow_run'"));
 assert.ok(!guard.includes("github.event_name == 'workflow_dispatch'"));
 assert.ok(!guard.includes("inputs.operation != 'lab-trust'"));
 const job=workflow.jobs['trust-bundle'];
 assert.ok(job.if.includes("inputs.operation == 'lab-trust'"));
 assert.ok(job.if.includes("inputs.operation == 'staging-trust'"));
 assert.ok(job.if.includes("inputs.operation == 'production-trust'"));
 assert.equal(job.env.TRUST_ENVIRONMENT,"${{ inputs.operation == 'production-trust' && 'production' || inputs.operation == 'staging-trust' && 'staging' || 'lab' }}");
 assert.equal(job.permissions['id-token'],'write');
 const qualify=job.steps.find(s=>s.id==='publisher-qualification').run;
 for(const gate of ['test "$GITHUB_REF" = refs/heads/main','test "$GITHUB_REPOSITORY" = mdbase-dev/mdbase-connect','asset="config/next-trust/$TRUST_ENVIRONMENT.json"','test -f "$asset" && test ! -L "$asset"','test "$(jq -er .environment "$asset")" = "$TRUST_ENVIRONMENT"','scripts/ci/verify-qualified-commit "$GITHUB_SHA"'])assert.ok(qualify.includes(gate),gate);
 const steps=job.steps.filter(s=>s.run).map(s=>s.run).join('\n');
 assert.ok(steps.includes('"$RUNNER_TEMP/release-trust" "$TRUST_ENVIRONMENT"'));
 assert.ok(steps.includes('--certificate-identity \'https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-images.yml@refs/heads/main\''));
 assert.ok(steps.includes('--certificate-oidc-issuer https://token.actions.githubusercontent.com'));
 assert.ok(steps.includes('scripts/ci/verify-qualified-commit "$SOURCE_COMMIT" "$run"'));
 assert.ok(steps.includes('cosign sign-blob --yes'));
 assert.equal(Object.hasOwn(workflow.on.workflow_dispatch.inputs,'asset_path'),false);
 assert.equal(Object.hasOwn(workflow.on.workflow_dispatch.inputs,'trust_environment'),false);
 assert.equal(job.env.EXPECTED_PUBLISHER_COMMIT,'${{ inputs.expected_publisher_commit }}');
 assert.equal(job.env.EXPECTED_TRUST_ASSET_SHA256,'${{ inputs.expected_trust_asset_sha256 }}');
});

function qualificationFixture(t, environment='staging') {
 const root=mkdtempSync(path.join(tmpdir(),'stage-publisher-pins-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(path.join(root,'config/next-trust'),{recursive:true});
 mkdirSync(path.join(root,'scripts/ci'),{recursive:true});
 const asset=path.join(root,`config/next-trust/${environment}.json`);
 const bytes=JSON.stringify({environment,fixture:'unsigned-not-authority'});
 writeFileSync(asset,bytes);
 writeFileSync(path.join(root,'scripts/ci/verify-qualified-commit'),'#!/usr/bin/env bash\nprintf called > qualified\n',{mode:0o700});
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');
 git('add','.');git('commit','-m','synthetic');
 const commit=git('rev-parse','HEAD'),digest=createHash('sha256').update(bytes).digest('hex');
 const env={...process.env,GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'mdbase-dev/mdbase-connect',GITHUB_SHA:commit,
  SOURCE_COMMIT:'a'.repeat(40),IMAGE_PUBLICATION_RUN_ID:'1',RELEASE_TAG:'v0.1.0-beta.129',TRUST_ENVIRONMENT:environment,
  EXPECTED_PUBLISHER_COMMIT:commit,EXPECTED_TRUST_ASSET_SHA256:digest};
 const run=(changes={})=>spawnSync('bash',['-euo','pipefail','-c',workflow.jobs['trust-bundle'].steps.find(s=>s.id==='publisher-qualification').run],
  {cwd:root,env:{...env,...changes},encoding:'utf8'});
 return {root,asset,run};
}

for (const environment of ['staging', 'production']) {
test(`${environment} approval pins retain publisher qualification, not signing authority`,t=>{
 const f=qualificationFixture(t,environment),r=f.run();assert.equal(r.status,0,r.stderr);
 assert.equal(readFileSync(path.join(f.root,'qualified'),'utf8'),'called');
});
test(`${environment} missing, malformed or changed approval pins stop before qualification/fetch/sign`,t=>{
 const f=qualificationFixture(t,environment);
 for(const changes of [{EXPECTED_PUBLISHER_COMMIT:''},{EXPECTED_PUBLISHER_COMMIT:'x'.repeat(40)},
  {EXPECTED_PUBLISHER_COMMIT:'b'.repeat(40)},{EXPECTED_TRUST_ASSET_SHA256:''},
  {EXPECTED_TRUST_ASSET_SHA256:'X'.repeat(64)},{EXPECTED_TRUST_ASSET_SHA256:'b'.repeat(64)}]){
  assert.notEqual(f.run(changes).status,0);
 }
 assert.throws(()=>readFileSync(path.join(f.root,'qualified')),{code:'ENOENT'});
});
test(`${environment} changed canonical bytes cannot inherit an approved digest`,t=>{
 const f=qualificationFixture(t,environment);writeFileSync(f.asset,JSON.stringify({environment,fixture:'changed'}));
 assert.notEqual(f.run().status,0);assert.throws(()=>readFileSync(path.join(f.root,'qualified')),{code:'ENOENT'});
});
test(`${environment} canonical asset cannot use symlink ancestry`,t=>{
 const f=qualificationFixture(t,environment),target=path.join(f.root,'actual');
 mkdirSync(target);writeFileSync(path.join(target,`${environment}.json`),readFileSync(f.asset));
 rmSync(path.join(f.root,'config/next-trust'),{recursive:true});symlinkSync(target,path.join(f.root,'config/next-trust'));
 assert.notEqual(f.run().status,0);assert.throws(()=>readFileSync(path.join(f.root,'qualified')),{code:'ENOENT'});
});
}
test('LAB keeps its original qualifier and does not require staging pins',t=>{
 const f=qualificationFixture(t,'lab'),r=f.run({EXPECTED_PUBLISHER_COMMIT:'',EXPECTED_TRUST_ASSET_SHA256:''});
 assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(path.join(f.root,'qualified'),'utf8'),'called');
});
