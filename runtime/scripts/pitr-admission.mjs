#!/usr/bin/env node
// OFFLINE structural scope checking only. No provider/profile/environment access,
// signing, dispatch, restoration, approval, or reusable runtime authority.
import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PITR_RUN, parsePitrBinding } from '../deploy/hosted-worker/src/pitr-phase.ts';

const NIL='00000000-0000-0000-0000-000000000000';
const MAX_INPUT=16384;
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const TARGETS=Object.freeze({
  logWorker:'mdbase-next-log-pitr-lab-20261009-01',
  hostedWorker:'mdbase-next-hosted-pitr-lab-20261009-01',
  sourceBucket:'mdbase-next-pitr-source-lab-20261009-01',
  copyBucket:'mdbase-next-pitr-copy-lab-20261009-01',
});
export class AdmissionError extends Error { constructor(code){super(code);this.code=code;} }
const requireThat=(ok,code)=>{if(!ok)throw new AdmissionError(code);};
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hex=(v,n)=>typeof v==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(v)&&!/^0+$/.test(v);
const uuid=v=>typeof v==='string'&&UUID.test(v)&&v!==NIL;
function canonicalValue(v){
  if(Array.isArray(v))return v.map(canonicalValue);
  if(v!==null&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonicalValue(v[k])]));
  return v;
}
export const canonical=v=>JSON.stringify(canonicalValue(v));
export const scopeHash=v=>createHash('sha256').update(canonical(v)).digest('hex');

/** Fixed intended footprint BEFORE creation. Values are declarations, NOT
 * authenticated ownership, pricing, signed-artifact verification or a GO. */
export function validateIntent(v){
  requireThat(exact(v,['schema','run','account','workerSubdomain','owner','active','deleted','createdAfter','targets','limits','code']), 'intent_shape');
  requireThat(v.schema==='mdbn-gate4-intent/1'&&v.run===PITR_RUN,'intent_run');
  requireThat(hex(v.account,32)&&typeof v.workerSubdomain==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v.workerSubdomain),'intent_account');
  requireThat(uuid(v.owner)&&uuid(v.active)&&uuid(v.deleted)&&v.active!==v.deleted,'intent_subjects');
  requireThat(Number.isSafeInteger(v.createdAfter)&&v.createdAfter>0,'intent_date');
  requireThat(exact(v.targets,Object.keys(TARGETS))&&Object.entries(TARGETS).every(([k,x])=>v.targets[k]===x),'intent_targets');
  const maxima={usdCents:100,bytes:64*1024*1024,requests:10000,seconds:7200};
  requireThat(exact(v.limits,Object.keys(maxima))&&Object.entries(maxima).every(([k,max])=>Number.isSafeInteger(v.limits[k])&&v.limits[k]>0&&v.limits[k]<=max),'intent_limits');
  requireThat(exact(v.code,['nextCommit','cpCommit','opsCommit','bundleSha256','codeConfigSha256'])
    &&['nextCommit','cpCommit','opsCommit'].every(k=>hex(v.code[k],40))
    &&['bundleSha256','codeConfigSha256'].every(k=>hex(v.code[k],64)),'intent_code');
  return scopeHash(v);
}

/** Actual five-member/config/CP mapping declarations AFTER authorized creation.
 * Reuses runtime binding validation; never invents IDs or treats input receipts
 * as authenticated observations. Bookmarks/R2 closure/per-operation GO remain
 * separate and are deliberately NOT admitted by this offline tool. */
export function validatePins(intent,v){
  const hash=validateIntent(intent);
  requireThat(exact(v,['schema','run','intentSha256','account','binding','workers','cpMapping','escrowRecords','evidenceSha256']),'pins_shape');
  requireThat(v.schema==='mdbn-gate4-pins/1'&&v.run===PITR_RUN&&v.intentSha256===hash&&v.account===intent.account,'pins_intent');
  const binding=parsePitrBinding(canonical(v.binding));
  requireThat(binding!==null&&binding.active===intent.active&&binding.deleted===intent.deleted&&binding.codeConfigSha256===intent.code.codeConfigSha256,'pins_binding');
  requireThat(binding.members.every(m=>hex(m.namespace,32)&&hex(m.object,64)),'pins_ids');
  const log=binding.members.find(m=>m.kind==='log').namespace,hosted=binding.members.find(m=>m.kind==='hosted').namespace;
  const workerKeys=['name','class','entrypoint','namespace','bucket','version'];
  requireThat(exact(v.workers,['log','hosted'])&&exact(v.workers.log,workerKeys)&&exact(v.workers.hosted,workerKeys),'pins_workers');
  for(const [role,namespace,actor,entrypoint] of [
    ['log',log,'LogCollection','deploy/cloudflare-do/src/pitr-worker.mjs'],
    ['hosted',hosted,'HostedCollection','deploy/hosted-worker/src/pitr-worker.ts'],
  ]){
    const w=v.workers[role];
    requireThat(w.name===TARGETS[`${role}Worker`]&&w.class===actor&&w.entrypoint===entrypoint&&w.namespace===namespace&&w.bucket===TARGETS.sourceBucket&&uuid(w.version),'pins_profile');
  }
  requireThat(v.workers.log.version!==v.workers.hosted.version,'pins_profile');
  requireThat(exact(v.cpMapping,['origin','active','deleted'])&&v.cpMapping.origin==='https://connect-lab.mdbase.dev','pins_cp');
  const urls={logUrl:`https://${TARGETS.logWorker}.${intent.workerSubdomain}.workers.dev`,hostedUrl:`https://${TARGETS.hostedWorker}.${intent.workerSubdomain}.workers.dev`};
  for(const [role,collection] of [['active',intent.active],['deleted',intent.deleted]]){
    const m=v.cpMapping[role];
    requireThat(exact(m,['collection','owner','genesisSha256','logUrl','hostedUrl'])&&m.collection===collection&&m.owner===intent.owner
      &&hex(m.genesisSha256,64)&&m.logUrl===urls.logUrl&&m.hostedUrl===urls.hostedUrl,'pins_cp_member');
  }
  requireThat(Array.isArray(v.escrowRecords)&&v.escrowRecords.length===2,'pins_escrow');
  const seen=new Set();
  for(const e of v.escrowRecords){
    requireThat(exact(e,['collection','device','kind'])&&[intent.active,intent.deleted].includes(e.collection)&&uuid(e.device)&&e.kind==='escrow'
      &&!seen.has(e.collection),'pins_escrow');seen.add(e.collection);
  }
  requireThat(v.escrowRecords[0].device!==v.escrowRecords[1].device&&hex(v.evidenceSha256,64),'pins_evidence');
  return scopeHash(v);
}

/** Canonical UTF8 JSON only: duplicates/alternate representations are refused.
 * Single bounded fd read, regular file, no final symlink. No arbitrary input or
 * filesystem diagnostic is copied into errors/stdout. */
export function readMetadata(path){
  let fd;
  try{
    requireThat(Number.isInteger(constants.O_NOFOLLOW)&&Number.isInteger(constants.O_NONBLOCK),'metadata_platform');
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);requireThat(stat.isFile()&&stat.size<=MAX_INPUT,'metadata_file');
    const bytes=Buffer.alloc(MAX_INPUT+1);let n=0;
    while(n<bytes.length){const got=readSync(fd,bytes,n,bytes.length-n,null);if(!got)break;n+=got;}
    requireThat(n<=MAX_INPUT,'metadata_bytes');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,n));
    const value=JSON.parse(text);
    requireThat(text===canonical(value)||text===canonical(value)+'\n','metadata_canonical');
    return value;
  }catch(error){if(error instanceof AdmissionError)throw error;throw new AdmissionError('metadata_unavailable');}
  finally{if(fd!==undefined)closeSync(fd);}
}
export function report(stage,hash){
  return {schema:'mdbn-gate4-scope-check/1',run:PITR_RUN,stage,scopeSha256:hash,
    structuralScopeMatch:true,executionAuthorized:false,
    stillRequired:['authenticated-current-provider-and-CP-evidence','verified-artifact-and-config','pricing-and-authentication','exact-per-operation-GO','managed-runtime-all-five','bookmarks-and-full-byte-R2-closure']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    requireThat(process.argv.length===4||process.argv.length===5,'usage');
    const [stage,intentPath,pinsPath]=process.argv.slice(2);
    requireThat((stage==='intent'&&!pinsPath)||(stage==='pins'&&pinsPath),'usage');
    const intent=readMetadata(intentPath);
    const hash=stage==='intent'?validateIntent(intent):validatePins(intent,readMetadata(pinsPath));
    console.log(JSON.stringify(report(stage,hash)));
  }catch(error){console.error(JSON.stringify({error:error instanceof AdmissionError?error.code:'metadata_unavailable',executionAuthorized:false}));process.exitCode=1;}
}
