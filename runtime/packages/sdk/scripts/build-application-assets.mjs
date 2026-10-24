#!/usr/bin/env node
/** BUILD-only packaging. Paths are custody inputs, not release/context overrides.
 * Only the fixed authenticated LAB trust context is packaged.
 * No production context, time override, renewal, network or signing exists here. */
import {createHash} from "node:crypto";
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {buildAppTrust} from "./build-app-trust.mjs";
const directory=fileURLToPath(new URL("..",import.meta.url));
const context=Object.freeze({environment:"lab",cpOrigin:"https://connect-lab.mdbase.dev",logOrigin:"https://mdbase-next-log-lab-20261005.callumalpass.workers.dev",sha256:"88fe5249be83d7db9999d88d4f62acaca79e8bdcabe2c9f236e2942014de3334",sourceCommit:"8a014fe2abd2d9c6a8b1ed3e77c35cfda3392d3e",sourceVersion:"0.1.0-beta.129"});
// The selector and packaging verifier consume the same committed pins. Never
// introduce a second hash list here: mismatches must fail the byte check below.
const pins=JSON.parse(readFileSync(join(directory,"src/application/asset-pins.json"),"utf8"));
const refusal=()=>new Error("SDK application packaging refused");
function checked(path,sha256,bytes){const value=readFileSync(path);if(value.length!==bytes&&bytes!==undefined||createHash("sha256").update(value).digest("hex")!==sha256)throw refusal();return value;}

/** BUILD-only intake: package metadata does not authenticate installed bytes.
 * Verify BOTH browser initializer and WASM; never return an unchecked path for
 * a later copy. Pins are from the same source-qualified official locked package,
 * not a second signer or a claim of independently signed authentication. */
export function readPackagedSqlite(sdkDirectory=directory) {
  try {
    const require=createRequire(join(sdkDirectory,"package.json"));
    const sqliteDirectory=dirname(require.resolve("@sqlite.org/sqlite-wasm"));
    const sqlitePackage=JSON.parse(readFileSync(join(sqliteDirectory,"../package.json"),"utf8"));
    const lock=JSON.parse(readFileSync(join(sdkDirectory,"package-lock.json"),"utf8"));
    if(sqlitePackage.version!=="3.53.4-build2"||lock.packages["node_modules/@sqlite.org/sqlite-wasm"]?.integrity!=="sha512-kQVArGJA4z7s56Dm8t+eTBXad4LiohuVj9pfgDNOcxa+Ic5xMrWlLPTq6cT0hw5S4MIvtpsraW+B0wD+IPvC7A==")throw refusal();
    return Object.freeze({
      wasm:checked(join(sqliteDirectory,"sqlite3.wasm"),pins.sqlite.sha256,pins.sqlite.bytes),
      initializer:checked(join(sqliteDirectory,"index.mjs"),pins.sqlite.initializer.sha256,pins.sqlite.initializer.bytes)
    });
  } catch {throw refusal();}
}
/** Input file supplies ONLY the three existing local custody paths. Authentication
 * is the fixed release-selected tool/context above, not caller manifest fields. */
export function buildApplicationAssets(inputFile,{sdkDirectory=directory}={}) {
  let stage;
  try {
    const input=JSON.parse(readFileSync(inputFile,"utf8"));
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(",")!=="asset,native,verifier"||Object.values(input).some(x=>typeof x!=="string"||!x.length))throw refusal();
    const paths=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,resolve(dirname(resolve(inputFile)),v)]));
    checked(paths.verifier,"470d30742adf46db736706f6db9c92e969b995ad6b726508fcb29002eac2b677");
    checked(paths.asset,context.sha256,876);
    const runtimeBytes=checked(paths.native,pins.runtime.sha256,pins.runtime.bytes);
    const sqlite=readPackagedSqlite(sdkDirectory);
    const dist=join(sdkDirectory,"dist");mkdirSync(dist,{recursive:true});
    stage=mkdtempSync(join(sdkDirectory,".application-assets-"));
    const generated=join(stage,"packaged-trust.mjs");
    buildAppTrust({...context,verifier:paths.verifier,asset:paths.asset,output:generated}); // default expiry ONLY
    writeFileSync(join(stage,"runtime-lab.wasm"),runtimeBytes,{flag:"wx"});
    writeFileSync(join(stage,"sqlite3.wasm"),sqlite.wasm,{flag:"wx"});
    writeFileSync(join(stage,"sqlite3.js"),sqlite.initializer,{flag:"wx"}); // pinned official browser bytes, never node.mjs
    writeFileSync(join(stage,"provenance.lab.json"),JSON.stringify({schema:"mdbn-sdk/application-assets/1",environment:"lab",trust:context,verifier:{source:"6f7b28fc39a58ef08e083d71407c9e28a8ed0e7f",sha256:"470d30742adf46db736706f6db9c92e969b995ad6b726508fcb29002eac2b677",clockOverride:false},runtime:{...pins.runtime,qualification:"integrity-pinned, not separately signed"},sqlite:{...pins.sqlite,package:"@sqlite.org/sqlite-wasm",version:"3.53.4-build2",qualification:"integrity-pinned, not separately signed"}},null,2)+"\n",{flag:"wx"});
    // A failed verifier never replaces the refusal module or an old release.
    mkdirSync(join(dist,"native"),{recursive:true});mkdirSync(join(dist,"application"),{recursive:true});
    for(const name of ["runtime-lab.wasm","sqlite3.wasm","sqlite3.js","provenance.lab.json"])copyFileSync(join(stage,name),join(dist,"native",name));
    renameSync(generated,join(dist,"application","packaged-trust.js"));
    return Object.freeze({environment:"lab",runtime:pins.runtime,sqlite:pins.sqlite});
  } catch { throw refusal(); }
  finally {if(stage)rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {const input=process.env.MDBASE_SDK_APPLICATION_INPUTS;if(input)buildApplicationAssets(input);else if(!existsSync(join(directory,"dist/application/packaged-trust.js")))throw refusal();}
  catch {console.error("SDK application packaging refused");process.exitCode=1;}
}
