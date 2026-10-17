import {describe,expect,it} from "vitest";
import {probeBrowserCapabilities,type BrowserCapabilityEnvironment} from "../src/application/browser-capabilities.js";
import {applicationPhase} from "../src/application/phase.js";
import {describeError} from "../src/describe-error.js";

const capable:BrowserCapabilityEnvironment={
  subtle:{generateKey:async()=>({})},
  abortSignalAny:true,randomUUID:true,worker:true,messageChannel:true,locks:true,broadcastChannel:true,indexedDB:true,
  getDirectory:async()=>({}),
};

describe("browser capability probe",()=>{
  it("passes a current browser",async()=>{
    await expect(probeBrowserCapabilities(capable)).resolves.toEqual({ok:true});
  });
  it("names every missing feature at once",async()=>{
    const env={...capable,subtle:undefined,abortSignalAny:false,locks:false};
    await expect(probeBrowserCapabilities(env)).resolves.toMatchObject({ok:false,problem:"browser_unsupported",missing:["web_crypto","abort_signal_any","web_locks"]});
  });
  it("fails only on x25519 when key generation rejects",async()=>{
    const env={...capable,subtle:{generateKey:async()=>{throw new Error("not supported");}}};
    await expect(probeBrowserCapabilities(env)).resolves.toMatchObject({ok:false,problem:"browser_unsupported",missing:["x25519"]});
  });
  it("reads rejected OPFS (private browsing) as storage unavailable, not an old browser",async()=>{
    const env={...capable,getDirectory:async()=>{throw new Error("unknown transient reason");}};
    await expect(probeBrowserCapabilities(env)).resolves.toMatchObject({ok:false,problem:"application_storage_unavailable",missing:["opfs"]});
    await expect(probeBrowserCapabilities({...capable,getDirectory:undefined})).resolves.toMatchObject({ok:false,problem:"application_storage_unavailable"});
  });
  it("does not touch storage when a core feature is already missing",async()=>{
    let asked=false;const env={...capable,worker:false,getDirectory:async()=>{asked=true;return{};}};
    await probeBrowserCapabilities(env);expect(asked).toBe(false);
  });
});

describe("capability problems reach people through the existing phase and copy",()=>{
  it("describes both problems and the save warning in plain words",()=>{
    for(const code of ["browser_unsupported","application_storage_unavailable","storage_may_be_evicted"]as const){
      const d=describeError(code)!;expect(d.key).toBe(code);expect(d.title).not.toMatch(/_/);expect(d.message).not.toContain(code);
    }
  });
  it("routes both gate problems to the unavailable phase",()=>{
    for(const problem of ["browser_unsupported","application_storage_unavailable"]as const){
      const phase=applicationPhase({status:"blocked",problem,signIn:null,collections:[],selectedCollectionId:null,selection:{state:"none",requested:{collectionId:null,source:"none",displayName:null,approved:false},usable:null,problem:null},readiness:{checking:false,assessment:null,problem:null,facets:{}as never}}as never,{});
      expect(phase.kind).toBe("unavailable");
      if(phase.kind==="unavailable")expect(phase.problem.key).toBe(problem);
    }
  });
});
