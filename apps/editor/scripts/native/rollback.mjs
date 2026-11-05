import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const need=(ok,message)=>{if(!ok)throw Error('Editor recovery refusal: '+message);};
const alias='https://editor.mdbase.dev';
export async function pagesApi(path,{accountId,apiToken,fetchImpl=fetch},method='GET') {
 need(/^[a-f0-9]{32}$/.test(accountId??'') && apiToken,'Pages credentials required');
 const response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/mdbase-editor${path}`,
  {method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${apiToken}`}});
 need(response.ok,'Pages API request failed');
 const body=await response.json();need(body.success,'Pages API refused request');return body.result;
}
async function fingerprint(origin,path,fetchImpl) {
 const response=await fetchImpl(origin+path,{redirect:'manual',cache:'no-store',credentials:'omit',headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(15000)});
 need(response.status===200,'previous deployment bytes unavailable');
 const reader=response.body.getReader(),digest=createHash('sha256');let bytes=0;
 try {
  for(;;) {
   const part=await reader.read();if(part.done)break;
   bytes+=part.value.length;need(bytes<=2*1024*1024,'previous deployment probe too large');digest.update(part.value);
  }
 }finally{await reader.cancel().catch(()=>{});}
 const headers=Object.fromEntries(['content-security-policy','x-content-type-options','referrer-policy','permissions-policy','cross-origin-opener-policy','content-type','cache-control'].map(name=>[name,response.headers.get(name)]));
 return {path,bytes,sha256:digest.digest('hex'),headers};
}
export async function capturePrevious(options) {
 const project=await pagesApi('',options),previous=project.canonical_deployment;
 need(project.name==='mdbase-editor' && project.production_branch==='main' && previous?.environment==='production' && uuid.test(previous.id??'') && /^https:\/\/[a-f0-9]{8,32}\.mdbase-editor\.pages\.dev$/.test(previous.url??''),'previous production deployment identity required');
 const probes=[];
 for(const path of ['/','/.well-known/mdbase-app.json'])probes.push(await fingerprint(previous.url,path,options.fetchImpl??fetch));
 return {id:previous.id,url:previous.url,probes};
}
export async function rollback(previous,options,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>performance.now(),settleMs=300000}={}) {
 need(uuid.test(previous?.id??'') && previous.probes?.length===2,'captured previous deployment required');
 const report={attempted:true,previousId:previous.id,ok:false,attempts:0};
 try {
  await pagesApi(`/deployments/${previous.id}/rollback`,options,'POST');
  const deadline=now()+settleMs;
  for(;;) {
   report.attempts++;
   try {
    const project=await pagesApi('',options);
    need(project.canonical_deployment?.id===previous.id,'rollback deployment not active');
    for(const expected of previous.probes) {
     const actual=await fingerprint(alias,expected.path,options.fetchImpl??fetch);
     need(actual.bytes===expected.bytes && actual.sha256===expected.sha256 && isDeepStrictEqual(actual.headers,expected.headers),'alias does not serve previous deployment');
    }
    report.ok=true;return report;
   }catch{if(now()+15000>=deadline)break;await sleep(15000);}
  }
 }catch{/* Retain public failure state, never API payloads or transport errors. */}
 return report;
}
export async function recoverOnFailure({plan,verification,previous,options,recover=rollback}) {
 if(plan.target!=='production' || verification.ok===true)return {attempted:false};
 const aliasReport=verification.origins?.find(r=>r.origin===plan.origin);
 if(aliasReport?.ok===true)return {attempted:false};
 return recover(previous,options);
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [command,directory]=process.argv.slice(2),json=async name=>JSON.parse(await readFile(`${directory}/${name}.json`,'utf8'));
 const options={accountId:process.env.CLOUDFLARE_ACCOUNT_ID,apiToken:process.env.CLOUDFLARE_API_TOKEN};
 try {
  if(command==='snapshot') {
   if(process.env.TARGET==='production')await writeFile(`${directory}/previous.json`,JSON.stringify(await capturePrevious(options),null,2));
  } else if(command==='recover') {
   let verification;try{verification=await json('verification');}catch{verification={ok:false};}
   const report=await recoverOnFailure({plan:await json('plan'),verification,previous:await json('previous'),options});
   await writeFile(`${directory}/rollback.json`,JSON.stringify(report,null,2));
   if(report.attempted && !report.ok)process.exitCode=1;
  }else throw Error('Unknown recovery command');
 }catch{console.error('Editor recovery operation failed');process.exitCode=1;}
}
