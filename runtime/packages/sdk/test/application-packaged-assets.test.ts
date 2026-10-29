import {build} from "esbuild";
import {describe,expect,it,vi} from "vitest";
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
  it("unbuilt release refuses rather than inventing LAB trust",()=>{expect(()=>packagedApplicationAssets("lab","https://app.test")).toThrow("LAB trust unavailable");});
  it("managed tiers never fall back to a LAB release",async()=>{const select=await selector("https://app.test/sdk/application/packaged-assets.js");for(const tier of ["staging","production"] as const)expect(()=>select(tier,"https://app.test")).toThrow();});
  it("selects the current native pin at the same-artifact URL without I/O",async()=>{
    const select=await selector("https://app.test/sdk/application/packaged-assets.js");
    const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(()=>{throw new Error("unexpected I/O");});
    try {
      const assets=select("lab","https://app.test");
      expect(assets.runtime).toEqual({url:"https://app.test/sdk/native/runtime.wasm",sha256:"7d45ae07741b165b51b39d684c28014fcdf178ceeef05b233c78f7b9fa35137a",bytes:3655960,maxBytes:3655960});
      expect(Object.isFrozen(assets.runtime)).toBe(true); expect(fetch).not.toHaveBeenCalled();
    } finally {fetch.mockRestore();}
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
