// Exact production SQLite rollback intent/receipt plans on real workerd.
// SQL and storage.sync mechanics only: these fixture bytes are never authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const source = readFileSync(new URL("../../../crates/hosted-worker/src/migration_action_ledger/rollback.rs",import.meta.url),"utf8");
const receipt = readFileSync(new URL("../../../crates/hosted-worker/src/migration_rollback_receipt.rs",import.meta.url),"utf8");
const literal = (s,name) => JSON.parse(s.match(new RegExp(`const ${name}: &str = ("[^\"]*");`))[1].replaceAll("\n","\\n"));
const statement = (s,prefix) => JSON.parse([...s.matchAll(/"([^"\n]*)"/g)].map(m=>m[0]).find(v=>JSON.parse(v).startsWith(prefix)));
const plans = { context:literal(source,"CONTEXT"), receipt:literal(receipt,"TABLE"),
  baseline:statement(source,"INSERT INTO mig_checkpoint(k,v)"), guard:statement(source,"UPDATE mig_checkpoint SET v=CASE"),
  insert:statement(source,"INSERT INTO mig_native_rollback_context"), save:statement(source,"UPDATE mig_checkpoint SET v=?1"),
  original:statement(receipt,"INSERT INTO mig_rollback_receipt_data ("),
};
const script = `
import { DurableObject } from "cloudflare:workers";
const p=${JSON.stringify(plans)}, b=n=>new Uint8Array(16).fill(n);
export class Probe extends DurableObject {
 async fetch(request){const q=new URL(request.url).searchParams,sql=this.ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS mig_native_run(seq INTEGER PRIMARY KEY,driver BLOB)");
  sql.exec("CREATE TABLE IF NOT EXISTS mig_native_action(seq INTEGER PRIMARY KEY,driver BLOB,settled INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS mig_checkpoint(k INTEGER PRIMARY KEY CHECK(k=0),v BLOB NOT NULL)");
  sql.exec(p.context);sql.exec(p.receipt);
  const state=()=>({cp:Array.from(new Uint8Array(sql.exec("SELECT v FROM mig_checkpoint WHERE k=0").one().v)),contexts:sql.exec("SELECT count(*) AS n FROM mig_native_rollback_context").one().n,receipts:sql.exec("SELECT count(*) AS n FROM mig_rollback_receipt_data").one().n});
  if(q.get("op")==="seed"){sql.exec("INSERT INTO mig_native_run VALUES(1,?)",b(1));sql.exec("INSERT INTO mig_checkpoint VALUES(0,?)",new Uint8Array([1]));}
  if(q.get("op")==="request"){
   try{this.ctx.storage.transactionSync(()=>{let i=0;const apply=(s,...args)=>{sql.exec(s,...args);if(i++===Number(q.get("fault")))throw Error("interrupted");};
    apply(p.baseline,new Uint8Array([1]));apply(p.guard,new Uint8Array([1]),Number(q.get("expected")||1),b(1));apply(p.insert,b(1),b(2),"original-provider-stamp",40);apply(p.save,new Uint8Array([20]));
   });}catch(e){return Response.json({refused:true,...state()});}
  }
  if(q.get("op")==="receipt"){
   try{this.ctx.storage.transactionSync(()=>{
    sql.exec(p.original,b(3),b(2),b(1),b(4),17,40,b(5),b(6),new Uint8Array(),"2026-10-12T22:00:00Z");
    if(q.get("fault")==="0")throw Error("interrupted");
    sql.exec("UPDATE mig_checkpoint SET v=? WHERE k=0",new Uint8Array([21]));
    if(q.get("fault")==="1")throw Error("interrupted");
   });}catch(e){return Response.json({refused:true,...state()});}
  }
  await this.ctx.storage.sync();return Response.json(state());
 }
}
export default{fetch(request,env){return env.PROBE.getByName("fixture").fetch(request);}};
`;
test("rollback context/checkpoint and ORIGINAL receipt commit atomically across real reopen",async()=>{
 const prefix=fileURLToPath(new URL("../.test-state/rollback-sql-",import.meta.url));mkdirSync(dirname(prefix),{recursive:true});
 const scratch=mkdtempSync(prefix),old=process.env.TMPDIR;process.env.TMPDIR=scratch;
 const options=()=>convertV4MiniflareOptions({name:"rollback-sql",modules:true,script,compatibilityDate:"2026-10-05",port:0,durableObjects:{PROBE:{className:"Probe",useSQLite:true}},resourcePersistencePath:scratch,resourceTmpPath:scratch});
 let mf,passed=false;
 try{
  mf=new Miniflare(options());const call=async q=>{const r=await mf.dispatchFetch(`http://fixture.test/?${new URLSearchParams(q)}`);assert.equal(r.status,200,await r.clone().text());return r.json();};
  const initial=await call({op:"seed"});assert.deepEqual(initial,{cp:[1],contexts:0,receipts:0});
  for(let fault=0;fault<4;fault++)assert.deepEqual(await call({op:"request",fault}),{refused:true,...initial});
  assert.deepEqual(await call({op:"request",expected:2}),{refused:true,...initial});
  const requested=await call({op:"request",fault:-1});assert.deepEqual(requested,{cp:[20],contexts:1,receipts:0});
  await mf.dispose();mf=new Miniflare(options());assert.deepEqual(await call({}),requested);
  for(let fault=0;fault<2;fault++)assert.deepEqual(await call({op:"receipt",fault}),{refused:true,...requested});
  const completed=await call({op:"receipt",fault:-1});assert.deepEqual(completed,{cp:[21],contexts:1,receipts:1});
  await mf.dispose();mf=new Miniflare(options());assert.deepEqual(await call({}),completed);passed=true;
 }finally{await mf?.dispose();if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old;if(passed)rmSync(scratch,{recursive:true});else console.error(`Retained isolated rollback fixture: ${scratch}`);}
});
