import {afterEach,describe,expect,it,vi} from "vitest";
import {parseVersionedAppManifest} from "@mdbase-dev/connect-protocol/manifest";
import {appOriginPlatform} from "../src/app-host/app-origin.js";
import {applicationDeclaration} from "../src/application/declaration.js";
import {compileApplicationManifest} from "../src/application/manifest.js";
import {declaredReturnUrl} from "../src/application/return-url.js";
import {resolveApplicationRegistration} from "../src/application/registration.js";
import {applicationNativeAssets} from "../src/application/native-assets.js";
import {selectAppEnvironment} from "../src/app-host/app-environment.js";
import type {AppBundledReleaseTrust} from "../src/app-host/cloud-copy-bootstrap.js";
import * as trust from "../src/application/packaged-trust.js";
const id="11111111-1111-4111-8111-111111111111";
const manifest=(origin:string,platform:unknown="native")=>({manifest_version:1,id:"dev.example.native",name:"Example",...(platform?{platform}:{}),homepage:origin,redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"]}}});
const declaration=(origin:string,platform:unknown="native")=>applicationDeclaration({id,name:"Example",origin,environment:"production",manifest:manifest(origin,platform)});
const release=():AppBundledReleaseTrust=>({schema:"mdbn-app-trust/release/1",environment:"production",cpOrigin:"https://cp.test",logOrigin:"https://log.test",assetSha256:"a".repeat(64),source:{repository:"mdbase-dev/mdbase-connect",commit:"b".repeat(40),version:"test.1"},trustedRoots:[new Uint8Array(32).fill(1)],policyPins:Uint8Array.of(1)});
afterEach(()=>vi.restoreAllMocks());
describe("declared native production loopback",()=>{
  it.each(["http://127.0.0.1","http://127.0.0.1:1","http://127.0.0.1:49152","http://127.0.0.1:65535"])("accepts %s only with the native declaration",origin=>{
    expect(appOriginPlatform(origin,false,"native")).toBe("native");
    expect(appOriginPlatform(origin)).toBeNull();
    expect(compileApplicationManifest(declaration(origin)).manifest).toMatchObject({platform:"native",homepage:origin});
    expect(()=>declaration(origin,null)).toThrow();
    expect(selectAppEnvironment({environment:"production",appOrigin:origin,platform:"native",release:release()})).toMatchObject({allowLoopbackHttp:false,allowNativeLoopbackHttp:true});
    expect(()=>selectAppEnvironment({environment:"production",appOrigin:origin,release:release()})).toThrow();
    expect(declaredReturnUrl(`${origin}/callback`,manifest(origin),false)).toBe(true);
    expect(declaredReturnUrl(`${origin}/other`,manifest(origin),false)).toBe(false);
    expect(declaredReturnUrl(`${origin}/callback`,manifest(origin,null),false)).toBe(false);
  });
  it.each(["http://localhost:49152","http://x.localhost:49152","http://127.0.0.2:49152","http://192.168.0.1:49152","http://[::1]:49152","http://127.1:49152","http://2130706433:49152","http://127.0.0.1.evil.test:49152","http://user@127.0.0.1:49152","http://127.0.0.1:0","http://127.0.0.1:65536","app://obsidian.md"])("refuses %s despite native claim",origin=>{
    expect(appOriginPlatform(origin,false,"native")).toBeNull();
    expect(()=>declaration(origin)).toThrow();
    expect(()=>selectAppEnvironment({environment:"production",appOrigin:origin,platform:"native",release:release()})).toThrow();
  });
  it.each(["https://remote.example.test","https://127.0.0.1:49152","http://localhost:49152","http://[::1]:49152"])("rejects a native manifest with %s in any origin-bearing field",other=>{
    const origin="http://127.0.0.1:49152",base=manifest(origin);
    for (const invalid of [{...base,homepage:other},{...base,redirect_uris:[`${other}/callback`]},
      { ...base,installation_origins:{production:{"app-runtime":[other]}} }]) {
      const input=applicationDeclaration({id,name:"Example",origin,environment:"production",manifest:invalid});
      expect(()=>compileApplicationManifest(input)).toThrow();
    }
  });
  it("keeps CP/log HTTPS and exact return-URL ports despite native claim",()=>{
    const origin="http://127.0.0.1:49152";
    for(const field of ["cpOrigin","logOrigin"])
      expect(()=>selectAppEnvironment({environment:"production",appOrigin:origin,platform:"native",release:{...release(),[field]:origin}})).toThrow();
    expect(declaredReturnUrl("http://127.0.0.1:49153/callback",manifest(origin),false)).toBe(false);
    expect(declaredReturnUrl("app://obsidian.md/callback",{...manifest(origin),redirect_uris:["app://obsidian.md/callback"]},false)).toBe(false);
  });
  it("registers the canonical native declaration and keeps its current port binding",async()=>{
    const origin="http://127.0.0.1:49152",input=declaration(origin),canonical=parseVersionedAppManifest(input.manifest).manifest;
    vi.spyOn(trust,"appReleaseTrust").mockReturnValue(release());
    const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({application:{id,name:"Example",manifest_digest:"c".repeat(64),canonical_identity:`bundle:dev.example.native:sha256:${"c".repeat(64)}`,family_identity:"bundle:dev.example.native",distribution:"web",application_declaration:canonical}}));
    expect(await resolveApplicationRegistration({declaration:input,signal:new AbortController().signal,isCurrent:()=>true,fetch})).toMatchObject({id,name:"Example"});
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).manifest.platform).toBe("native");
  });
  it("loads packaged native assets on the exact loopback origin",async()=>{
    const origin="http://127.0.0.1:49152",bytes=Uint8Array.of(0,97,115,109),sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),x=>x.toString(16).padStart(2,"0")).join("");
    const asset={url:`${origin}/runtime.wasm`,sha256,bytes:4,maxBytes:4},fetch=vi.fn(async()=>new Response(bytes));
    const assets=applicationNativeAssets(declaration(origin),{release,runtime:asset,sqlite:asset,initializeSqlite:vi.fn()},vi.fn(),fetch);
    expect(assets.environment.appOrigin).toBe(origin);expect(assets.collection.allowLoopbackHttp).toBe(false);expect(assets.collection.allowNativeLoopbackHttp).toBe(true);
    expect(await assets.loadRuntime({signal:new AbortController().signal})).toEqual(bytes);
    expect(assets.collection.setupJournal.appOrigin).toBe(origin);
  });
});
