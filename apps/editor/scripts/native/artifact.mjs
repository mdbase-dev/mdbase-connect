// GitHub immutable same-run artifact transport, no project dependencies/hooks.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInventory, inventoryDirectory } from './native-publish-bytes.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
class ArtifactRefusal extends Error {
  constructor(reason) { super(`Artifact refusal: ${reason}`); this.reason=reason; }
}
const requireValue = (ok, reason) => { if (!ok) throw new ArtifactRefusal(reason); };
// Only public identity fields used by the unchanged validators. Never retain
// API/request headers, signed blob URLs, arbitrary response fields or errors.
const publicStringPatterns={
 id:/^[1-9][0-9]*$/,repositoryId:/^[1-9][0-9]*$/,run:/^[1-9][0-9]*$/,attempt:/^[1-9][0-9]*$/,
 digest:/^sha256:[a-f0-9]{64}$/,source:/^[a-f0-9]{40}$/,tree:/^[a-f0-9]{40}$/,head_sha:/^[a-f0-9]{40}$/,
 repository:/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,full_name:/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
 name:/^editor-native-build-(staging|production)-[1-9][0-9]*-[1-9][0-9]*$/,
 ref:/^refs\/heads\/release\/native-(staging|production)$/,
 head_branch:/^release\/native-(staging|production)$/,
 path:/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/,event:/^[a-z_]+$/,target:/^(staging|production)$/
};
function publicFields(value, keys) {
  const out={};
  for(const key of keys) {
    const v=value?.[key];
    if(v===null || typeof v==='boolean' || (typeof v==='number' && Number.isSafeInteger(v)) ||
      (typeof v==='string' && v.length<=512 && publicStringPatterns[key]?.test(v)))out[key]=v;
  }
  return out;
}
function publicMetadata(value, kind) {
  const out=publicFields(value,kind==='run'?['id','head_sha','run_attempt','event','head_branch','path']:['id','expired','digest','name']);
  const key=kind==='run'?'repository':'workflow_run';
  if(value && Object.hasOwn(value,key))out[key]=value[key]===null?null:publicFields(value[key],kind==='run'?['id','full_name']:['id','head_sha','head_repository_id']);
  return out;
}
const publicMessages=new Set(['Forbidden','Not Found','API rate limit exceeded','Bad credentials','Requires authentication','Resource not accessible by integration','Resource not accessible by personal access token','Validation Failed']);
// Bounded PUBLIC body only; never opaque exceptions/headers/blob SAS URLs.
async function publicResponse(response,kind) {
  const limit=256*1024,deadline=Date.now()+30000,chunks=[];let bytes=0,complete=false,truncated=false,reader,timer;
  const expired=new Promise(resolve=>{timer=setTimeout(()=>resolve({expired:true}),30000);});
  try {
    reader=response.body?.getReader();complete=!reader;
    while(reader) {
      if(Date.now()>=deadline)break;
      const part=await Promise.race([reader.read(),expired]);
      if(part.expired)break;
      if(part.done){complete=true;break;}
      const chunk=Buffer.from(part.value),take=Math.min(chunk.length,limit-bytes);
      chunks.push(chunk.subarray(0,take));bytes+=take;
      if(take<chunk.length){truncated=true;break;}
    }
  }catch{/* Keep obtained status/body prefix, never raw reader errors. */}
  finally{clearTimeout(timer);if(reader && !complete)void reader.cancel().catch(()=>{});}
  const raw=Buffer.concat(chunks);let value,json=false;
  try{value=JSON.parse(raw.toString('utf8'));json=true;}catch{/* Non-JSON body fingerprint only, not unsafe opaque text. */}
  const safe={status:response.status,bodyBytes:raw.length,bodySha256:sha(raw),bodyComplete:complete,bodyTruncated:truncated};
  if(json) {
    safe.body=publicMetadata(value,kind);
    if(typeof value?.message==='string') {
      if(publicMessages.has(value.message))safe.body.message=value.message;
      else {safe.body.messageSha256=sha(value.message);safe.body.messageBytes=Buffer.byteLength(value.message);}
    }
    if(typeof value?.status==='string' && /^[1-5][0-9]{2}$/.test(value.status))safe.body.status=value.status;
    if(typeof value?.documentation_url==='string') {
      try{const url=new URL(value.documentation_url);if(url.origin==='https://docs.github.com' && !url.username && !url.password && !url.search && /^\/[a-z0-9/-]*$/i.test(url.pathname) && (!url.hash || /^#[a-z0-9-]+$/i.test(url.hash)))safe.body.documentation_url=url.href;}catch{/* omit unsafe URL */}
    }
  }
  return {safe,value,json,complete,truncated};
}
export function assertArtifactMetadata(meta, expected) {
  requireValue(/^[1-9][0-9]*$/.test(expected.id??'') && /^[1-9][0-9]*$/.test(expected.run??'') && /^[1-9][0-9]*$/.test(expected.attempt??'') && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository??'') && expected.event==='workflow_dispatch' && expected.ref===`refs/heads/release/native-${expected.target}`, 'expected transport identity');
  requireValue(meta.id === Number(expected.id) && meta.expired === false && meta.digest === expected.digest && /^sha256:[a-f0-9]{64}$/.test(meta.digest), 'immutable ID/digest');
  requireValue(meta.name === `editor-native-build-${expected.target}-${expected.run}-${expected.attempt}`, 'attempt-bound name');
  requireValue(meta.workflow_run?.id === Number(expected.run) && meta.workflow_run?.head_sha === expected.source && meta.workflow_run?.head_repository_id === Number(expected.repositoryId), 'repository/run/source');
}
export function assertArtifactRun(run, expected) {
  requireValue(run.id===Number(expected.run) && run.repository?.full_name===expected.repository && run.repository?.id===Number(expected.repositoryId) && run.head_sha===expected.source && run.run_attempt===Number(expected.attempt) && run.event==='workflow_dispatch' && run.head_branch===expected.ref.slice('refs/heads/'.length) && run.path==='.github/workflows/editor-pages.yml', 'run attempt/event/ref/workflow/repository');
}
export async function assertArtifactDirectory(root, expected) {
  const envelope = JSON.parse(await readFile(join(root,'envelope.json'),'utf8'));
  for (const key of ['repository','run','attempt','event','ref','source','tree','target']) requireValue(envelope[key] === expected[key], `envelope ${key}`);
  const inventoryBytes = await readFile(join(root,'inventory.json'));
  const planBytes = await readFile(join(root,'plan.json'));
  requireValue(envelope.inventorySha256 === sha(inventoryBytes) && envelope.planSha256 === sha(planBytes), 'full inventory/plan binding');
  const plan = JSON.parse(planBytes), inventory = JSON.parse(inventoryBytes);
  requireValue(plan.sha === expected.source && plan.tree === expected.tree && plan.sdkTrust.environment === expected.target, 'plan source/tree/target');
  await assertInventory(join(root,'publish'), inventory);
  const all = await inventoryDirectory(root);
  requireValue(all.length === inventory.length + 3 && all.every(a => ['envelope.json','inventory.json','plan.json'].includes(a.path) || a.path.startsWith('publish/')), 'unexpected artifact paths');
  return {plan,inventory,envelope};
}
export async function download(expected, root, transport = fetch) {
  const token = process.env.GITHUB_TOKEN;
  const base = `https://api.github.com/repos/${expected.repository}`;
  const captureResponse=async(response,slot,kind)=>{
    await remember(slot,{status:response.status}); // even a body-read failure retains HTTP status
    const body=await publicResponse(response,kind);await remember(slot,body.safe);return body;
  };
  const get = async (path,slot,kind) => {
    const response = await transport(base+path, {headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(30000)});
    const body=await captureResponse(response,slot,kind);
    // Persist bounded public body AND numeric status BEFORE either refusal.
    requireValue(response.ok, 'GitHub metadata unavailable');
    requireValue(body.complete && !body.truncated && body.json,'bounded GitHub metadata body');return body.value;
  };
  await mkdir(join(root,'..'),{recursive:true});
  const evidence = join(root,'../artifact-metadata.json');
  const observed={expected:publicFields(expected,['id','digest','repository','repositoryId','run','attempt','event','ref','source','tree','target'])};
  const persist=()=>writeFile(evidence,JSON.stringify(observed,null,2));
  const remember=async(key,value)=>{observed[key]=value;await persist();};
  let stage='before-metadata-fetch';
  // Even a failed FIRST lookup retains honest source/run expectations only.
  await persist();
  try {
    const before = await get(`/actions/artifacts/${expected.id}`,'beforeResponse','artifact');
    await remember('before',publicMetadata(before,'artifact'));
    stage='before-metadata-validation';assertArtifactMetadata(before,expected);
    stage='initial-run-fetch';const run = await get(`/actions/runs/${expected.run}`,'runResponse','run');
    await remember('run',publicMetadata(run,'run'));
    stage='initial-run-validation';assertArtifactRun(run,expected);
    stage='zip-redirect-fetch';
    const response = await transport(`${base}/actions/artifacts/${expected.id}/zip`, {headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(30000)});
    const redirectBody=await captureResponse(response,'zipResponse','artifact');
    stage='zip-redirect-validation';requireValue(response.status === 302, 'archive redirect');
    requireValue(redirectBody.complete && !redirectBody.truncated, 'bounded archive redirect body');
    const location = new URL(response.headers.get('location'));
    requireValue(location.protocol === 'https:' && !location.username && !location.password, 'archive HTTPS');
    // Never forward GitHub credentials to the blob endpoint or retain its URL.
    stage='zip-download';
    const blob = await transport(location,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60000)});
    await remember('blobResponse',{status:blob.status});
    if(!blob.ok)await captureResponse(blob,'blobResponse','artifact');
    stage='zip-size-status';requireValue(blob.ok && Number(blob.headers.get('content-length')) <= 512*1024*1024,'archive size/status');
    const chunks=[]; let size=0;stage='zip-read';
    for await (const chunk of blob.body) { size+=chunk.length; requireValue(size<=512*1024*1024,'archive size'); chunks.push(chunk); }
    const bytes=Buffer.concat(chunks),downloadedSha256=sha(bytes);
    // COMPLETE actual ZIP identity, together on disk BEFORE comparison/NEXT.
    // Never metadata/header lengths, nor the identity of an incomplete prefix.
    Object.assign(observed,{downloadedSha256,downloadedBytes:bytes.length});await persist();
    const failures=[];
    const retainFailure=async(error)=>{
      failures.push({stage,reason:error instanceof ArtifactRefusal?error.reason:'operation-failed'});
      observed.failure=failures[0];
      if(failures.length>1)observed.secondaryFailures=failures.slice(1);
      await persist();
    };
    const zip=join(root,'../editor-native.zip');
    try {
      stage='zip-digest-validation';requireValue(`sha256:${downloadedSha256}` === expected.digest,'download digest');
      stage='zip-write';await mkdir(root,{recursive:true});await writeFile(zip,bytes,{flag:'wx'});
      // Validate ALL names/modes before extracting; no archive scripts or links.
      stage='zip-extraction';execFileSync('python3',['-B',fileURLToPath(new URL('./artifact-zip.py',import.meta.url)),zip,root],{stdio:'pipe'});
    } catch(error) {await retainFailure(error);}
    // A COMPLETE download requires BOTH independent post observations even on
    // digest/write/extraction/AFTER refusal. Exactly one lookup each, no retry.
    // Preserve the first failure; later failures are fixed safe classifications.
    for(const [slot,path,kind,validate,fetchStage,validationStage] of [
      ['after',`/actions/artifacts/${expected.id}`,'artifact',assertArtifactMetadata,'after-metadata-fetch','after-metadata-validation'],
      ['runAfter',`/actions/runs/${expected.run}`,'run',assertArtifactRun,'after-run-fetch','after-run-validation']
    ]) {
      try {
        stage=fetchStage;const value=await get(path,slot+'Response',kind);
        await remember(slot,publicMetadata(value,kind));
        stage=validationStage;validate(value,expected);
      } catch(error) {await retainFailure(error);}
    }
    if(failures.length){stage=failures[0].stage;throw new ArtifactRefusal(failures[0].reason);}
    stage='post-download-digest';requireValue(sha(await readFile(zip)) === expected.digest.slice(7), 'post-download archive digest');
    stage='artifact-directory';await assertArtifactDirectory(root,expected);
    // Metadata and actual ZIP digest remain outside the immutable upload tree.
  } catch(error) {
    const reason=error instanceof ArtifactRefusal?error.reason:'operation-failed';
    observed.failure={stage,reason};await persist();
    // No transport error/body/request details (which could contain credentials).
    throw new ArtifactRefusal(`${stage}: ${reason}`);
  }
}
if(process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const expected={id:process.env.ARTIFACT_ID,digest:`sha256:${(process.env.ARTIFACT_DIGEST ?? '').replace(/^sha256:/,'')}`,repository:process.env.GITHUB_REPOSITORY,repositoryId:process.env.GITHUB_REPOSITORY_ID,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,source:process.env.SOURCE_SHA,event:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),target:process.env.TARGET};
    await download(expected,process.argv[2]);
  } catch(error) {console.error(error.message); process.exitCode=1;}
}
