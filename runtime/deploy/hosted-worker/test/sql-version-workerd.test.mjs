// Real DO SQLite: file-header pragmas are denied; logical versioning must remain
// persisted and atomic with the store DDL, not become a catch-and-guess fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = await build({ stdin: { resolveDir: root, contents: `
import { DurableObject } from "cloudflare:workers";
import { runIndex } from "./src/sql.ts";
const magic=[77,68,66,73,68,88,0,1], enc=new TextEncoder();
const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return [...b];};
function run(storage,statements,mode=0){
 const request=Uint8Array.from([...magic,0,mode,...u32(statements.length),...statements.flatMap(sql=>{
  const b=enc.encode(sql);return [...u32(b.length),...b,...u32(0)];
 })]);
 const bytes=runIndex(storage,request),op=bytes[8];if(op!==2)return {op};
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),values=[],columns=[];let at=13;
 for(let i=0;i<statements.length;i++){
  columns.push(view.getUint32(at,true));at+=20;const count=view.getUint32(at,true);at+=4;const row=[];
  for(let j=0;j<count;j++){if(bytes[at++]!==1)throw Error("unexpected value");row.push(Number(view.getBigInt64(at,true)));at+=8;}
  values.push(row);
 }
 if(at!==bytes.length)throw Error("trailing reply");return {op,columns,values};
}
export class Probe extends DurableObject {
 fetch(request){
  const storage=this.ctx.storage,sql=storage.sql,action=new URL(request.url).pathname;
  if(action==="/seed"){
   let denied=false;try{sql.exec("PRAGMA user_version");}catch(e){denied=/SQLITE_AUTH/.test(String(e));}
   sql.exec("CREATE TABLE st_pending(k INTEGER PRIMARY KEY,b BLOB)");sql.exec("INSERT INTO st_pending VALUES(0,x'010203')");
   return Response.json({denied});
  }
  if(action==="/migrate"||action==="/fail")return Response.json(run(storage,[
   "CREATE TABLE st_upgrade_probe(k INTEGER)","PRAGMA user_version=1",
   ...(action==="/fail"?["INSERT INTO missing_schema_migration_table VALUES(1)"]:[])
  ]));
  if(action==="/future")return Response.json(run(storage,["PRAGMA user_version=2"],1));
  if(action==="/corrupt")sql.exec("DELETE FROM st_schema");
  return Response.json({version:run(storage,["PRAGMA user_version"],1),
   schema:sql.exec("SELECT name FROM sqlite_master WHERE name='st_schema'").toArray().length,
   proof:sql.exec("SELECT name FROM sqlite_master WHERE name='st_upgrade_probe'").toArray().length,
   pending:sql.exec("SELECT hex(b) AS bytes FROM st_pending WHERE k=0").one().bytes});
 }
}
export default{fetch(r,e){return e.PROBE.getByName("one-store").fetch(r);}};
` }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });

test("DO schema floor survives reopen; migration DDL/stamp roll back together without reset", async () => {
  const prefix = fileURLToPath(new URL("../.test-state/schema-version-", import.meta.url));
  mkdirSync(dirname(prefix), { recursive: true });
  const scratch = mkdtempSync(prefix), old = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const open = () => new Miniflare(convertV4MiniflareOptions({ name: "schema-version", modules: true,
    script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05", port: 0,
    durableObjects: { PROBE: { className: "Probe", useSQLite: true } },
    resourcePersistencePath: scratch, resourceTmpPath: scratch }));
  let mf = open(), passed = false;
  const call = async path => {
    const response = await mf.dispatchFetch("http://fixture.test" + path);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const expected = (version, schema, proof) => ({ version: {op: 2, columns: [1], values: [[version]]}, schema, proof, pending: "010203" });
  try {
    assert.deepEqual(await call("/seed"), {denied: true}, "genuine sandbox restriction, not a fake SQL host");
    assert.deepEqual(await call("/state"), expected(0, 0, 0), "legacy floor read must do no DDL");
    assert.equal((await call("/fail")).op, 3);
    assert.deepEqual(await call("/state"), expected(0, 0, 0), "failed migration preserves old schema and pending bytes");
    assert.equal((await call("/migrate")).op, 2);
    assert.deepEqual(await call("/state"), expected(1, 1, 1));
    await mf.dispose();
    mf = open();
    assert.deepEqual(await call("/state"), expected(1, 1, 1), "floor is in SQL, not an isolate variable");
    assert.equal((await call("/future")).op, 2);
    assert.deepEqual(await call("/state"), expected(2, 1, 1), "newer floor reaches Rust unchanged");
    assert.deepEqual(await call("/corrupt"), { ...expected(2, 1, 1), version: {op: 2, columns: [1], values: [[]]} }, "bad existing row is NOT guessed as legacy zero");
    passed = true;
  } finally {
    await mf.dispose();
    if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old;
    if (passed) rmSync(scratch, {recursive: true}); else console.error(`Retained schema-version fixture: ${scratch}`);
  }
});
