// Test-only throwaway Ed25519 keys: never committed or written to disk.
// Synthetic proof stubs model byte custody AFTER Ops verification; these tests
// do not claim Sigstore/publisher/CI authentication or release qualification.
import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {build} from "esbuild";
import {buildApplicationAssets} from "./build-application-assets.mjs";
import {readReleaseBuild} from "../../../scripts/lib/read-release-trust.mjs";

const sdk=fileURLToPath(new URL("..",import.meta.url));
const verifier=resolve(process.env.MDBN_TRUST_VERIFIER ?? join(sdk,"../../target/debug/mdbn-trust"));
const sha=b=>createHash("sha256").update(b).digest();
const hex=b=>sha(b).toString("hex");
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const json=v=>JSON.stringify(sorted(v));
const cborBuild=await build({entryPoints:[join(sdk,"src/cbor.ts")],bundle:true,platform:"node",format:"esm",write:false});
const {encode}=await import("data:text/javascript;base64,"+Buffer.from(cborBuild.outputFiles[0].text).toString("base64"));
const publicBytes=key=>key.export({format:"der",type:"spki"}).subarray(-32);

function fixture(environment="production") {
  assert(existsSync(verifier),"Build the real mdbn-trust verifier first (or set MDBN_TRUST_VERIFIER)");
  const dir=mkdtempSync(join(sdk,".production-application-test-"));
  const root=generateKeyPairSync("ed25519"),policy=generateKeyPairSync("ed25519");
  const rootPk=publicBytes(root.publicKey),policyPk=publicBytes(policy.publicKey);
  const rootId=sha(rootPk).subarray(0,16),policyId=sha(policyPk).subarray(0,16);
  const now=Date.now()-1000,before=now-60_000,after=now+3_600_000;
  const tag=Buffer.from("mdbase/v1/cp-cert");
  const digest=sha(Buffer.concat([Buffer.from([tag.length]),tag,encode(new Map([[0,policyPk],[1,before],[2,after],[3,rootId]]))]));
  const payload={schema_version:1,environment,control_plane_origin:environment==="production"?"https://connect.mdbase.dev":environment==="staging"?"https://connect-staging.mdbase.dev":"https://connect-lab.mdbase.dev",log_origin:"https://log.example.test",issued_at:now,
    source:{repository:"mdbase-dev/mdbase-connect",commit:"a".repeat(40),version:"0.0.0-synthetic"},
    roots:[{key_id:rootId.toString("hex"),public_key:rootPk.toString("hex")}],
    policy_keys:[{key_id:policyId.toString("hex"),certificate:{policy_public_key:policyPk.toString("hex"),not_before:before,not_after:after,root_key_id:rootId.toString("hex"),signature:sign(null,digest,root.privateKey).toString("hex")}}]};
  const runtime=Buffer.from([0,97,115,109,1,0,0,0]);
  const pins=JSON.parse(readFileSync(join(sdk,"src/application/asset-pins.json"),"utf8"));
  pins.runtime={sha256:hex(runtime),bytes:runtime.length,maxBytes:runtime.length};
  const context={schema_version:1,kind:"mdbase-next-build-trust-context",
    context:{environment,control_plane_origin:payload.control_plane_origin,log_origin:payload.log_origin,sha256:hex(Buffer.from(json(payload))),source:payload.source},
    provenance:{asset_path:`next-trust/${environment}.json`,asset_length:Buffer.byteLength(json(payload)),proof_sha256:{},
      image_publication:{run_id:1,run_attempt:1},trust_publication:{run_id:2,run_attempt:1,publisher_commit:"c".repeat(40)},publisher_qualification:{run_id:3,run_attempt:1}}};
  const receipt={schema:"mdbn-sdk/application-build/1",contextSha256:"",verifierSha256:hex(readFileSync(verifier)),verifierSourceCommit:"b".repeat(40)};
  mkdirSync(join(dir,"src/application"),{recursive:true});mkdirSync(join(dir,"dist/application"),{recursive:true});
  mkdirSync(join(dir,"handoff/next-trust"),{recursive:true});
  writeFileSync(join(dir,"src/application/asset-pins.json"),JSON.stringify(pins));
  writeFileSync(join(dir,"package.json"),'{"type":"module"}');
  writeFileSync(join(dir,"package-lock.json"),readFileSync(join(sdk,"package-lock.json")));
  symlinkSync(join(sdk,"node_modules"),join(dir,"node_modules"),"dir");
  writeFileSync(join(dir,"dist/application/packaged-trust.js"),"original refusal");
  writeFileSync(join(dir,"runtime.wasm"),runtime);
  const input=join(dir,"input.json"),contextFile=join(dir,`handoff/next-trust/${environment}-context.json`),asset=join(dir,"handoff",context.provenance.asset_path);
  writeFileSync(input,JSON.stringify({context:contextFile,native:"runtime.wasm",verifier,receipt:"receipt.json"}));
  const save=()=>{
    const c=context.context,p=context.provenance;
    const image=Buffer.from(json({...c.source,publication:{runId:p.image_publication.run_id,runAttempt:p.image_publication.run_attempt}}));
    const inventory={schemaVersion:1,kind:"mdbase-release-trust-bundle",...c.source,
      imageBundle:{path:"image-release-bundle.json",length:image.length,sha256:hex(image),publicationRunId:p.image_publication.run_id,publicationRunAttempt:p.image_publication.run_attempt},
      publication:{workflow:"publish-images.yml",runId:p.trust_publication.run_id,runAttempt:p.trust_publication.run_attempt,publisherCommit:p.trust_publication.publisher_commit},
      qualification:{workflow:"server-ci.yml",runId:p.publisher_qualification.run_id,runAttempt:p.publisher_qualification.run_attempt},
      trustAssets:[{path:p.asset_path,length:p.asset_length,sha256:c.sha256,environment:c.environment,controlPlaneOrigin:c.control_plane_origin,logOrigin:c.log_origin,source:c.source}]};
    const proofs={"release-trust-bundle.json":Buffer.from(json(inventory)),"image-release-bundle.json":image,
      "release-trust-bundle.sigstore.json":Buffer.from('{"testOnly":"trust proof stub"}'),"image-release-bundle.sigstore.json":Buffer.from('{"testOnly":"image proof stub"}')};
    for(const [name,bytes] of Object.entries(proofs)){writeFileSync(join(dir,"handoff",name),bytes);p.proof_sha256[name]=hex(bytes);}
    const bytes=Buffer.from(JSON.stringify(sorted(context),null,2)+"\n");receipt.contextSha256=hex(bytes);
    writeFileSync(contextFile,bytes);writeFileSync(asset,json(payload));writeFileSync(join(dir,"receipt.json"),json(receipt));
  };
  save();
  const expireCertificate=()=>{
    const certificate=payload.policy_keys[0].certificate;
    certificate.not_before=now-180_000;certificate.not_after=now-120_000;
    const expired=sha(Buffer.concat([Buffer.from([tag.length]),tag,encode(new Map([[0,policyPk],[1,certificate.not_before],[2,certificate.not_after],[3,rootId]]))]));
    certificate.signature=sign(null,expired,root.privateKey).toString("hex");
    context.context.sha256=hex(Buffer.from(json(payload)));context.provenance.asset_length=Buffer.byteLength(json(payload));save();
  };
  return {dir,input,asset,contextFile,payload,context,receipt,pins,save,expireCertificate,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

async function selector(f,origin,trust) {
  const result=await build({entryPoints:[join(sdk,"src/application/packaged-assets.ts")],bundle:true,platform:"browser",format:"esm",write:false,
    define:{"import.meta.url":JSON.stringify(origin+"/sdk/application/packaged-assets.js")},
    plugins:[{name:"test-authenticated-build-output",setup(b){
      b.onResolve({filter:/^\.\/packaged-trust\.js$/},()=>({path:"trust",namespace:"fixture"}));
      b.onResolve({filter:/^\.\/asset-pins\.json$/},()=>({path:"pins",namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},args=>args.path==="trust"?{contents:trust}:{contents:JSON.stringify(f.pins),loader:"json"});
    }}]});
  return (await import("data:text/javascript;base64,"+Buffer.from(result.outputFiles[0].text).toString("base64"))).packagedApplicationAssets;
}

for(const environment of ["lab","staging","production"])test(`real verifier packages correctly certified ${environment} for web, iOS and Android origins`,async()=>{
  const f=fixture(environment);
  try {
    const result=buildApplicationAssets(f.input,{sdkDirectory:f.dir});
    assert.equal(result.environment,environment);
    const module=join(f.dir,"dist/application/packaged-trust.js");
    const trust=readFileSync(module,"utf8");
    const release=(await import(pathToFileURL(module).href)).appReleaseTrust();
    assert.equal(release.environment,environment);
    for(const origin of ["https://notes.example.test","capacitor://app.tasknotes.dev","https://app.tasknotes.dev"]) {
      const select=await selector(f,origin,trust),assets=select(environment,origin);
      assert.equal(assets.runtime.url,origin+"/sdk/native/runtime.wasm");
      assert.equal(assets.runtime.sha256,f.pins.runtime.sha256);
      assert.equal(assets.release().assetSha256,f.context.context.sha256);
      for(const other of ["lab","staging","production","local"].filter(value=>value!==environment))
        assert.throws(()=>select(other,origin));
      assert.throws(()=>select(environment,"null"));
      assert.throws(()=>select(environment,"https://foreign.example.test"));
    }
    assert.equal(readFileSync(join(f.dir,"dist/native/runtime.wasm")).length,8);
    // The official initializer resolves its Worker relative to its own URL.
    // Test the packaged dist, not just the installed dependency or a source list.
    const initializerUrl=pathToFileURL(join(f.dir,"dist/native/sqlite3.js"));
    const initializer=readFileSync(initializerUrl,"utf8");
    const proxyReference=initializer.match(/new URL\("([^"]*opfs-async-proxy\.js)", import.meta.url\)/);
    assert(proxyReference,"official SQLite Worker URL anchor");
    const proxy=readFileSync(new URL(proxyReference[1],initializerUrl));
    assert.equal(proxy.length,f.pins.sqlite.asyncProxy.bytes);
    assert.equal(hex(proxy),f.pins.sqlite.asyncProxy.sha256);
    const provenance=JSON.parse(readFileSync(join(f.dir,"dist/native/provenance.json")));
    assert.equal(provenance.environment,environment);assert.equal(provenance.verifier.clockOverride,false);
    assert.equal(provenance.handoff.contextSha256,f.receipt.contextSha256);
    assert.deepEqual(provenance.handoff.proof_sha256,f.context.provenance.proof_sha256);
    assert(!JSON.stringify(provenance).includes(f.dir));
  } finally {f.cleanup();}
});

for(const environment of ["lab","staging","production"])test(`shared intake preserves ${environment} custody and pins managed CP origins`,()=>{
  const f=fixture(environment);
  try {
    const handoff=readReleaseBuild(f.contextFile,join(f.dir,"receipt.json"));
    assert(Object.isFrozen(handoff));
    assert.equal(handoff.environment,environment);
    assert.equal(handoff.asset,f.asset);
    assert.equal(handoff.contextSha256,f.receipt.contextSha256);
    assert.equal(handoff.verifierSha256,f.receipt.verifierSha256);
    if(environment!=="lab") {
      for(const origin of ["https://foreign.example.test",environment==="production"?"https://connect-staging.mdbase.dev":"https://connect.mdbase.dev"]) {
        f.context.context.control_plane_origin=origin;f.save();
        assert.throws(()=>readReleaseBuild(f.contextFile,join(f.dir,"receipt.json")),/Release trust build refused/);
      }
    }
  } finally {f.cleanup();}
});

test("staging packaging preserves its distinct CP origin and provenance",()=>{
  const f=fixture("staging");
  try {
    assert.equal(buildApplicationAssets(f.input,{sdkDirectory:f.dir}).environment,"staging");
    const provenance=JSON.parse(readFileSync(join(f.dir,"dist/native/provenance.json")));
    assert.equal(provenance.trust.environment,"staging");
    assert.equal(provenance.trust.cpOrigin,"https://connect-staging.mdbase.dev");
    assert.equal(provenance.trust.sha256,f.context.context.sha256);
    assert.equal(provenance.verifier.clockOverride,false);
  } finally {f.cleanup();}
});

for(const environment of ["staging","production"])
for(const fault of ["missing asset","missing context","missing receipt","missing proof","changed proof","crossed inventory","wrong context digest","wrong asset digest","bad certificate","expired certificate","wrong environment","wrong CP origin","wrong source","wrong origin","wrong verifier","wrong runtime","clock override"])
test(`${environment} refuses ${fault}, preserving old output`,()=>{
  const f=fixture(environment);
  try {
    if(fault==="missing asset")rmSync(f.asset);
    if(fault==="missing context")rmSync(f.contextFile);
    if(fault==="missing receipt")rmSync(join(f.dir,"receipt.json"));
    if(fault==="missing proof")rmSync(join(f.dir,"handoff/image-release-bundle.sigstore.json"));
    if(fault==="changed proof")writeFileSync(join(f.dir,"handoff/image-release-bundle.sigstore.json"),"changed");
    if(fault==="crossed inventory"){
      const path=join(f.dir,"handoff/release-trust-bundle.json"),inventory=JSON.parse(readFileSync(path));
      inventory.publication.runId=999;const bytes=Buffer.from(json(inventory));writeFileSync(path,bytes);
      f.context.provenance.proof_sha256["release-trust-bundle.json"]=hex(bytes);
      const contextBytes=Buffer.from(JSON.stringify(f.context));writeFileSync(f.contextFile,contextBytes);
      f.receipt.contextSha256=hex(contextBytes);writeFileSync(join(f.dir,"receipt.json"),json(f.receipt));
    }
    if(fault==="wrong context digest")writeFileSync(f.contextFile,readFileSync(f.contextFile,"utf8")+"\n");
    if(fault==="wrong asset digest"){f.context.context.sha256="0".repeat(64);f.save();}
    if(fault==="bad certificate"){
      f.payload.policy_keys[0].certificate.signature="0".repeat(128);
      f.context.context.sha256=hex(Buffer.from(json(f.payload)));f.context.provenance.asset_length=Buffer.byteLength(json(f.payload));f.save();
    }
    if(fault==="expired certificate")f.expireCertificate();
    if(fault==="wrong environment"){f.context.context.environment="lab";f.save();}
    if(fault==="wrong CP origin"){f.context.context.control_plane_origin=environment==="staging"?"https://connect.mdbase.dev":"https://connect-staging.mdbase.dev";f.save();}
    if(fault==="wrong source"){f.context.context.source={...f.context.context.source,commit:"d".repeat(40)};f.save();}
    if(fault==="wrong origin"){f.context.context.log_origin="https://wrong.example.test";f.save();}
    if(fault==="wrong verifier"){f.receipt.verifierSha256="0".repeat(64);f.save();}
    if(fault==="wrong runtime")writeFileSync(join(f.dir,"runtime.wasm"),Buffer.alloc(8));
    if(fault==="clock override"){f.receipt.nowMs=Date.now();f.save();}
    assert.throws(()=>buildApplicationAssets(f.input,{sdkDirectory:f.dir}),/SDK application packaging refused/);
    assert.equal(readFileSync(join(f.dir,"dist/application/packaged-trust.js"),"utf8"),"original refusal");
    assert(!existsSync(join(f.dir,"dist/native/runtime.wasm")));
  } finally {f.cleanup();}
});
