// Real sqlite-wasm/sahpool smoke in a fresh local browser context.
// No app accounts, Connect services, existing profiles, or production access.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "@playwright/test");
const assets = new Map();
for (const name of ["appSqliteIndex.js", "appIndexHost.js", "sqliteIndex.js"]) {
  assets.set(`/${name}`, { type: "text/javascript", bytes: await readFile(new URL(`../dist/index/${name}`, import.meta.url)) });
}
for (const name of ["index.mjs", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) {
  assets.set(`/${name}`, { type: name.endsWith(".wasm") ? "application/wasm" : "text/javascript", bytes: await readFile(new URL(`../node_modules/@sqlite.org/sqlite-wasm/dist/${name}`, import.meta.url)) });
}
const worker = `
import init from '/index.mjs';
import { AppBinaryIndexHost, openAppSahpoolIndex } from '/appSqliteIndex.js';
const scope={account:'00000000-0000-4000-8000-000000000001',installation:'00000000-0000-4000-8000-000000000002',collection:'00000000-0000-4000-8000-000000000003'};
let sqlite, state, host;
const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return [...b];};
const data=b=>[...u32(b.length),...b];
const utf8=new TextEncoder();
const param=p=>{
 if(p.kind==='Integer'){const b=new Uint8Array(8);new DataView(b.buffer).setBigInt64(0,p.value,true);return [1,...b];}
 if(p.kind==='Text')return [3,...data(utf8.encode(p.value))];
 throw Error('unsupported smoke value');
};
const run=(batch)=>{
 const bytes=Uint8Array.from([...utf8.encode('MDBIDX\\0\\x01'),0,batch.mode==='Transaction'?0:1,...u32(batch.stmts.length),
  ...batch.stmts.flatMap(s=>[...data(utf8.encode(s.sql)),...u32(s.params.length),...s.params.flatMap(param)])]);
 const reply=host.run(bytes);
 if(reply[8]!==2)throw Error('binary SQL smoke operation failed');
 return reply;
};
const query=sql=>{
 const reply=run({mode:'Autocommit',stmts:[{sql,params:[]}]});
 const view=new DataView(reply.buffer,reply.byteOffset,reply.byteLength);
 if(view.getUint32(9,true)!==1||view.getUint32(13,true)!==1||view.getUint32(33,true)!==1)throw Error('binary SQL smoke cardinality');
 if(reply[37]===1)return view.getBigInt64(38,true);
 if(reply[37]===3)return new TextDecoder().decode(reply.subarray(42,42+view.getUint32(38,true)));
 throw Error('binary SQL smoke value');
};
onmessage=async ({data:m})=>{
 try {
  let value;
  if(m.op==='open') {
   const start=performance.now();
   sqlite ??= await init({print:()=>{},printErr:()=>{}});
   state=await openAppSahpoolIndex(sqlite,scope);
   host=new AppBinaryIndexHost(state.index);
   value={opened:state.index.info.opened,durability:state.index.info.durability,openMs:performance.now()-start,synchronous:Number(query('PRAGMA synchronous')),journal:query('PRAGMA journal_mode'),locking:query('PRAGMA locking_mode')};
  } else if(m.op==='fill') {
   const start=performance.now();
   run({mode:'Transaction',stmts:[{sql:'CREATE TABLE IF NOT EXISTS _app_probe_tasks(id INTEGER PRIMARY KEY,body TEXT)',params:[]}]});
   for(let offset=0;offset<m.count;offset+=100) {
    const stmts=[];
    for(let i=offset;i<Math.min(m.count,offset+100);i++) stmts.push({sql:'INSERT OR REPLACE INTO _app_probe_tasks VALUES (?,?)',params:[{kind:'Integer',value:BigInt(i)},{kind:'Text',value:'fixture task '+i}]});
    run({mode:'Transaction',stmts});
   }
   value={rows:Number(query('SELECT count(*) FROM _app_probe_tasks')),writeMs:performance.now()-start};
  } else if(m.op==='count') value={rows:Number(query('SELECT count(*) FROM _app_probe_tasks'))};
  else if(m.op==='close') { state.index.close(); state.pool.pauseVfs(); state=null; value={closed:true}; }
  else throw Error('unsupported smoke command');
  postMessage({id:m.id,value});
 } catch(error) { postMessage({id:m.id,error:true,kind:error.kind??'Other'}); }
};
`;
assets.set("/worker.js", { type: "text/javascript", bytes: worker });
const server = createServer((req, res) => {
  const asset = assets.get(req.url);
  res.setHeader("Content-Type", asset?.type ?? "text/html");
  res.end(asset?.bytes ?? "<!doctype html><title>isolated app SQLite smoke</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(async () => {
    let worker, id = 0;
    const startWorker = () => { worker = new Worker("/worker.js", { type: "module" }); };
    const call = (op, count) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { worker.terminate(); reject(new Error("SQLite smoke timed out")); }, 15000);
      worker.onmessage = ({ data }) => {
        if (data.id !== requestId) return;
        clearTimeout(timer);
        data.error ? reject(Object.assign(new Error("SQLite smoke operation failed"), { kind: data.kind })) : resolve(data.value);
      };
      worker.onerror = () => { clearTimeout(timer); reject(new Error("SQLite smoke Worker failed")); };
      worker.postMessage({ id: requestId, op, count });
    });
    const results = [];
    try {
      for (const size of [1000, 5000, 20000]) {
        startWorker();
        const open = await call("open");
        let secondOpener = null;
        if (size === 1000) {
          const owner = worker;
          startWorker();
          try { await call("open"); throw new Error("second writer unexpectedly opened"); }
          catch (error) { if (error.kind !== "Busy") throw error; secondOpener = "Busy"; }
          finally { worker.terminate(); worker = owner; }
        }
        const fill = await call("fill", size);
        worker.terminate(); // unclean stop after commit, no close/clean flag
        startWorker();
        const recovered = await call("open");
        const readback = await call("count");
        if (readback.rows !== size || recovered.opened !== "Unclean" || recovered.durability !== "Disposable") throw new Error("unclean readback mismatch");
        await call("close"); worker.terminate();
        startWorker();
        const clean = await call("open");
        if (clean.opened !== "Existing") throw new Error("clean reopen mismatch");
        await call("close"); worker.terminate();
        results.push({ size, open, secondOpener, fill, recovered, readback, clean });
      }
      return results;
    } finally { worker?.terminate(); }
  });
  console.log(JSON.stringify({ browser: browser.version(), sqlite: "3.53.4-build2", sqlBoundary: "MDBIDX-v1", crashDurability: "unqualified", results }));
  await context.close();
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
