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
const shellPaths=['/','/.well-known/mdbase-app.json','/mdbase-shell-sw.js','/mdbase-shell-runtime.js','/mdbase-shell-register.js'];
// Built chunks name their WASM, fonts and workers in code, not in the index.
const references=/(?:\.{0,2}\/)?(?:[\w@~-]+\/)*[\w@~.-]+\.(?:m?js|css|json|webmanifest|wasm|woff2?|ttf|png|svg|ico)(?![\w.-])/g;
const hasReferences=path=>path==='/'||/\.(?:m?js|css|json|webmanifest)$/.test(path);
const snapshotPathLimit=1024;
export function referencedPaths(text,path) {
 const paths=new Set();
 for(const [reference] of text.matchAll(references)) {
  // Vite emits both file-relative and base-relative asset names.
  for(const base of [alias+path,alias+'/']) {
   const url=new URL(reference,base);
   if(url.origin===alias && /^\/[\w./@~-]*$/.test(url.pathname))paths.add(url.pathname);
  }
 }
 return paths;
}
export function indexAssets(html) {
 const paths=new Set();
 for(const tag of html.matchAll(/<(?:script|link|img|source)\b[^>]*>/gi)) {
  for(const attr of tag[0].matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
   const url=new URL(attr[1],alias+'/');
   // Cloudflare may inject its CSP-blocked analytics beacon into alias HTML.
   // It is not part of the Editor build or a recoverable Pages asset.
   if(url.origin==='https://static.cloudflareinsights.com' && /^\/beacon(?:\.min)?\.js(?:\/[\w.-]+)?$/.test(url.pathname))continue;
   need(url.origin===alias && !url.search && !url.hash,'index resource must be a same-origin static path');
   paths.add(url.pathname);
  }
 }
 need(paths.size>0 && paths.size<=256,'index resource inventory required');
 return [...paths].sort();
}
async function fingerprint(origin,path,fetchImpl,deadline=performance.now()+180000,retainBody=false,discovered=false) {
 const response=await fetchImpl(origin+path,{redirect:'manual',cache:'no-store',credentials:'omit',headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(Math.max(1,Math.min(15000,Math.floor(deadline-performance.now()))))});
 // A guessed reference may miss, and the Pages SPA fallback answers it with HTML.
 if(discovered && (response.status!==200 || response.headers.get('content-type')?.includes('text/html'))) {
  await response.body?.cancel().catch(()=>{});
  return null;
 }
 need(response.status===200,'previous deployment bytes unavailable');
 const reader=response.body.getReader(),digest=createHash('sha256'),chunks=[];let bytes=0;
 try {
  for(;;) {
   const part=await reader.read();if(part.done)break;
   bytes+=part.value.length;need(bytes<=25*1024*1024 && performance.now()<deadline,'previous deployment probe bound');digest.update(part.value);
   if(retainBody)chunks.push(Buffer.from(part.value));
  }
 }finally{await reader.cancel().catch(()=>{});}
 const headers=Object.fromEntries(['content-security-policy','x-content-type-options','referrer-policy','permissions-policy','cross-origin-opener-policy','content-type','cache-control'].map(name=>[name,response.headers.get(name)]));
 const probe={path,bytes,sha256:digest.digest('hex'),headers};
 return retainBody?{probe,body:Buffer.concat(chunks).toString('utf8')}:probe;
}
export async function capturePrevious(options) {
 const project=await pagesApi('',options),previous=project.canonical_deployment;
 need(project.name==='mdbase-editor' && project.production_branch==='main' && previous?.environment==='production' && uuid.test(previous.id??'') && /^https:\/\/[a-f0-9]{8,32}\.mdbase-editor\.pages\.dev$/.test(previous.url??''),'previous production deployment identity required');
 const fetchImpl=options.fetchImpl??fetch,deadline=performance.now()+180000;
 const index=await fingerprint(alias,'/',fetchImpl,deadline,true);
 const required=new Set([...shellPaths,...indexAssets(index.body)]),queue=[...required],seen=new Set(queue),probes=[];
 const follow=(text,path)=>{for(const next of referencedPaths(text,path))if(!seen.has(next)){seen.add(next);queue.push(next);}};
 follow(index.body,'/');
 while(queue.length) {
  need(seen.size<=snapshotPathLimit,'previous deployment inventory bound');
  const path=queue.shift();
  if(path==='/'){probes.push(index.probe);continue;}
  const result=await fingerprint(alias,path,fetchImpl,deadline,true,!required.has(path));
  if(!result)continue;
  probes.push(result.probe);
  if(hasReferences(path))follow(result.body,path);
 }
 need(isDeepStrictEqual(index.probe,await fingerprint(alias,'/',fetchImpl,deadline)),'alias changed during snapshot');
 need((await pagesApi('',options)).canonical_deployment?.id===previous.id,'canonical deployment changed during snapshot');
 return {id:previous.id,url:previous.url,probes};
}
export async function rollback(previous,options,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>performance.now(),settleMs=300000}={}) {
 need(uuid.test(previous?.id??'') && previous.probes?.length>=shellPaths.length &&
  shellPaths.every(path=>previous.probes.some(p=>p.path===path)) &&
  previous.probes.every(p=>/^\/[\w./@~-]*$/.test(p.path) && !p.path.split('/').includes('..') && /^[a-f0-9]{64}$/.test(p.sha256)),
  'captured full previous deployment required');
 const report={attempted:true,previousId:previous.id,ok:false,attempts:0};
 try {
  // A publication that stopped before Pages accepted it has nothing to undo.
  report.restored=(await pagesApi('',options)).canonical_deployment?.id!==previous.id;
  if(report.restored)await pagesApi(`/deployments/${previous.id}/rollback`,options,'POST');
  const deadline=now()+settleMs;
  for(;;) {
   report.attempts++;
   try {
    need(now()<deadline,'rollback verification deadline');
    const project=await pagesApi('',options);
    need(project.canonical_deployment?.id===previous.id,'rollback deployment not active');
    for(const expected of previous.probes) {
     const actual=await fingerprint(alias,expected.path,options.fetchImpl??fetch,performance.now()+Math.max(1,deadline-now()));
     need(actual.bytes===expected.bytes && actual.sha256===expected.sha256 && isDeepStrictEqual(actual.headers,expected.headers),'alias does not serve previous deployment');
    }
    report.ok=true;return report;
   }catch{if(now()+15000>=deadline)break;await sleep(15000);}
  }
 }catch{/* Retain public failure state, never API payloads or transport errors. */}
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [command,directory]=process.argv.slice(2),json=async name=>JSON.parse(await readFile(`${directory}/${name}.json`,'utf8'));
 const options={accountId:process.env.CLOUDFLARE_ACCOUNT_ID,apiToken:process.env.CLOUDFLARE_API_TOKEN};
 try {
  if(command==='snapshot') {
   if(process.env.TARGET==='production')await writeFile(`${directory}/previous.json`,JSON.stringify(await capturePrevious(options),null,2));
  }else if(command==='recover') {
   const report=await rollback(await json('previous'),options);
   await writeFile(`${directory}/rollback.json`,JSON.stringify(report,null,2));
   // Publication never finished: restoring availability cannot turn this run green.
   console.error(report.ok?'Production publication failed or incomplete; previous deployment active and fully verified':'Production publication failed or incomplete; rollback did not succeed');
   process.exitCode=1;
  }else throw Error('Unknown recovery command');
 }catch{console.error('Editor recovery operation failed');process.exitCode=1;}
}
