import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error BUILD-only JS tool has no shipped runtime declarations.
import { buildAppTrust, normalizedAppTrust } from "../scripts/build-app-trust.mjs";
const target=resolve(dirname(fileURLToPath(import.meta.url)),"../../../target");mkdirSync(target,{recursive:true});
const dir=mkdtempSync(resolve(target,"app-trust-unit-"));afterAll(()=>rmSync(dir,{recursive:true,force:true}));
const expected={sha256:"aa".repeat(32),environment:"lab",cpOrigin:"https://cp.example.test",logOrigin:"https://log.example.test",sourceCommit:"bb".repeat(20),sourceVersion:"0.0.0-test"};
const pins="828182507554e3aa62bbed3ef2f01b630f94d7ef58202a5a3df0260259f5e6b8ce05ec9b66f5c649022456fd72026647e368acf2cb308183501054409eba35bba607fb60b641f15f815820206be8992be796f514e0b9f443135429c74b6f87bcf0dc62d46c8d5c42d25047507554e3aa62bbed3ef2f01b630f94d7ef";
const normalized=()=>({schema:"mdbn-trust/normalized/1",environment:expected.environment,control_plane_origin:expected.cpOrigin,log_origin:expected.logOrigin,asset_sha256:expected.sha256,source:{repository:"mdbase-dev/mdbase-connect",commit:expected.sourceCommit,version:expected.sourceVersion},roots:["2a5a3df0260259f5e6b8ce05ec9b66f5c649022456fd72026647e368acf2cb30"],policy_pins_cbor_hex:pins});
let id=0;
function fixture(output=JSON.stringify(normalized())+"\n",exit=0){
  const n=++id,verifier=resolve(dir,`verifier-${n}.mjs`),asset=resolve(dir,`asset-${n}`),out=resolve(dir,`release-${n}.mjs`),args=resolve(dir,`args-${n}.json`);
  // TEST contract stub, not signed-asset verification/production provenance.
  writeFileSync(verifier,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(output)});process.exit(${exit});`,{flag:"wx"});chmodSync(verifier,0o755);
  writeFileSync(asset,"this is NOT a signed asset or authority",{flag:"wx"});
  return {options:{...expected,verifier,asset,output:out,nowMs:1791417600000},out,args};
}
describe("app BUILD trust intake around the ONE shared verifier (contract stubs only)",()=>{
  it("passes explicit external context/asset as fixed argv, emits immutable metadata + fresh owned bytes",async()=>{
    const f=fixture();const result=buildAppTrust(f.options);expect(result.assetSha256).toBe(expected.sha256);
    const args=JSON.parse(readFileSync(f.args,"utf8"));expect(args).toEqual(["verify","--asset",f.options.asset,"--sha256",expected.sha256,"--environment","lab","--cp-origin",expected.cpOrigin,"--log-origin",expected.logOrigin,"--source-commit",expected.sourceCommit,"--source-version",expected.sourceVersion,"--now-ms",String(f.options.nowMs)]);
    const {appReleaseTrust}=await import(pathToFileURL(f.out).href);const a=appReleaseTrust(),b=appReleaseTrust();
    expect(a.environment).toBe("lab");expect(a.source.commit).toBe(expected.sourceCommit);expect(Object.isFrozen(a)&&Object.isFrozen(a.source)&&Object.isFrozen(a.trustedRoots)).toBe(true);
    expect(a.policyPins===b.policyPins||a.trustedRoots[0]===b.trustedRoots[0]).toBe(false);a.policyPins.fill(0);a.trustedRoots[0].fill(0);
    const c=appReleaseTrust();expect(c.policyPins.every((v:number,i:number)=>v===b.policyPins[i])).toBe(true);expect(c.trustedRoots[0].some((v:number)=>v!==0)).toBe(true);
    const source=readFileSync(f.out,"utf8");expect(source.includes("fetch(")||source.includes("process.env")||source.includes("verify(" )).toBe(false);
  });
  it.each(["sha256","environment","cpOrigin","logOrigin","sourceCommit","sourceVersion","verifier","asset","output"])("missing/invalid required context %s never invokes verifier or touches output",field=>{
    const f=fixture();expect(()=>buildAppTrust({...f.options,[field]:undefined})).toThrow("app release trust build refused");expect(existsSync(f.args)||existsSync(f.out)).toBe(false);
  });
  it("verifier refusal/extra lines/oversize/malformed output cannot create an authority module",()=>{
    for(const [body,status] of [[JSON.stringify(normalized())+"\n",1],[JSON.stringify(normalized())+"\nextra\n",0],[JSON.stringify(normalized()),0],["not-json\n",0],["x".repeat(256*1024+1)+"\n",0]] as const){const f=fixture(body,status);expect(()=>buildAppTrust(f.options)).toThrow("app release trust build refused");expect(existsSync(f.out)).toBe(false);}
  });
  it.each(["schema","environment","control_plane_origin","log_origin","asset_sha256","source","roots","policy_pins_cbor_hex"])("foreign/malformed normalized field %s refuses even when verifier exit is zero",field=>{
    const value={...normalized(),[field]:field==="roots"?[]:field==="source"?{...normalized().source,commit:"cc".repeat(20)}:field==="policy_pins_cbor_hex"?"f": "foreign"};
    const f=fixture(JSON.stringify(value)+"\n");expect(()=>buildAppTrust(f.options)).toThrow("app release trust build refused");expect(existsSync(f.out)).toBe(false);
  });
  it("normalized output must have exact bounded public shape; it does not reinterpret asset bytes",()=>{
    for(const value of [{...normalized(),extra:true},{...normalized(),source:{...normalized().source,extra:true}},{...normalized(),roots:["ff"]},{...normalized(),roots:[normalized().roots[0],normalized().roots[0]]},{...normalized(),policy_pins_cbor_hex:"ff".repeat(65537)}])expect(()=>normalizedAppTrust(value,expected)).toThrow("app release trust build refused");
  });
  it("emits a strict typed static module for an app Worker without runtime discovery",()=>{
    const f=fixture(),output=f.out.replace(/\.mjs$/,".ts");buildAppTrust({...f.options,output});const source=readFileSync(output,"utf8");expect(source).toContain(" as const;");expect(source).toContain("(hex: string)");expect(source).not.toContain("fetch(");
  });
  it("refuses ambiguous module formats before invoking the verifier",()=>{
    const f=fixture();expect(()=>buildAppTrust({...f.options,output:f.out+".json"})).toThrow("app release trust build refused");expect(existsSync(f.args)||existsSync(f.out+".json")).toBe(false);
  });
  it("never overwrites an older verified release module on success or refusal",()=>{
    const f=fixture();writeFileSync(f.out,"owned previous release module",{flag:"wx"});expect(()=>buildAppTrust(f.options)).toThrow("app release trust build refused");expect(readFileSync(f.out,"utf8")).toBe("owned previous release module");
    const g=fixture("private verifier detail\n",1);writeFileSync(g.out,"another owned old release",{flag:"wx"});expect(()=>buildAppTrust(g.options)).toThrow("app release trust build refused");expect(readFileSync(g.out,"utf8")).toBe("another owned old release");
  });
});
