import {describe,expect,it} from "vitest";
import {effectiveCapabilities} from "../src/index.js";
import type {MdbaseClient} from "../src/client.js";

const declaration=(capabilities?:object)=>({id:"org.example.app",name:"Example",origin:"https://app.test",environment:"production" as const,
  manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:"https://app.test",redirect_uris:["https://app.test/callback"],
    requirements:{access:"full_collection",contracts:[],...(capabilities?{capabilities}:{})}}});
const connection=(granted:string[],current=true)=>({records:{hello:{grant:{capabilities:granted,role:"editor"}}} as unknown as MdbaseClient,isCurrent:()=>current});

describe("effectiveCapabilities",()=>{
  it("reports declared optional groups a read-only grant lacks, for step-up via reauthorize",()=>{
    const result=effectiveCapabilities(declaration({contract_version:2,required:["collection.read"],optional:["records.create","records.edit"]}),connection(["collection.read","records.create"]));
    expect(result).toEqual({requiredAvailable:true,missing:["records.edit"],values:[
      {id:"collection.read",requirement:"required",state:"available"},
      {id:"records.create",requirement:"optional",state:"available"},
      {id:"records.edit",requirement:"optional",state:"missing"}]});
    expect(effectiveCapabilities(declaration({contract_version:2,required:["collection.read","records.edit"]}),connection(["collection.read"]))?.requiredAvailable).toBe(false);
  });
  it("is null without a v2 contract and refuses a retired connection",()=>{
    expect(effectiveCapabilities(declaration(),connection(["collection.read"]))).toBeNull();
    expect(()=>effectiveCapabilities(declaration({contract_version:2,required:["collection.read"]}),connection(["collection.read"],false))).toThrow(/not current/);
  });
});
