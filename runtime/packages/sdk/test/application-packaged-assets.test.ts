import {build} from "esbuild";
import {describe,expect,it,vi} from "vitest";
import {currentAppOrigin} from "../src/app-host/app-origin.js";
import {describeError} from "../src/describe-error.js";
import {packagedApplicationAssets} from "../src/application/packaged-assets.js";
import pins from "../src/application/asset-pins.json" with {type:"json"};

// Public synthetic BUILD output only; not an authenticated SDK artifact. Bundle
// tests supply an ESM anchor without changing production selector inputs.
async function selector(moduleUrl:string,trust=true){
  const result=await build({entryPoints:["src/application/packaged-assets.ts"],absWorkingDir:new URL("..",import.meta.url).pathname,
    bundle:true,platform:"browser",format:"esm",write:false,define:{"import.meta.url":JSON.stringify(moduleUrl)},
    plugins:[{name:"fixture-build-trust",setup(b){b.onResolve({filter:/^\.\/packaged-trust\.js$/},()=>({path:"fixture",namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:trust?`export function appReleaseTrust(){return Object.freeze({schema:'mdbn-app-trust/release/1',environment:'lab',cpOrigin:'https://cp.test',logOrigin:'https://log.test',assetSha256:'11'.repeat(32),source:{repository:'mdbase-dev/mdbase-connect',commit:'22'.repeat(20),version:'test'},trustedRoots:[new Uint8Array(32).fill(3)],policyPins:new Uint8Array([4])});}`:`export function appReleaseTrust(){throw new Error('LAB trust unavailable');}`}));}}]});
  return (await import(/* @vite-ignore */`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`)).packagedApplicationAssets as typeof packagedApplicationAssets;
}

describe("SDK packaged application assets",()=>{
  it("managed tiers never fall back to a LAB release",async()=>{const select=await selector("https://app.test/sdk/application/packaged-assets.js");for(const tier of ["staging","production"] as const)expect(()=>select(tier,"https://app.test")).toThrow();});
  it("unbuilt release refuses rather than inventing LAB trust",()=>{expect(()=>packagedApplicationAssets("lab","https://app.test")).toThrow("SDK release trust unavailable");});
  it.each([
    ["staging","https://app.tasknotes.dev"],["staging","capacitor://app.tasknotes.dev"],
    ["production","https://app.tasknotes.dev"],["production","capacitor://app.tasknotes.dev"]
  ] as const)("%s %s refuses missing trust with ordinary app-start copy",(environment,origin)=>{
    try {packagedApplicationAssets(environment,origin);throw new Error("accepted");}
    catch(error){
      expect(error).toMatchObject({code:"unavailable",reason:"application_release_trust_unavailable"});
      const copy=describeError(error)!;expect(copy.key).toBe("assets");
      expect(copy.title+" "+copy.message).not.toMatch(/trust|signature|root|policy/i);
    }
  });
  it("selects the current native pin at the same-artifact URL without I/O",async()=>{
    const select=await selector("https://app.test/sdk/application/packaged-assets.js");
    const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(()=>{throw new Error("unexpected I/O");});
    try {
      const assets=select("lab","https://app.test");
      expect(assets.runtime).toEqual({url:"https://app.test/sdk/native/runtime.wasm",sha256:"872878c05c44110252ea094d3a62a00b4753ecbb949f3ff0ae83747ae91f5a2a",bytes:3680813,maxBytes:3680813});
      expect(Object.isFrozen(assets.runtime)).toBe(true); expect(fetch).not.toHaveBeenCalled();
    } finally {fetch.mockRestore();}
  });
  it("reconstructs WebKit's opaque iOS origin without admitting the opaque string",async()=>{
    vi.stubGlobal("location",{origin:"null",href:"capacitor://app.tasknotes.dev/index.html"});
    try {
      expect(currentAppOrigin()).toBe("capacitor://app.tasknotes.dev");
      const select=await selector("capacitor://app.tasknotes.dev/sdk/application/packaged-assets.js");
      expect(select("lab",currentAppOrigin()!).runtime.url).toBe("capacitor://app.tasknotes.dev/sdk/native/runtime.wasm");
      expect(()=>select("lab","null")).toThrow();
    } finally {vi.unstubAllGlobals();}
  });
  it("refuses a foreign module anchor",async()=>{const select=await selector("https://foreign.test/sdk/application/a.js");expect(()=>select("lab","https://app.test")).toThrow();});
  it("selector uses the canonical packaging pins without exposing build provenance or initializer metadata",async()=>{
    const select=await selector("https://app.test/sdk/application/packaged-assets.js");
    const assets=select("lab","https://app.test");
    expect(assets.runtime).toEqual({url:"https://app.test/sdk/native/runtime.wasm",sha256:pins.runtime.sha256,bytes:pins.runtime.bytes,maxBytes:pins.runtime.maxBytes});
    expect(assets.sqlite).toEqual({url:"https://app.test/sdk/native/sqlite3.wasm",sha256:pins.sqlite.sha256,bytes:pins.sqlite.bytes,maxBytes:pins.sqlite.maxBytes});
    expect(Object.isFrozen(assets.runtime)).toBe(true);
    expect(Object.isFrozen(assets.sqlite)).toBe(true);
  });
  it("initializer refuses UI before import/initialization",async()=>{const select=await selector("https://app.test/sdk/application/packaged-assets.js");await expect(select("lab","https://app.test").initializeSqlite({wasmBinary:new Uint8Array([0]),print(){},printErr(){}})).rejects.toThrow("SDK packaged application assets unavailable");});
});
