#!/usr/bin/env node
/** BUILD-only packaging. Paths are custody inputs, not release/context overrides.
 * Release context MUST come from the independently authenticated pipeline,
 * never from the candidate asset. No time override, network or signing. */
import {createHash} from "node:crypto";
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {buildAppTrust} from "./build-app-trust.mjs";
import {readReleaseBuild} from "../../../scripts/lib/read-release-trust.mjs";
const directory=fileURLToPath(new URL("..",import.meta.url));
// The selector and packaging verifier consume the same committed pins. Never
// introduce a second hash list here: mismatches must fail the byte check below.
const pins=JSON.parse(readFileSync(join(directory,"src/application/asset-pins.json"),"utf8"));
const refusal=()=>new Error("SDK application packaging refused");
function checked(path,sha256,bytes){const value=readFileSync(path);if(value.length!==bytes&&bytes!==undefined||createHash("sha256").update(value).digest("hex")!==sha256)throw refusal();return value;}

/** BUILD-only intake: package metadata does not authenticate installed bytes.
 * Verify browser initializer, WASM and async proxy; never return an unchecked path for
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
      initializer:checked(join(sqliteDirectory,"index.mjs"),pins.sqlite.initializer.sha256,pins.sqlite.initializer.bytes),
      asyncProxy:checked(join(sqliteDirectory,"sqlite3-opfs-async-proxy.js"),pins.sqlite.asyncProxy.sha256,pins.sqlite.asyncProxy.bytes)
    });
  } catch {throw refusal();}
}
/** Four custody paths. Context/proofs come from the completed Ops verifier
 * output; receipt/verifier identity from the qualified SDK build, not the asset. */
export function buildApplicationAssets(inputFile,{sdkDirectory=directory}={}) {
  let stage;
  try {
    const input=JSON.parse(readFileSync(inputFile,"utf8"));
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(",")!=="context,native,receipt,verifier"||Object.values(input).some(x=>typeof x!=="string"||!x.length))throw refusal();
    const paths=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,resolve(dirname(resolve(inputFile)),v)]));
    const context=readReleaseBuild(paths.context,paths.receipt);
    // All managed application environments use the same authenticated handoff.
    // Staging is its own release, never a LAB/production fallback or retarget.
    if(!["lab","staging","production"].includes(context.environment))throw refusal();
    const verifierBytes=checked(paths.verifier,context.verifierSha256);
    const assetBytes=checked(context.asset,context.sha256,context.assetBytes);
    const runtimePins=JSON.parse(readFileSync(join(sdkDirectory,"src/application/asset-pins.json"),"utf8")).runtime;
    const runtimeBytes=checked(paths.native,runtimePins.sha256,runtimePins.bytes);
    const sqlite=readPackagedSqlite(sdkDirectory);
    const dist=join(sdkDirectory,"dist");mkdirSync(dist,{recursive:true});
    stage=mkdtempSync(join(sdkDirectory,".application-assets-"));
    const generated=join(stage,"packaged-trust.mjs");
    // Execute and verify the exact snapshotted bytes, not paths reopened after
    // hashing. No expiry override and no production-to-LAB fallback.
    const verifier=join(stage,"mdbn-trust"),asset=join(stage,"trust.json");
    writeFileSync(verifier,verifierBytes,{flag:"wx",mode:0o700});chmodSync(verifier,0o700);
    writeFileSync(asset,assetBytes,{flag:"wx"});
    buildAppTrust({...context,verifier,asset,output:generated});
    writeFileSync(join(stage,"runtime.wasm"),runtimeBytes,{flag:"wx"});
    writeFileSync(join(stage,"sqlite3.wasm"),sqlite.wasm,{flag:"wx"});
    writeFileSync(join(stage,"sqlite3.js"),sqlite.initializer,{flag:"wx"});
    writeFileSync(join(stage,"sqlite3-opfs-async-proxy.js"),sqlite.asyncProxy,{flag:"wx"});
    writeFileSync(join(stage,"provenance.json"),JSON.stringify({
      schema:"mdbn-sdk/application-assets/1",environment:context.environment,
      trust:{environment:context.environment,cpOrigin:context.cpOrigin,logOrigin:context.logOrigin,
        sha256:context.sha256,sourceCommit:context.sourceCommit,sourceVersion:context.sourceVersion},
      handoff:{contextSha256:context.contextSha256,receiptSha256:context.receiptSha256,...context.provenance},
      verifier:{source:context.verifierSourceCommit,sha256:context.verifierSha256,clockOverride:false},
      runtime:{...runtimePins,qualification:"integrity-pinned, not separately signed"},
      sqlite:{...pins.sqlite,package:"@sqlite.org/sqlite-wasm",version:"3.53.4-build2",qualification:"integrity-pinned, not separately signed"}
    },null,2)+"\n",{flag:"wx"});
    // Install trust last: failed input/authentication never replaces old output.
    mkdirSync(join(dist,"native"),{recursive:true});mkdirSync(join(dist,"application"),{recursive:true});
    for(const name of ["runtime.wasm","sqlite3.wasm","sqlite3.js","sqlite3-opfs-async-proxy.js","provenance.json"])copyFileSync(join(stage,name),join(dist,"native",name));
    renameSync(generated,join(dist,"application","packaged-trust.js"));
    return Object.freeze({environment:context.environment,runtime:runtimePins,sqlite:pins.sqlite});
  } catch { throw refusal(); }
  finally {if(stage)rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {const input=process.env.MDBASE_SDK_APPLICATION_INPUTS;if(input)buildApplicationAssets(input);else if(!existsSync(join(directory,"dist/application/packaged-trust.js")))throw refusal();}
  catch {console.error("SDK application packaging refused: completed authenticated trust handoff, qualified build receipt, verifier and native runtime are required");process.exitCode=1;}
}
