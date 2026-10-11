import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {resolve, join} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {buildApp} from "./app.js";
import {createDatabase} from "./db.js";

const resources:Array<()=>Promise<void>>=[];
afterAll(async()=>{while(resources.length)await resources.pop()!();});
const id="00000000-0000-4000-8000-000000000001",publicUrl="https://connect.example";
async function fixture(){
  const root=resolve(".tmp");await mkdir(root,{recursive:true});const portalDist=await mkdtemp(join(root,"portal-popup-"));
  resources.push(()=>rm(portalDist,{recursive:true,force:true}));await writeFile(join(portalDist,"index.html"),"<!doctype html><title>synthetic portal</title>");
  const db=await createDatabase("memory");resources.push(()=>db.end());
  const {app}=await buildApp({db,publicUrl,portalDist});resources.push(()=>app.close());return app;
}
describe("approval HTML opener policy",()=>{
  // These GET-only cases share one isolated fixture; no accounts or grants mutate.
  let app:Awaited<ReturnType<typeof fixture>>;
  beforeAll(async()=>{app=await fixture();});
  it.each([`/pair/${id}`,`/pair/${id}/?source=popup`,`/authorize/${id}`,"/device?user_code=ABCD-EFGH"])("retains app opener for %s without relaxing CSP",async url=>{
    const reply=await app.inject({url,headers:{accept:"text/html"}});
    expect(reply.statusCode).toBe(200);expect(reply.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(reply.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(reply.headers["content-security-policy"]).toContain("object-src 'none'");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });
  it.each(["/login","/signup","/reset-password"])("retains flow opener across %s only with a same-origin approval return",async path=>{
    const reply=await app.inject({url:`${path}?return_to=${encodeURIComponent(`${publicUrl}/pair/${id}`)}`,headers:{accept:"text/html"}});
    expect(reply.statusCode).toBe(200);expect(reply.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
  });
  it.each(["/","/login","/settings",`/pair/${id}/extra`,`/pair/not-an-id`,`/pairing/${id}`,`/authorize/not-an-id`,"/login?return_to=https%3A%2F%2Fforeign.example%2Fpair%2F"+id,"/signup?return_to=%2Fsettings"])("keeps ordinary isolation for %s",async url=>{
    const reply=await app.inject({url,headers:{accept:"text/html"}});
    expect(reply.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });
  it("does not relax API or non-HTML responses",async()=>{
    for(const request of [{url:"/v1/auth/config"},{url:`/pair/${id}`,headers:{accept:"application/json"}}]){
      const reply=await app.inject(request);expect(reply.headers["cross-origin-opener-policy"]).toBe("same-origin");
    }
  });
});
