// Backend scheduling proof: actual runIndex + real DO SQLite, not a fake budget.
// Rust resources()/DoIndex::run are synchronous; these are its exact SQL queries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const root = fileURLToPath(new URL("../", import.meta.url));
const rust = readFileSync(new URL("../../../crates/store-file/src/sql.rs", import.meta.url), "utf8");
const literal = prefix => JSON.parse([...rust.matchAll(/"([^"\n]*)"/g)].map(m => m[0]).find(s => JSON.parse(s).startsWith(prefix)));
const queries = [literal("SELECT path, length(CAST(doc AS BLOB))"), literal("SELECT path, doc FROM st_res WHERE path >=")];
const compiled = await build({ stdin: { resolveDir: root, contents: `
import { DurableObject } from "cloudflare:workers";
import { runIndex } from "./src/sql.ts";
const [metadata,group] = ${JSON.stringify(queries)};
const magic=[77,68,66,73,68,88,0,1], enc=new TextEncoder(), dec=new TextDecoder();
const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return [...b];};
const data=s=>{const b=enc.encode(s);return [...u32(b.length),...b];};
function read(storage,sql,params=[]){
 const bytes=runIndex(storage,Uint8Array.from([...magic,0,1,...u32(1),...data(sql),...u32(params.length),...params.flatMap(s=>[3,...data(s)])]));
 if(bytes[8]!==2)throw Error("actual index reply refused");
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let at=13;
 const columns=v.getUint32(at,true);at+=20;const n=v.getUint32(at,true);at+=4;
 const values=[];for(let i=0;i<n;i++){const tag=bytes[at++];if(tag===1){values.push(Number(v.getBigInt64(at,true)));at+=8;}else if(tag===3){const len=v.getUint32(at,true);at+=4;values.push(dec.decode(bytes.subarray(at,at+len)));at+=len;}else throw Error("unexpected value");}
 if(at!==bytes.length)throw Error("reply not fully consumed");
 return Array.from({length:values.length/columns},(_,i)=>values.slice(i*columns,(i+1)*columns));
}
export class Probe extends DurableObject {
 async fetch(request){
  const sql=this.ctx.storage.sql, trace=[];sql.exec("CREATE TABLE st_res(path TEXT PRIMARY KEY,doc TEXT)");
  this.ctx.storage.transactionSync(()=>{for(let i=0;i<80;i++)sql.exec("INSERT INTO st_res VALUES(?,?)",'r'+String(i).padStart(3,'0'),'x'.repeat(60000));});
  const inventory=read(this.ctx.storage,metadata);trace.push("metadata");
  // Earliest possible same-owner writer: queued BEFORE any range SELECT.
  let written=false;const writer=new Promise(resolve=>queueMicrotask(()=>{sql.exec("UPDATE st_res SET doc=?",'y'.repeat(60001));written=true;trace.push("write");resolve();}));
  const unsafe=new URL(request.url).searchParams.has("yield");if(unsafe)await writer;
  let matched=true,groups=0;
  for(let start=0;start<inventory.length;){let end=start+1,bytes=inventory[start][1]+inventory[start][0].length+16;
   while(end<inventory.length&&bytes+inventory[end][1]+inventory[end][0].length+16<=(2<<20)){bytes+=inventory[end][1]+inventory[end][0].length+16;end++;}
   const rows=read(this.ctx.storage,group,[inventory[start][0],inventory[end-1][0]]);
   matched&&=rows.length===end-start&&rows.every(([path,doc],i)=>path===inventory[start+i][0]&&enc.encode(doc).length===inventory[start+i][1]&&doc[0]==='x');
   trace.push("group");groups++;start=end;
  }
  const writtenBeforeReturn=written;trace.push("read-return");await writer;
  const after=read(this.ctx.storage,metadata);
  return Response.json({matched,groups,writtenBeforeReturn,trace,after:after.every(([,n])=>n===60001)});
 }
}
export default{fetch(r,e){return e.PROBE.getByName(new URL(r.url).pathname).fetch(r);}};
` }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });

test("resource groups share one DO synchronous view; a queued writer cannot interleave", async () => {
  const prefix = fileURLToPath(new URL("../.test-state/resource-isolation-", import.meta.url));
  mkdirSync(dirname(prefix), { recursive: true });
  const scratch = mkdtempSync(prefix), old = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "resource-isolation", modules: true,
    script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05", port: 0,
    durableObjects: { PROBE: { className: "Probe", useSQLite: true } },
    resourcePersistencePath: scratch, resourceTmpPath: scratch }));
  let passed = false;
  try {
    const call = async path => { const r = await mf.dispatchFetch("http://fixture.test" + path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
    assert.deepEqual(await call("/safe"), { matched: true, groups: 3, writtenBeforeReturn: false,
      trace: ["metadata", "group", "group", "group", "read-return", "write"], after: true });
    // Meaningful negative control: inserting a yield breaks the read view.
    assert.deepEqual(await call("/unsafe?yield"), { matched: false, groups: 3, writtenBeforeReturn: true,
      trace: ["metadata", "write", "group", "group", "group", "read-return"], after: true });
    passed = true;
  } finally {
    await mf.dispose();
    if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old;
    if (passed) rmSync(scratch, { recursive: true }); else console.error(`Retained resource-isolation fixture: ${scratch}`);
  }
});
