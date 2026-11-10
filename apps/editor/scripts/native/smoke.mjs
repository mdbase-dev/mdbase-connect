// Workflow-owned browser driver. Only public served application code runs in Chromium.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const origins={production:'https://editor.mdbase.dev',staging:'https://editor-staging.mdbase.dev'};
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
export function assertEntryAsset(url,source,target='production') {
 const origin=origins[target];
 need(origin&&/^[a-f0-9]{40}$/.test(source??''),'invalid-source');
 const asset=new URL(url);
 need(asset.origin===origin && new RegExp(`^/assets/[^/]+-${source.slice(0,12)}\\.js$`).test(asset.pathname),'entry-source-mismatch');
}
// Playwright's own messages can carry page text, so an unnamed failure reports
// only the stage it reached and whether it timed out.
export async function smoke(chromium,source,target='production') {
 let stage='launch';
 try{return await check(chromium,source,target,next=>{stage=next;});}
 catch(error){
  if(/^[a-z,-]+$/.test(error?.message??''))throw error;
  throw Error(`${stage}-${error?.name==='TimeoutError'?'timeout':'error'}`);
 }
}
async function check(chromium,source,target,at) {
 const browser=await chromium.launch({headless:true});
 const failures=new Set();
 try {
  at('context');
  const context=await browser.newContext({serviceWorkers:'block',locale:'en-US',
   extraHTTPHeaders:{'Cache-Control':'no-cache, no-store','Pragma':'no-cache'}});
  const page=await context.newPage();
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  page.on('pageerror',()=>failures.add('uncaught-page-error'));
  page.on('console',message=>{
   // Console errors are not page errors. In particular the Insights beacon's
   // known CSP refusal is harmless. A readiness fence is always terminal.
   if(/readiness_fenced/i.test(message.text()))failures.add('readiness-fenced');
  });
  at('entry-load');
  const response=await page.goto(origins[target]+'/',{waitUntil:'networkidle',timeout:90000});
  need(response?.status()===200,'entry-unavailable');
  at('entry-asset');
  // Cloudflare injects its Insights beacon as a cross-origin module script.
  const entries=(await page.locator('script[type="module"][src]').evaluateAll(nodes=>nodes.map(node=>node.src)))
   .filter(url=>new URL(url).origin===origins[target]);
  need(entries.length===1,'entry-asset-required');
  assertEntryAsset(entries[0],source,target);
  const entry=await context.request.get(entries[0]);
  need(entry.ok() && (await entry.body()).length>0,'entry-asset-unavailable');
  // Signed out, Editor opens this browser's unsynced collection; Sign in is the
  // first screen when work before connecting is off.
  at('first-screen');
  const signIn=page.getByRole('button',{name:'Sign in',exact:true});
  const unsynced=page.getByRole('status',{name:'Saved only in this browser',exact:true});
  await signIn.or(unsynced).first().waitFor({state:'visible',timeout:60000});
  const text=await page.locator('body').innerText();
  need(!/readiness_fenced/i.test(text),'readiness-fenced');
  need(!/Can.t continue/.test(text),'first-screen-blocked');
  need(failures.size===0,[...failures].sort().join(','));
  const started=await unsynced.isVisible();
  return {ok:true,source:source.slice(0,12),signIn:!started,unsynced:started,cacheDisabled:true};
 }finally{await browser.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [toolPath,receiptPath]=process.argv.slice(2);
 let report;
 try {
  const {chromium}=await import(pathToFileURL((await readFile(toolPath,'utf8')).trim()).href);
  report=await smoke(chromium,process.env.SOURCE_SHA,process.env.TARGET);
 }catch(error){report={ok:false,reason:/^[a-z,-]+$/.test(error?.message)?error.message:'smoke-failed'};process.exitCode=1;}
 await writeFile(receiptPath,JSON.stringify(report,null,2));
 console.log(report.ok?'Editor smoke passed':'Editor smoke failed');
}
