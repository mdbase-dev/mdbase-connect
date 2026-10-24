// Cold actual-WASM ABI/host bridge only. No FULL positive ABI/DO/runtime evidence.
// Use a freshly built artifact, never the deployment's stale binary.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
const file=process.env.HOSTED_WASM;
if(!file) throw new Error("HOSTED_WASM required");
const bytes=await readFile(resolve(file));
const module=new WebAssembly.Module(bytes);
assert.ok(WebAssembly.Module.exports(module).some(e=>e.name==="hd_pitr_app_query" && e.kind==="function"));
const result=await build({entryPoints:[new URL("../src/engine.ts",import.meta.url).pathname],bundle:true,write:false,format:"esm",platform:"node",plugins:[{
  name:"actual-native",setup(b){b.onLoad({filter:/hosted\.wasm$/},()=>({contents:`export default new WebAssembly.Module(Uint8Array.from(Buffer.from('${bytes.toString("base64")}','base64')));`}));},
}]});
const {Engine,encode}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
let sql=0,cp=0;
const e=new Engine({sql:{exec(){sql++;throw new Error("unexpected cold SQL");}},transactionSync(){sql++;throw new Error("unexpected cold transaction");}});
const claims=encode([...Array.from({length:5},()=>new Uint8Array(16).fill(1)),...Array.from({length:5},()=>new Uint8Array(32).fill(2)),3]);
assert.equal(e.pitrAppQuery(1,claims),null,"claims cannot construct cold caller/Engine context");
assert.equal(e.pitrAppQuery(0xffffffff,claims),null,"fabricated handle refuses");
assert.equal(e.pitrAppQuery(1,encode([])),null);
assert.equal(e.pitrAppQuery(1,new Uint8Array(513)),null);
await assert.rejects(e.assertPitrAppCurrent(1,claims,{async assertPitrCurrentAppGrant(){cp++;}},new AbortController().signal),/pitr_app_current_not_established/);
assert.equal(sql,0);assert.equal(cp,0);
console.log(JSON.stringify({scope:"COLD actual WASM ABI/host only; not FULL positive/runtime/GO",cases:5,sql,cp,export:"hd_pitr_app_query"}));
