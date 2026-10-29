// Pure BUILD-only handoff intake shared by SDK and managed-native packaging.
// No network, authentication substitute, key generation or runtime configuration.
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
const refusal=()=>new Error("Release trust build refused");
function checked(path,hash){
  const bytes=readFileSync(path);
  if(createHash("sha256").update(bytes).digest("hex")!==hash)throw refusal();
  return bytes;
}
/** Post-authentication byte/custody binding, NOT Sigstore authentication.
 * Consume the ONE Ops verify-trust output unchanged; it must already have passed
 * signature, original-image, publisher, CI and reference-consumer gates.
 * The qualified SDK build supplies a frozen receipt binding that exact context
 * and verifier. Neither this unsigned JSON nor matching hashes confer authority. */
export function readReleaseBuild(contextFile,receiptFile) {
  const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
  const hex=(v,n)=>typeof v==="string"&&new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  const exact=(v,keys)=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===[...keys].sort().join(",");
  const origin=v=>{try{const u=new URL(v);return u.protocol==="https:"&&u.origin===v&&!u.username&&!u.password;}catch{return false;}};
  const positive=v=>Number.isSafeInteger(v)&&v>0;
  const run=(v,publisher=false)=>exact(v,["run_id","run_attempt",...(publisher?["publisher_commit"]:[])])&&positive(v.run_id)&&positive(v.run_attempt)&&(!publisher||hex(v.publisher_commit,40));
  const receiptBytes=readFileSync(receiptFile),contextBytes=readFileSync(contextFile);
  if(receiptBytes.length>65536||contextBytes.length>65536)throw refusal();
  const receipt=JSON.parse(receiptBytes),value=JSON.parse(contextBytes);
  if(!exact(receipt,["schema","contextSha256","verifierSha256","verifierSourceCommit"])||
    receipt.schema!=="mdbn-sdk/application-build/1"||!hex(receipt.contextSha256,64)||
    !hex(receipt.verifierSha256,64)||!hex(receipt.verifierSourceCommit,40)||
    digest(contextBytes)!==receipt.contextSha256||
    !exact(value,["schema_version","kind","context","provenance"])||
    value.schema_version!==1||value.kind!=="mdbase-next-build-trust-context")throw refusal();
  const c=value.context,p=value.provenance;
  if(!exact(c,["sha256","environment","control_plane_origin","log_origin","source"])||
    !["lab","staging","production"].includes(c.environment)||!hex(c.sha256,64)||
    !origin(c.control_plane_origin)||!origin(c.log_origin)||
    c.environment==="production"&&c.control_plane_origin!=="https://connect.mdbase.dev"||
    c.environment==="staging"&&c.control_plane_origin!=="https://connect-staging.mdbase.dev"||
    !exact(c.source,["repository","commit","version"])||c.source.repository!=="mdbase-dev/mdbase-connect"||
    !hex(c.source.commit,40)||typeof c.source.version!=="string"||!/^[A-Za-z0-9.+-]{1,64}$/.test(c.source.version)||
    !exact(p,["asset_path","asset_length","proof_sha256","image_publication","trust_publication","publisher_qualification"])||
    p.asset_path!==`next-trust/${c.environment}.json`||!positive(p.asset_length)||p.asset_length>65536||
    !run(p.image_publication)||!run(p.trust_publication,true)||!run(p.publisher_qualification))throw refusal();
  const proofNames=["release-trust-bundle.json","release-trust-bundle.sigstore.json","image-release-bundle.json","image-release-bundle.sigstore.json"];
  if(!exact(p.proof_sha256,proofNames)||proofNames.some(name=>!hex(p.proof_sha256[name],64)))throw refusal();
  const handoff=dirname(dirname(resolve(contextFile)));
  if(resolve(contextFile)!==join(handoff,"next-trust",`${c.environment}-context.json`))throw refusal();
  const proofs=Object.fromEntries(proofNames.map(name=>{
    const bytes=checked(join(handoff,name),p.proof_sha256[name]);
    if(bytes.length<1||bytes.length>65536)throw refusal();
    return [name,bytes];
  }));
  const inventory=JSON.parse(proofs["release-trust-bundle.json"]),image=JSON.parse(proofs["image-release-bundle.json"]);
  const source=v=>v?.repository===c.source.repository&&v?.commit===c.source.commit&&v?.version===c.source.version;
  const a=inventory.trustAssets?.[0],b=inventory.imageBundle;
  if(inventory.schemaVersion!==1||inventory.kind!=="mdbase-release-trust-bundle"||!source(inventory)||!source(image)||
    !Array.isArray(inventory.trustAssets)||inventory.trustAssets.length!==1||
    a.path!==p.asset_path||a.length!==p.asset_length||a.sha256!==c.sha256||a.environment!==c.environment||
    a.controlPlaneOrigin!==c.control_plane_origin||a.logOrigin!==c.log_origin||!source(a.source)||
    b?.path!=="image-release-bundle.json"||b.length!==proofs[b.path].length||b.sha256!==p.proof_sha256[b.path]||
    b.publicationRunId!==p.image_publication.run_id||b.publicationRunAttempt!==p.image_publication.run_attempt||
    image.publication?.runId!==p.image_publication.run_id||image.publication?.runAttempt!==p.image_publication.run_attempt||
    inventory.publication?.runId!==p.trust_publication.run_id||inventory.publication?.runAttempt!==p.trust_publication.run_attempt||
    inventory.publication?.publisherCommit!==p.trust_publication.publisher_commit||
    inventory.qualification?.runId!==p.publisher_qualification.run_id||inventory.qualification?.runAttempt!==p.publisher_qualification.run_attempt)throw refusal();
  return Object.freeze({environment:c.environment,cpOrigin:c.control_plane_origin,logOrigin:c.log_origin,
    sha256:c.sha256,assetBytes:p.asset_length,sourceCommit:c.source.commit,sourceVersion:c.source.version,
    verifierSha256:receipt.verifierSha256,verifierSourceCommit:receipt.verifierSourceCommit,
    contextSha256:receipt.contextSha256,receiptSha256:digest(receiptBytes),provenance:p,asset:join(handoff,p.asset_path)});
}

