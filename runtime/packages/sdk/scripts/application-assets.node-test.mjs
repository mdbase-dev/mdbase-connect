import assert from "node:assert/strict";
import {test} from "node:test";
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {buildApplicationAssets,readPackagedSqlite} from "./build-application-assets.mjs";
import {buildApplicationWorker} from "./build-browser.mjs";
const directory=fileURLToPath(new URL("..",import.meta.url));

test("actual SDK Worker bundles its canonical parser, loading the pinned official browser SQLite only by URL",async()=>{
  const result=await buildApplicationWorker({write:false});
  assert(result,"the real SDK Worker source must be present");
  // One self-contained file: apps re-bundle it, and a default Vite consumer
  // (iife workers) fails on any dynamic import or split chunk.
  const outputs=Object.entries(result.metafile.outputs);
  assert.deepEqual(outputs.map(([path])=>path),["dist/application/worker.js"]);
  assert.deepEqual(outputs[0][1].imports,[]);
  const inputs=Object.keys(result.metafile.inputs);
  for(const path of ["src/application/worker.ts","src/application/worker-host.ts","src/application/worker-session.ts","src/application/packaged-assets.ts","@mdbase-dev/connect-protocol/dist/manifest.js"]){
    assert(inputs.some(input=>input.endsWith(path)),path);
  }
  assert(!inputs.some(input=>input.includes("@sqlite.org/sqlite-wasm/")));
  for(const file of result.outputFiles)assert(!file.text.includes("node:crypto"),file.path);
});
const officialDirectory=dirname(createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm"));
const sqliteIntegrity="sha512-kQVArGJA4z7s56Dm8t+eTBXad4LiohuVj9pfgDNOcxa+Ic5xMrWlLPTq6cT0hw5S4MIvtpsraW+B0wD+IPvC7A==";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
function sqliteFixture(){
  const root=fixture();
  const pkg=join(root,"node_modules/@sqlite.org/sqlite-wasm");
  mkdirSync(join(pkg,"dist"),{recursive:true});
  writeFileSync(join(pkg,"package.json"),JSON.stringify({version:"3.53.4-build2",exports:"./dist/node.mjs",type:"module"}));
  writeFileSync(join(pkg,"dist/node.mjs"),"throw new Error('Node initializer must never execute');");
  for(const name of ["index.mjs","sqlite3.wasm","sqlite3-opfs-async-proxy.js"])copyFileSync(join(officialDirectory,name),join(pkg,"dist",name));
  writeFileSync(join(root,"package-lock.json"),JSON.stringify({packages:{"node_modules/@sqlite.org/sqlite-wasm":{integrity:sqliteIntegrity}}}));
  return {root,pkg};
}
function fixture(){const root=mkdtempSync(join(directory,".application-assets-test-"));mkdirSync(join(root,"dist/application"),{recursive:true});writeFileSync(join(root,"dist/application/packaged-trust.js"),"original refusal");return root;}
for(const value of [null,[],{}, {asset:"x",native:"x",verifier:"x",nowMs:0}, {asset:"x",native:"x",verifier:"x",environment:"production"}, {asset:1,native:"x",verifier:"x"}]){
  test(`rejects invalid custody input ${JSON.stringify(value)} without changing old output`,()=>{const root=fixture();try{const input=join(root,"input.json");writeFileSync(input,JSON.stringify(value));assert.throws(()=>buildApplicationAssets(input,{sdkDirectory:root}),/^Error: SDK application packaging refused$/);assert.equal(readFileSync(join(root,"dist/application/packaged-trust.js"),"utf8"),"original refusal");}finally{rmSync(root,{recursive:true,force:true});}});
}
test("untrusted successful executable is not a replacement verifier",()=>{const root=fixture();try{const verifier=join(root,"verifier");writeFileSync(verifier,"#!/bin/sh\necho forged\n",{mode:0o755});const input=join(root,"input.json");writeFileSync(input,JSON.stringify({asset:"missing",native:"missing",verifier}));assert.throws(()=>buildApplicationAssets(input,{sdkDirectory:root}),/^Error: SDK application packaging refused$/);assert.equal(readFileSync(join(root,"dist/application/packaged-trust.js"),"utf8"),"original refusal");}finally{rmSync(root,{recursive:true,force:true});}});

test("captures exact official browser initializer, WASM and async proxy, without executing Node glue",()=>{
  const {root,pkg}=sqliteFixture();
  try {
    const assets=readPackagedSqlite(root);
    assert.equal(assets.initializer.length,642742);
    assert.equal(digest(assets.initializer),"a6d3fe46aa3f924e7686329f97b0564549ef1f787e0c19924179aef7f72bcc01");
    assert.equal(assets.wasm.length,868907);
    assert.equal(digest(assets.wasm),"2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752");
    assert.equal(assets.asyncProxy.length,32505);
    assert.equal(digest(assets.asyncProxy),"9f1970e05ee07a79332498858740b705eeb1dcee03bc150f6f690bc0fb5f0a06");
    assert(Object.isFrozen(assets));
    // Packaging consumes these verified snapshots, not files reopened after the
    // canonical verifier process. A later file change cannot change the snapshot.
    writeFileSync(join(pkg,"dist/index.mjs"),"changed after intake");
    writeFileSync(join(pkg,"dist/sqlite3.wasm"),"changed after intake");
    assert.equal(digest(assets.initializer),"a6d3fe46aa3f924e7686329f97b0564549ef1f787e0c19924179aef7f72bcc01");
    assert.equal(digest(assets.wasm),"2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752");
  } finally {rmSync(root,{recursive:true,force:true});}
});
for(const file of ["index.mjs","sqlite3.wasm","sqlite3-opfs-async-proxy.js"]){
  test(`refuses same-length changed ${file} despite correct version and locked SRI`,()=>{
    const {root,pkg}=sqliteFixture();
    try {
      const path=join(pkg,"dist",file),bytes=readFileSync(path);
      bytes[20]^=1;writeFileSync(path,bytes);
      assert.throws(()=>readPackagedSqlite(root),/^Error: SDK application packaging refused$/);
      assert.equal(readFileSync(join(root,"dist/application/packaged-trust.js"),"utf8"),"original refusal");
    } finally {rmSync(root,{recursive:true,force:true});}
  });
}
test("refuses a missing async proxy rather than producing an incomplete distribution",()=>{
  const {root,pkg}=sqliteFixture();
  try {
    rmSync(join(pkg,"dist/sqlite3-opfs-async-proxy.js"));
    assert.throws(()=>readPackagedSqlite(root),/^Error: SDK application packaging refused$/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
for(const kind of ["version","lock"]){
  test(`refuses ${kind} drift even with correct installed browser bytes`,()=>{
    const {root,pkg}=sqliteFixture();
    try {
      if(kind==="version")writeFileSync(join(pkg,"package.json"),JSON.stringify({version:"3.53.4-build3",exports:"./dist/node.mjs"}));
      else writeFileSync(join(root,"package-lock.json"),JSON.stringify({packages:{"node_modules/@sqlite.org/sqlite-wasm":{integrity:"unqualified"}}}));
      assert.throws(()=>readPackagedSqlite(root),/^Error: SDK application packaging refused$/);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
}
