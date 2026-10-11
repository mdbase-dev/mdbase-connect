import { createHash, createPrivateKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ed25519PublicKeyObject, ed25519RawPublicKey, verifyCert } from "./policy-keys.js";
import { certDigest, decodeCbor, domainHash, encodeCbor, encodeCert, keyId, policyItemSignedDigest, signPolicyItem, uuidBytes, type PolicySigner } from "./policy-wire.js";
import { NIL } from "./bootstrap-common.js";

// Test-only observation of the ACTUAL private production functions. Strip types
// and import/export syntax, supplying the same real codec/crypto dependencies;
// no production export, signer getter, stubbed guard or copied implementation.
const privateSource=stripTypeScriptTypes(readFileSync(new URL("./lab-pitr-routes.ts",import.meta.url),"utf8"),{mode:"transform"})
  .replace(/^import[\s\S]*?;\n/gm,"").replace("export function registerLabPitrRoutes","function registerLabPitrRoutes");
const deps={z,NIL,sign,verify,decodeCbor,domainHash,encodeCbor,encodeCert,keyId,policyItemSignedDigest,uuidBytes,ed25519PublicKeyObject,verifyCert};
const {assertCpOriginalGenesis,signCpOriginalAdmission}=new Function(...Object.keys(deps),privateSource+"\nreturn {assertCpOriginalGenesis,signCpOriginalAdmission};")(...Object.values(deps)) as {
  assertCpOriginalGenesis:(raw:Uint8Array,collection:string,owner:string,root:Uint8Array,transport:Uint8Array)=>void;
  signCpOriginalAdmission:(signer:PolicySigner,facts:typeof facts)=>{admission:Uint8Array;expiresAt:number};
};

// PUBLIC SYNTHETIC TEST SEEDS ONLY; no deployed keys or release trust assets.
const testKey = (byte:number)=>createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.alloc(32,byte)]),format:"der",type:"pkcs8"});
const root=testKey(0x31),policy=testKey(0x32),issuer=testKey(0x33),transport=testKey(0x34);
const rootPublicKey=ed25519RawPublicKey(root), NOW=1791100000000;
function signerFor(key=policy):PolicySigner {
  const cert={policyPublicKey:ed25519RawPublicKey(key),notBefore:1790000000000,notAfter:1800000000000,root:keyId(rootPublicKey)};
  return {privateKey:key,cert:{...cert,signature:sign(null,certDigest(cert),root)}};
}
const signer=signerFor(),collection="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",owner="11111111-1111-4111-a111-111111111111";
const genesis=signPolicyItem(signerFor(transport),{collection,seq:1,prev:Buffer.alloc(32),issuedAt:NOW-10000,previousIssuedAt:0,
  ops:[{op:"genesis",owner,root:keyId(rootPublicKey),state:"cloud-copy"}]});
const facts={audience:"https://connect-lab.mdbase.dev",run:"gate4-pitr-lab-20261009-01" as const,collection,owner,rootPublicKey,
  issuerPublicKey:ed25519RawPublicKey(issuer),transportPublicKey:ed25519RawPublicKey(transport),
  genesisSha256:createHash("sha256").update(genesis).digest(),challenge:Buffer.alloc(32,0x35),issuedAt:NOW};
function decoded(raw:Uint8Array) {
  const outer=decodeCbor(raw,{maxDepth:5,canonicalStructs:true});
  if(!Array.isArray(outer)||outer.length!==4||!(outer[1] instanceof Uint8Array)||!(outer[2] instanceof Map)||!(outer[3] instanceof Uint8Array))throw Error("bad test envelope");
  const claims=decodeCbor(outer[1],{maxDepth:2,canonicalStructs:true});if(!Array.isArray(claims))throw Error("bad test claims");
  return {outer,bytes:outer[1],cert:outer[2],signature:outer[3],claims};
}
describe("CP-only original admission transcript",()=>{
  it("pins exact golden framing, claims and independently root-certified signature",()=>{
    const golden=JSON.parse(readFileSync(new URL("./fixtures/prekey-original-admission-v1.json",import.meta.url),"utf8"));
    const {admission,expiresAt}=signCpOriginalAdmission(signer,facts),d=decoded(admission),hex=(b:Uint8Array)=>Buffer.from(b).toString("hex");
    expect(hex(admission)).toBe(golden.admissionHex);expect(hex(d.bytes)).toBe(golden.claimsHex);
    expect(hex(domainHash("mdbase/v1/prekey-original-admission",d.bytes))).toBe(golden.digestHex);
    expect(d.outer[0]).toBe(1);expect(d.claims).toEqual([1,facts.audience,facts.run,"original-caller-prekey",Uint8Array.from(uuidBytes(collection)),
      Uint8Array.from(uuidBytes(owner)),Uint8Array.from(rootPublicKey),Uint8Array.from(facts.issuerPublicKey),Uint8Array.from(facts.transportPublicKey),
      Uint8Array.from(facts.genesisSha256),1,null,null,null,Uint8Array.from(facts.challenge),NOW,expiresAt]);
    expect(d.cert.size).toBe(5);expect(d.cert.get(0)).toEqual(Uint8Array.from(signer.cert.policyPublicKey));
    expect(verifyCert(signer.cert,rootPublicKey)).toBe(true);expect(admission.length).toBeLessThanOrEqual(4096);expect(d.bytes.length).toBeLessThanOrEqual(2048);
    expect(verify(null,domainHash("mdbase/v1/prekey-original-admission",d.bytes),ed25519PublicKeyObject(signer.cert.policyPublicKey),d.signature)).toBe(true);
    expect(expiresAt-NOW).toBe(10000);expect(hex(rootPublicKey)).toBe(golden.rootPublicKeyHex);
  });
  it("keeps actual issuer, CP Ed25519 transport and current policy signer distinct",()=>{
    const d=decoded(signCpOriginalAdmission(signer,facts).admission);
    expect(d.claims[7]).not.toEqual(d.claims[8]);expect(d.claims[7]).not.toEqual(Uint8Array.from(signer.cert.policyPublicKey));
    for(const key of [facts.issuerPublicKey,facts.transportPublicKey])expect(verify(null,domainHash("mdbase/v1/prekey-original-admission",d.bytes),ed25519PublicKeyObject(key),d.signature)).toBe(false);
    expect(()=>assertCpOriginalGenesis(genesis,collection,owner,rootPublicKey,facts.transportPublicKey)).not.toThrow();
    expect(()=>assertCpOriginalGenesis(genesis,collection,owner,rootPublicKey,signer.cert.policyPublicKey)).toThrow();
  });
  it("separates domains and binds every signed field including native challenge",()=>{
    const d=decoded(signCpOriginalAdmission(signer,facts).admission),pk=ed25519PublicKeyObject(signer.cert.policyPublicKey);
    for(const domain of ["mdbase-next/migration-source/v1","mdbase/v1/ls-token","mdbase/v1/item-sig"])
      expect(verify(null,domainHash(domain,d.bytes),pk,d.signature)).toBe(false);
    for(let i=0;i<17;i++){
      const values=[...d.claims];values[i]=null;
      if([11,12,13].includes(i))values[i]=1;
      const changed=encodeCbor(values as Parameters<typeof encodeCbor>[0]);
      expect(verify(null,domainHash("mdbase/v1/prekey-original-admission",changed),pk,d.signature)).toBe(false);
    }
    const signature=Uint8Array.from(d.signature);signature[0]!^=1;expect(verify(null,domainHash("mdbase/v1/prekey-original-admission",d.bytes),pk,signature)).toBe(false);
    expect(verifyCert({...signer.cert,signature:Buffer.alloc(64)},rootPublicKey)).toBe(false);
  });
  it("clips freshness to the certified window without extending or renewing it",()=>{
    const short={...signer,cert:{...signer.cert,notAfter:NOW+1234}};
    expect(signCpOriginalAdmission(short,facts).expiresAt).toBe(NOW+1234);
    expect(()=>signCpOriginalAdmission(short,{...facts,issuedAt:NOW+1234})).toThrow();
  });
  it.each([{collection:"00000000-0000-0000-0000-000000000000"},{owner:"00000000-0000-0000-0000-000000000000"},
    {collection:collection.toUpperCase()},{owner:owner+"\n"},{audience:"http://connect-lab.mdbase.dev"},{audience:"https://user@connect-lab.mdbase.dev"},
    {audience:"https://connect-lab.mdbase.dev/path"},{audience:"https://connect-lab.mdbase.dev/"},{run:"other"},
    {rootPublicKey:Buffer.alloc(32)},{issuerPublicKey:Buffer.alloc(32)},{transportPublicKey:Buffer.alloc(32)},{challenge:Buffer.alloc(32)},
    {challenge:Buffer.alloc(31,1)},{genesisSha256:Buffer.alloc(33,1)},{issuedAt:-1},{issuedAt:NaN},{issuedAt:1.5},
    {issuedAt:signer.cert.notBefore-1},{issuedAt:signer.cert.notAfter}])("refuses invalid trusted facts %#",invalid=>{
    expect(()=>signCpOriginalAdmission(signer,{...facts,...invalid} as typeof facts)).toThrow();
  });
  it("rejects original signature/cert/owner/root/collection/transport corruption and noncanonical records",()=>{
    for(const raw of [Buffer.alloc(0),Buffer.alloc(65537),Buffer.concat([genesis,Buffer.of(0)]),Uint8Array.from(genesis, (v,i)=>i===genesis.length-1?v^1:v)])
      expect(()=>assertCpOriginalGenesis(raw,collection,owner,rootPublicKey,facts.transportPublicKey)).toThrow();
    for(const change of [{collection:"dddddddd-dddd-4ddd-addd-dddddddddddd"},{owner:collection},{rootPublicKey:facts.issuerPublicKey},{transportPublicKey:facts.issuerPublicKey}]){
      const f={...facts,...change};expect(()=>assertCpOriginalGenesis(genesis,f.collection,f.owner,f.rootPublicKey,f.transportPublicKey)).toThrow();
    }
    const e2e=signPolicyItem(signerFor(transport),{collection,seq:1,prev:Buffer.alloc(32),issuedAt:NOW-10000,previousIssuedAt:0,
      ops:[{op:"genesis",owner,root:keyId(rootPublicKey),state:"e2e"}]});
    expect(()=>assertCpOriginalGenesis(e2e,collection,owner,rootPublicKey,facts.transportPublicKey)).toThrow();
    const duplicate=signPolicyItem(signerFor(transport),{collection,seq:1,prev:Buffer.alloc(32),issuedAt:NOW-10000,previousIssuedAt:0,
      ops:[{op:"genesis",owner,root:keyId(rootPublicKey),state:"cloud-copy"},{op:"genesis",owner,root:keyId(rootPublicKey),state:"cloud-copy"}]});
    expect(()=>assertCpOriginalGenesis(duplicate,collection,owner,rootPublicKey,facts.transportPublicKey)).toThrow();
  });
});
