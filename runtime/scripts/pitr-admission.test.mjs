// Synthetic metadata/files only: no Cloudflare, CP, credentials, or execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PITR_RUN } from '../deploy/hosted-worker/src/pitr-phase.ts';
import { AdmissionError, TARGETS, canonical, scopeHash, validateIntent, validatePins, readMetadata, report } from './pitr-admission.mjs';
const A='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',D='dddddddd-dddd-4ddd-addd-dddddddddddd',NIL='00000000-0000-0000-0000-000000000000';
const id=n=>`${n}`.repeat(8)+'-1111-4111-a111-'+`${n}`.repeat(12);
const copy=structuredClone;
function fixture(){
  const intent={schema:'mdbn-gate4-intent/1',run:PITR_RUN,account:'01'.repeat(16),workerSubdomain:'synthetic-test',
    owner:id(1),active:A,deleted:D,createdAfter:1,targets:{...TARGETS},limits:{usdCents:100,bytes:67108864,requests:10000,seconds:7200},
    code:{nextCommit:'1'.repeat(40),cpCommit:'2'.repeat(40),opsCommit:'3'.repeat(40),bundleSha256:'4'.repeat(64),codeConfigSha256:'5'.repeat(64)}};
  const members=[{kind:'log',collection:A,namespace:'01'.repeat(16),object:'01'.repeat(32)},
    {kind:'log',collection:D,namespace:'01'.repeat(16),object:'02'.repeat(32)},
    {kind:'registry',collection:NIL,namespace:'01'.repeat(16),object:'03'.repeat(32)},
    {kind:'hosted',collection:A,namespace:'02'.repeat(16),object:'04'.repeat(32)},
    {kind:'hosted',collection:D,namespace:'02'.repeat(16),object:'05'.repeat(32)}];
  const logUrl=`https://${TARGETS.logWorker}.${intent.workerSubdomain}.workers.dev`,hostedUrl=`https://${TARGETS.hostedWorker}.${intent.workerSubdomain}.workers.dev`;
  const pins={schema:'mdbn-gate4-pins/1',run:PITR_RUN,intentSha256:scopeHash(intent),account:intent.account,
    binding:{run:PITR_RUN,active:A,deleted:D,codeConfigSha256:intent.code.codeConfigSha256,members},
    workers:{log:{name:TARGETS.logWorker,class:'LogCollection',entrypoint:'deploy/cloudflare-do/src/pitr-worker.mjs',namespace:members[0].namespace,bucket:TARGETS.sourceBucket,version:id(2)},
      hosted:{name:TARGETS.hostedWorker,class:'HostedCollection',entrypoint:'deploy/hosted-worker/src/pitr-worker.ts',namespace:members[3].namespace,bucket:TARGETS.sourceBucket,version:id(3)}},
    cpMapping:{origin:'https://connect-lab.mdbase.dev',active:{collection:A,owner:intent.owner,genesisSha256:'a'.repeat(64),logUrl,hostedUrl},deleted:{collection:D,owner:intent.owner,genesisSha256:'d'.repeat(64),logUrl,hostedUrl}},
    escrowRecords:[{collection:A,device:id(4),kind:'escrow'},{collection:D,device:id(5),kind:'escrow'}],evidenceSha256:'6'.repeat(64)};
  return {intent,pins};
}
const refusal=(work,code)=>code===undefined?assert.throws(work,AdmissionError):assert.throws(work,{code});
test('two-stage canonical scope hashes are deterministic and never permissions',()=>{
  const {intent,pins}=fixture();assert.equal(validateIntent(intent),scopeHash(intent));assert.equal(validatePins(intent,pins),scopeHash(pins));
  const reordered=Object.fromEntries(Object.entries(intent).reverse());assert.equal(validateIntent(reordered),validateIntent(intent));
  for(const stage of ['intent','pins']){const r=report(stage,stage==='intent'?validateIntent(intent):validatePins(intent,pins));
    assert.equal(r.executionAuthorized,false);assert.equal(r.structuralScopeMatch,true);assert.ok(r.stillRequired.includes('exact-per-operation-GO'));
    assert.ok(r.stillRequired.includes('bookmarks-and-full-byte-R2-closure'));assert.equal(r.run,PITR_RUN);}
});
for(const change of [{run:'other'},{schema:'other'},{approved:true},{token:'synthetic-private-detail'},{active:NIL},{deleted:A},{owner:NIL},{createdAfter:0},{createdAfter:1.5},{account:'00'.repeat(16)},{workerSubdomain:'production.example.test'}])
  test(`intent rejects ${Object.keys(change).join(',')}`,()=>{const {intent}=fixture();refusal(()=>validateIntent({...intent,...change}));});
for(const [key,max] of Object.entries({usdCents:100,bytes:67108864,requests:10000,seconds:7200}))
  test(`intent ${key} refuses over/zero/negative/fractional/missing bounds`,()=>{for(const n of [max+1,0,-1,1.5,undefined]){const {intent}=fixture();intent.limits[key]=n;refusal(()=>validateIntent(intent),'intent_limits');}});
test('intent refuses foreign/shared bucket-worker targets and missing immutable pins',()=>{
  for(const key of Object.keys(TARGETS)){const {intent}=fixture();intent.targets[key]='shared-lab';refusal(()=>validateIntent(intent),'intent_targets');}
  for(const key of ['nextCommit','cpCommit','opsCommit','bundleSha256','codeConfigSha256']){const {intent}=fixture();intent.code[key]='0'.repeat(intent.code[key].length);refusal(()=>validateIntent(intent),'intent_code');}
});
for(const change of [{intentSha256:'f'.repeat(64)},{account:'02'.repeat(16)},{run:'foreign'},{approved:true},{executionAuthorized:true}])
  test(`pins rejects ${Object.keys(change).join(',')}`,()=>{const {intent,pins}=fixture();refusal(()=>validatePins(intent,{...pins,...change}));});
test('binding retains runtime exact all-five/two-namespace/no-escrow membership validation',()=>{
  for(const mutate of [p=>p.binding.members.pop(),p=>p.binding.members.push({...p.binding.members[0],kind:'escrow'}),
    p=>p.binding.members[2].collection=A,p=>p.binding.members[3].namespace=p.binding.members[0].namespace,
    p=>p.binding.members[1].object=p.binding.members[0].object,p=>p.binding.members[4].object='0'.repeat(64),
    p=>p.binding.codeConfigSha256='f'.repeat(64),p=>p.binding.deleted=id(6)]){
    const {intent,pins}=fixture();mutate(pins);refusal(()=>validatePins(intent,pins));}
});
test('pins requires required entrypoints/actual declared namespace/version and dedicated source bucket',()=>{
  for(const role of ['log','hosted'])for(const [key,value] of Object.entries({entrypoint:'ordinary-worker',class:'ForeignCollection',namespace:'03'.repeat(16),bucket:TARGETS.copyBucket,version:NIL})){
    const {intent,pins}=fixture();pins.workers[role][key]=value;refusal(()=>validatePins(intent,pins),'pins_profile');}
  const {intent,pins}=fixture();pins.workers.hosted.version=pins.workers.log.version;refusal(()=>validatePins(intent,pins),'pins_profile');
});
test('CP correspondence is exact fixed LAB and both original subject/owner/genesis/URL tuples',()=>{
  for(const role of ['active','deleted'])for(const [key,value] of Object.entries({collection:id(6),owner:id(6),genesisSha256:'0'.repeat(64),logUrl:'https://shared-log.test',hostedUrl:'https://shared-hosted.test'})){
    const {intent,pins}=fixture();pins.cpMapping[role][key]=value;refusal(()=>validatePins(intent,pins),'pins_cp_member');}
  const {intent,pins}=fixture();pins.cpMapping.origin='https://production.test';refusal(()=>validatePins(intent,pins),'pins_cp');
});
test('two real escrow record declarations only, never activation or actor admission',()=>{
  for(const mutate of [p=>p.escrowRecords.pop(),p=>p.escrowRecords[1].collection=A,p=>p.escrowRecords[0].device=NIL,
    p=>p.escrowRecords[0].kind='hosted',p=>p.escrowRecords[0].activated=true,p=>p.escrowRecords[1].device=p.escrowRecords[0].device]){
    const {intent,pins}=fixture();mutate(pins);refusal(()=>validatePins(intent,pins));}
});
test('scope drift invalidates hashes; parsed intent cannot sneak post-creation IDs into stage one',()=>{
  const {intent,pins}=fixture();intent.limits.requests=9999;refusal(()=>validatePins(intent,pins),'pins_intent');
  intent.binding=pins.binding;refusal(()=>validateIntent(intent),'intent_shape');
});
test('bounded canonical files reject duplicate keys/UTF8/oversize/symlink/directory and do not echo input',()=>{
  const dir=mkdtempSync(resolve('scripts/.pitr-admission-test-'));const file=join(dir,'metadata.json');
  try{
    const {intent}=fixture();writeFileSync(file,canonical(intent)+'\n',{mode:0o600});assert.deepEqual(readMetadata(file),intent);
    for(const content of ['{"a":1,"a":2}',' {"a":1}',Buffer.from([0xff]),'x'.repeat(16385),'synthetic-private-detail']){
      writeFileSync(file,content);refusal(()=>readMetadata(file));}
    writeFileSync(file,canonical(intent));const link=join(dir,'link');symlinkSync(file,link);refusal(()=>readMetadata(link));refusal(()=>readMetadata(dir),'metadata_file');
    const child=spawnSync(process.execPath,['--experimental-transform-types',resolve('scripts/pitr-admission.mjs'),'intent',join(dir,'synthetic-private-detail')],{encoding:'utf8'});
    assert.equal(child.status,1);assert.equal(child.stdout,'');assert.equal(child.stderr.includes('synthetic-private-detail'),false);const errors=child.stderr.split('\n').filter(line=>line.startsWith('{"error":'));assert.equal(errors.length,1);
    assert.deepEqual(JSON.parse(errors[0]),{error:'metadata_unavailable',executionAuthorized:false});
  }finally{rmSync(dir,{recursive:true});}
});
test('operational assertions never extend either structural input schema',()=>{
  for(const key of ['current','runtimeQualified','pricingVerified','restoreConfirmed','bookmarks','phaseReceipt','acceptedOriginalProof']){
    const {intent,pins}=fixture();
    refusal(()=>validateIntent({...intent,[key]:true}),'intent_shape');
    refusal(()=>validatePins(intent,{...pins,[key]:true}),'pins_shape');
    for(const stage of ['intent','pins'])assert.equal(report(stage,scopeHash(pins)).executionAuthorized,false);
  }
});
test('metadata byte boundary is exact, including the optional trailing newline',()=>{
  const dir=mkdtempSync(resolve('scripts/.pitr-admission-test-')),file=join(dir,'boundary.json');
  try{
    const value={x:'x'.repeat(16376)},bytes=canonical(value);assert.equal(Buffer.byteLength(bytes),16384);
    writeFileSync(file,bytes,{mode:0o600});assert.deepEqual(readMetadata(file),value);
    writeFileSync(file,bytes+'\n');refusal(()=>readMetadata(file),'metadata_file');
    writeFileSync(file,canonical({x:'x'.repeat(16375)})+'\n');assert.deepEqual(readMetadata(file),{x:'x'.repeat(16375)});
  }finally{rmSync(dir,{recursive:true});}
});
test('CLI validates scope metadata without outputting identities, paths or provider actions',()=>{
  const dir=mkdtempSync(resolve('scripts/.pitr-admission-test-'));
  try{
    const {intent,pins}=fixture();for(const [name,v] of [['intent',intent],['pins',pins]])writeFileSync(join(dir,name),canonical(v)+'\n',{mode:0o600});
    for(const stage of ['intent','pins']){
      const args=['--experimental-transform-types',resolve('scripts/pitr-admission.mjs'),stage,join(dir,'intent')];if(stage==='pins')args.push(join(dir,'pins'));
      // Spoofed environmental approvals cannot convert this offline DATA tool
      // into an execution/profile/provider adapter. It reads no such authority.
      const result=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,PITR_EXECUTION_AUTHORIZED:'true',PITR_GO:'approved',PITR_PHASE:'restore',PITR_RUNTIME_QUALIFIED:'true'}});assert.equal(result.status,0,result.stderr);
      const r=JSON.parse(result.stdout);assert.equal(r.stage,stage);assert.equal(r.executionAuthorized,false);assert.equal(result.stdout.includes(intent.account),false);assert.equal(result.stdout.includes(intent.owner),false);
    }
  }finally{rmSync(dir,{recursive:true});}
});
