// Source-owned Pages STATIC policy, never an artifact-provided auth/control flag.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyServedBytes } from './native-publish-bytes.mjs';
export const headersPolicy=readFileSync(new URL('../../public/_headers',import.meta.url),'utf8');
export const redirectsPolicy=readFileSync(new URL('../../public/_redirects',import.meta.url),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const controlNames=new Set(['_headers','_redirects','_routes.json']);
const isControl=path=>controlNames.has(path.split('/').at(-1));
function assertPolicyInventory(inventory) {
 const expected={'_headers':headersPolicy,'_redirects':redirectsPolicy};
 for(const name of Object.keys(expected)) {
  const bytes=Buffer.from(expected[name]),item=inventory.find(a=>a.path===name);
  if(item?.sha256!==hash(bytes) || item.bytes!==bytes.length)throw Error('Unreviewed hosting control '+name);
 }
 for(const item of inventory) {
  if((isControl(item.path) && !Object.hasOwn(expected,item.path)) || item.path==='_worker.js' || item.path.startsWith('_worker.js/') || item.path.startsWith('functions/'))
   throw Error('Unreviewed executing Pages Worker/route/control '+item.path);
 }
 return expected;
}
export async function assertHostingSource(root,inventory) {
 for(const [name,bytes] of Object.entries(assertPolicyInventory(inventory)))if(await readFile(join(root,name),'utf8')!==bytes)throw Error('Source policy bytes changed '+name);
}
function checkHeaders(response,path) {
 // Pages canonical HTML redirects are validated by the shared helper. Header
 // policy applies to the final static response, not CDN-generated redirects.
 if([301,302,303,307,308].includes(response.status))return;
 const lines=headersPolicy.split('\n');
 let section;
 for(const line of lines) {
  if(line && !line.startsWith(' ')){section=line;continue;}
  const match=/^  ([^:]+): (.+)$/.exec(line);
  if(!match || section!=='/*')continue;
  if(response.headers.get(match[1])!==match[2])throw Error('Live source-owned header policy mismatch: '+match[1]);
 }
 if(path==='/.well-known/mdbase-app.json' && response.headers.get('cache-control')!=='no-store')throw Error('Manifest cache policy mismatch');
 if(path.startsWith('/assets/')) {
  const actual=response.headers.get('cache-control')?.split(',').map(s=>s.trim().toLowerCase())??[];
  if(!['public','max-age=0','must-revalidate'].every(s=>actual.includes(s)))throw Error('Asset cache policy mismatch');
 }
 if(response.status!==200)return;
 const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
 if(path.endsWith('.wasm') && type!=='application/wasm')throw Error('Live WASM MIME policy mismatch');
 if(/\.(m?js)$/.test(path) && !['text/javascript','application/javascript'].includes(type))throw Error('Live JS MIME policy mismatch');
 if(path.endsWith('.json') && type!=='application/json')throw Error('Live JSON MIME policy mismatch');
}
export async function verifyHosting({origin,inventory,deployment,fetchImpl=fetch,totalTimeoutMs=180000,...options}) {
 if(!['https://editor-staging.mdbase.dev','https://editor.mdbase.dev'].includes(origin)
   && !(origin===deployment?.url && /^https:\/\/[a-f0-9]{8,32}\.mdbase-editor\.pages\.dev$/.test(origin)))throw Error('Nonapproved verification origin');
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(deployment?.id??''))throw Error('Actual deployment UUID required BEFORE served checks');
 assertPolicyInventory(inventory);
 const duration=Math.min(totalTimeoutMs,180000);
 if(!Number.isFinite(duration) || duration<=0)throw Error('Invalid verification deadline');
 const deadline=performance.now()+duration;
 const remaining=()=>Math.max(0,Math.floor(deadline-performance.now()));
 const failures=[],probes=[];
 const transport=async(url,init)=>{
  const response=await fetchImpl(url,init);
  try {checkHeaders(response,new URL(url).pathname);}
  catch {
   // A security-policy refusal is terminal policy evidence, NOT a transient
   // network exception. Still account for the body, without refetching it.
   failures.push({path:new URL(url).pathname,reason:'trusted-live-header-policy-failed'});
  }
  return response;
 };
 const probe=async(path,status,item)=>{
  let timer,reader,controller=new AbortController();
  const timeout=Math.min(15000,remaining());
  if(timeout<=0)throw Error('publication-timeout');
  try {
   return await Promise.race([(async()=>{
    const url=origin+path;
    const response=await transport(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',headers:{'Accept-Encoding':'identity'},signal:controller.signal});
    if(response.redirected || (response.url && response.url!==url) || response.status!==status)throw Error('Live route/status mismatch');
    const digest=createHash('sha256');let bytes=0;
    reader=response.body.getReader();
    for(;;) {
     const part=await reader.read();if(part.done)break;
     if(controller.signal.aborted || remaining()<=0)throw Error('publication-timeout');
     bytes+=part.value.length;if(bytes>item.bytes || bytes>2*1024*1024)throw Error('Live route body bound');digest.update(part.value);
    }
    if(bytes!==item.bytes || digest.digest('hex')!==item.sha256)throw Error('Live route original bytes mismatch');
    probes.push({path,status,sha256:item.sha256,bytes});
   })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('publication-timeout'));},timeout);})]);
  } finally {clearTimeout(timer);controller.abort();try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}}
 };
 const index=inventory.find(a=>a.path==='index.html'),notFound=inventory.find(a=>a.path==='404.html');
 if(!index || !notFound)throw Error('Missing route originals');
 // Callback is an internal 200 rewrite to exact index, NOT a 302/login redirect.
 for(const [path,status,item] of [['/connect',200,index],['/connect/retired',200,index],['/__editor_native_policy_missing__',404,notFound],['/_headers',404,notFound],['/_redirects',404,notFound],['/_routes.json',404,notFound],['/_worker.js',404,notFound]]) {
  try {await probe(path,status,item);}catch{failures.push({path,reason:'trusted-live-route/header-policy-failed'});}
 }
 let bytes;
 try {
  if(remaining()<=0)throw Error('publication-timeout');
  // No artifact mappings/options accepted at the CLI. Shared verifier covers ALL
  // actual servable bytes, incl .well-known, static SW, SDK Worker, native/SQLite.
  bytes=await verifyServedBytes(origin,inventory,{...options,fetch:transport,totalTimeoutMs:remaining()});
 } catch(error) {bytes={verified:[],unverified:inventory.filter(a=>isControl(a.path)),failures:[{path:'*',reason:error.message}]};}
 failures.push(...bytes.failures);
 const controls=failures.length===0?bytes.unverified.filter(a=>['_headers','_redirects'].includes(a.path)).map(({reason,...a})=>({...a,policy:'trusted-source-and-live-probes',probes})):[];
 const unverified=bytes.unverified.filter(a=>!controls.some(c=>c.path===a.path));
 return {...bytes,failures,unverified,controls,probes,ok:failures.length===0 && unverified.length===0 && bytes.verified.length+controls.length===inventory.length};
}
// The immutable deployment URL is verified once: any failure there is terminal.
// Only after it has fully proven the exact bytes and source-owned policy is the
// custom alias re-verified, read-only, inside a bounded settle window, because
// the alias can keep serving the previous deployment while Pages propagates.
// Every attempt is a complete verification; a failed attempt is never accepted,
// and nothing is rebuilt, redeployed or rolled back here.
const ALIAS_SETTLE_MS=300000,ALIAS_RETRY_DELAY_MS=15000,ALIAS_MIN_ATTEMPT_MS=30000;
const attemptSummary=(report,startedMs)=>({startedMs:Math.round(startedMs),ok:report.ok===true,
 failures:(report.failures??[]).slice(0,20),failureCount:report.failures?.length??0,unverifiedCount:report.unverified?.length??0});
export async function verifyPublication({plan,inventory,deployment,verify=verifyHosting,now=()=>performance.now(),
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),deploymentTimeoutMs=180000,aliasSettleMs=ALIAS_SETTLE_MS,
  aliasRetryDelayMs=ALIAS_RETRY_DELAY_MS,aliasMinAttemptMs=ALIAS_MIN_ATTEMPT_MS}) {
 if(deployment?.sourceSha!==plan?.sha || deployment?.pagesBranch!==plan?.pagesBranch)throw Error('Deployment/source/target mismatch');
 const start=now(),reports=[],aliasAttempts=[];
 const immutable={origin:deployment.url,...await verify({origin:deployment.url,inventory,deployment,totalTimeoutMs:deploymentTimeoutMs})};
 reports.push(immutable);
 if(plan.origin!==deployment.url) {
  const deadline=now()+aliasSettleMs;
  let alias;
  for(;;) {
   const startedMs=now()-start;
   alias={origin:plan.origin,...await verify({origin:plan.origin,inventory,deployment,totalTimeoutMs:Math.min(180000,Math.max(1,deadline-now()))})};
   aliasAttempts.push(attemptSummary(alias,startedMs));
   // A failed immutable deployment is not waited out: record one alias report only.
   if(alias.ok===true || immutable.ok!==true || deadline-now()<aliasRetryDelayMs+aliasMinAttemptMs)break;
   await sleep(aliasRetryDelayMs);
  }
  reports.push(alias);
 }
 const alias=reports.find(r=>r.origin===plan.origin);
 return {...alias,origins:reports,aliasAttempts,ok:reports.length===2 && reports.every(r=>r.ok===true)};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 try {
  const [planPath,inventoryPath,deploymentPath]=process.argv.slice(2);
  const json=async path=>JSON.parse(await readFile(path,'utf8'));
  const result=await verifyPublication({plan:await json(planPath),inventory:await json(inventoryPath),deployment:await json(deploymentPath)});
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
 }catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
