#!/usr/bin/env node
/** BUILD ONLY. Uses the ONE mdbn-trust verifier; never parses/authenticates the
 * signed environment asset here or fetches runtime authority. Context arguments
 * MUST come from an independently authenticated release manifest/pipeline.
 * No defaults, network, shell, runtime environment selector or overwrite. */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const fail=()=>new Error("app release trust build refused");
const REPOSITORY="mdbase-dev/mdbase-connect";
const hex=(v,n)=>typeof v==="string"&&v.length===n*2&&/^[0-9a-f]+$/.test(v);
function origin(v){try{const u=new URL(v);return u.protocol==="https:"&&u.origin===v&&!u.username&&!u.password;}catch{return false;}}
function exact(value,keys){return value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
/** Validate ONLY the verifier's normalized OUTPUT contract, not the asset. */
export function normalizedAppTrust(value,expected){
  if(!exact(value,["schema","environment","control_plane_origin","log_origin","asset_sha256","source","roots","policy_pins_cbor_hex"]) || value.schema!=="mdbn-trust/normalized/1" || value.environment!==expected.environment || value.control_plane_origin!==expected.cpOrigin || value.log_origin!==expected.logOrigin || value.asset_sha256!==expected.sha256 || !exact(value.source,["repository","commit","version"]) || value.source.repository!==REPOSITORY || value.source.commit!==expected.sourceCommit || value.source.version!==expected.sourceVersion || !Array.isArray(value.roots) || value.roots.length<1 || value.roots.length>64 || value.roots.some(v=>!hex(v,32)) || new Set(value.roots).size!==value.roots.length || typeof value.policy_pins_cbor_hex!=="string" || value.policy_pins_cbor_hex.length<2 || value.policy_pins_cbor_hex.length>2*65536 || value.policy_pins_cbor_hex.length%2!==0 || !/^[0-9a-f]+$/.test(value.policy_pins_cbor_hex))throw fail();
  return value;
}
function moduleSource(value,typescript){
  // Public constants are build literals. Every call owns fresh byte buffers;
  // caller mutation never changes the immutable release context for successors.
  const metadata={schema:"mdbn-app-trust/release/1",environment:value.environment,cpOrigin:value.control_plane_origin,logOrigin:value.log_origin,assetSha256:value.asset_sha256,source:value.source};
  return `// Generated ONLY after shared BUILD-time mdbn-trust verification.\n// PUBLIC environment release context, not grant authority/readiness/key isolation.\nconst metadata = ${JSON.stringify(metadata)}${typescript?" as const":""};\nObject.freeze(metadata.source); Object.freeze(metadata);\nconst rootHex = Object.freeze(${JSON.stringify(value.roots)});\nconst pinsHex = ${JSON.stringify(value.policy_pins_cbor_hex)};\nconst bytes = (hex${typescript?": string":""}) => { const value = new Uint8Array(hex.length / 2); for (let i = 0; i < value.length; i++) value[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return value; };\nexport function appReleaseTrust() {\n  return Object.freeze({ ...metadata, trustedRoots: Object.freeze(rootHex.map(bytes)), policyPins: bytes(pinsHex) });\n}\n`;
}
/** Execute only the caller-selected trusted build verifier with fixed argv.
 * This function cannot authenticate a manifest supplied by an untrusted caller;
 * release authentication must precede it, exactly as for mdbn_trust::Context. */
export function buildAppTrust(options){
  try{
    const o=Object.freeze({...options});
    if(!hex(o.sha256,32)||!["lab","staging","production"].includes(o.environment)||!origin(o.cpOrigin)||!origin(o.logOrigin)||!hex(o.sourceCommit,20)||typeof o.sourceVersion!=="string"||!/^[A-Za-z0-9.+-]{1,64}$/.test(o.sourceVersion)||[o.verifier,o.asset,o.output].some(v=>typeof v!=="string"||!v.length)||!(/\.(?:ts|mjs)$/.test(o.output))||o.nowMs!==undefined&&(!Number.isSafeInteger(o.nowMs)||o.nowMs<0))throw fail();
    const args=["verify","--asset",resolve(o.asset),"--sha256",o.sha256,"--environment",o.environment,"--cp-origin",o.cpOrigin,"--log-origin",o.logOrigin,"--source-commit",o.sourceCommit,"--source-version",o.sourceVersion];
    if(o.nowMs!==undefined)args.push("--now-ms",String(o.nowMs));
    const result=spawnSync(resolve(o.verifier),args,{encoding:"utf8",shell:false,timeout:15000,maxBuffer:256*1024});
    if(result.error||result.status!==0||result.signal||typeof result.stdout!=="string"||Buffer.byteLength(result.stdout)>256*1024||!result.stdout.endsWith("\n")||result.stdout.slice(0,-1).includes("\n"))throw fail();
    const value=normalizedAppTrust(JSON.parse(result.stdout.slice(0,-1)),o),source=moduleSource(value,o.output.endsWith(".ts"));
    // Create-only. A failed verifier/context check never touches an old release
    // module; a write error fails the build rather than signing partial output.
    writeFileSync(resolve(o.output),source,{flag:"wx",mode:0o644});
    return Object.freeze({environment:value.environment,assetSha256:value.asset_sha256,output:resolve(o.output)});
  }catch{throw fail();}
}
function cli(args){
  const names={"--verifier":"verifier","--asset":"asset","--output":"output","--sha256":"sha256","--environment":"environment","--cp-origin":"cpOrigin","--log-origin":"logOrigin","--source-commit":"sourceCommit","--source-version":"sourceVersion","--now-ms":"nowMs"};
  const options={};if(args.length%2)throw fail();
  for(let i=0;i<args.length;i+=2){const key=names[args[i]];if(!key||Object.hasOwn(options,key)||typeof args[i+1]!=="string")throw fail();options[key]=key==="nowMs"?Number(args[i+1]):args[i+1];}
  return buildAppTrust(options);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(cli(process.argv.slice(2))));}catch{console.error("app release trust build refused");process.exitCode=1;}}
