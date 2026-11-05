// Workflow-owned browser driver. Only public served application code runs in Chromium.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const origin='https://editor.mdbase.dev';
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
export function assertEntryAsset(url,source) {
 need(/^[a-f0-9]{40}$/.test(source??''),'invalid-source');
 const asset=new URL(url);
 need(asset.origin===origin && new RegExp(`^/assets/[^/]+-${source.slice(0,12)}\\.js$`).test(asset.pathname),'entry-source-mismatch');
}
export async function smoke(chromium,source) {
 const browser=await chromium.launch({headless:true});
 const failures=new Set();
 try {
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
  const response=await page.goto(origin+'/',{waitUntil:'networkidle',timeout:90000});
  need(response?.status()===200,'entry-unavailable');
  const entries=await page.locator('script[type="module"][src]').evaluateAll(nodes=>nodes.map(node=>node.src));
  need(entries.length===1,'entry-asset-required');
  assertEntryAsset(entries[0],source);
  const entry=await context.request.get(entries[0]);
  need(entry.ok() && (await entry.body()).length>0,'entry-asset-unavailable');
  await page.getByRole('button',{name:'Sign in',exact:true}).waitFor({state:'visible',timeout:60000});
  need(!/readiness_fenced/i.test(await page.locator('body').innerText()),'readiness-fenced');
  need(failures.size===0,[...failures].sort().join(','));
  return {ok:true,source:source.slice(0,12),signIn:true,cacheDisabled:true};
 }finally{await browser.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [toolPath,receiptPath]=process.argv.slice(2);
 let report;
 try {
  const {chromium}=await import(pathToFileURL((await readFile(toolPath,'utf8')).trim()).href);
  report=await smoke(chromium,process.env.SOURCE_SHA);
 }catch{report={ok:false,reason:'production-smoke-failed'};process.exitCode=1;}
 await writeFile(receiptPath,JSON.stringify(report,null,2));
 console.log(report.ok?'Production smoke passed':'Production smoke failed');
}
