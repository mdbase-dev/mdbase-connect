import {afterEach,describe,expect,it,vi} from "vitest";
import {applicationAssetLoader,type ApplicationAsset} from "../src/application/asset-loader.js";
const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
const origin="https://app.test",url=`${origin}/assets/runtime.wasm`;
async function asset():Promise<ApplicationAsset>{const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));return{url,sha256:Array.from(digest,x=>x.toString(16).padStart(2,"0")).join(""),bytes:bytes.length,maxBytes:3300000};}
const signal=()=>new AbortController().signal;
afterEach(()=>vi.restoreAllMocks());
describe("SDK-private bundled asset intake (transport integrity, not release authentication)",()=>{
  it("reads exact immutable packaged bytes with no credentials/cache/redirect retry",async()=>{
    const fetcher=vi.fn(async()=>new Response(bytes,{headers:{"content-length":String(bytes.length)}}));
    const source={...await asset()},load=applicationAssetLoader(source,{origin,environment:"production",fetch:fetcher}),caller=signal();source.url="https://foreign.test/changed";source.sha256="0".repeat(64);
    expect(await load({signal:caller})).toEqual(bytes);expect(fetcher).toHaveBeenCalledExactlyOnceWith(url,{signal:caller,credentials:"omit",cache:"no-store",redirect:"error"});
  });
  it.each(["https://foreign.test/runtime.wasm","http://app.test/runtime.wasm"])("refuses unbound source URL %s before fetch",async changed=>{
    const fetcher=vi.fn(),a=await asset();expect(()=>applicationAssetLoader({...a,url:changed},{origin,environment:"production",fetch:fetcher})).toThrow("application asset");expect(fetcher).not.toHaveBeenCalled();
  });
  it("lab HTTP remains explicit loopback-only",async()=>{
    const a=await asset();expect(()=>applicationAssetLoader({...a,url:"http://127.0.0.1:32111/runtime.wasm"},{origin:"http://127.0.0.1:32111",environment:"lab"})).not.toThrow();
    expect(()=>applicationAssetLoader({...a,url:"http://app.test/runtime.wasm"},{origin:"http://app.test",environment:"lab"})).toThrow("application asset");
  });
  it("ignored-abort fetch response stays owned and its stream cancels once before rejection",async()=>{
    const cancel=vi.fn(),caller=new AbortController();let resolve!:(response:Response)=>void;
    const fetcher=vi.fn(()=>new Promise<Response>(r=>{resolve=r;})),load=applicationAssetLoader(await asset(),{origin,environment:"production",fetch:fetcher});
    const result=load({signal:caller.signal});caller.abort();resolve(new Response(new ReadableStream({cancel})));await expect(result).rejects.toMatchObject({reason:"application_asset_fenced"});expect(cancel).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("failed physical reader stop propagates sanitized failure and never retries cancel",async()=>{
    const cancel=vi.fn(()=>{throw new Error("private response details");}),caller=new AbortController(),fetcher=vi.fn(async()=>new Response(new ReadableStream({cancel}))),load=applicationAssetLoader(await asset(),{origin,environment:"production",fetch:fetcher});
    const result=load({signal:caller.signal});await Promise.resolve();await Promise.resolve();caller.abort();await expect(result).rejects.toMatchObject({code:"unavailable",reason:"application_asset_stop_failed",message:"application asset unavailable"});expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([new Uint8Array(9),new Uint8Array(8).fill(2)])("refuses short, long or changed bytes, never returning partial success",async supplied=>{
    const fetcher=vi.fn(async()=>new Response(supplied)),load=applicationAssetLoader(await asset(),{origin,environment:"production",fetch:fetcher});await expect(load({signal:signal()})).rejects.toMatchObject({reason:"application_asset_binding"});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses contradictory content-length and closes without consuming body",async()=>{
    const cancel=vi.fn(),fetcher=vi.fn(async()=>new Response(new ReadableStream({cancel}),{headers:{"content-length":"9"}})),load=applicationAssetLoader(await asset(),{origin,environment:"production",fetch:fetcher});
    await expect(load({signal:signal()})).rejects.toMatchObject({reason:"application_asset_binding"});expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("stream and fetch exceptions do not expose body/provider details or retry",async()=>{
    const fetcher=vi.fn(async()=>{throw new Error("private bearer/account/response");}),load=applicationAssetLoader(await asset(),{origin,environment:"production",fetch:fetcher});
    await expect(load({signal:signal()})).rejects.toMatchObject({reason:"application_asset_fetch",message:"application asset unavailable"});expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
