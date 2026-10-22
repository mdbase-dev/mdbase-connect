import {describe,expect,it} from "vitest";
import {applicationDeclaration} from "../src/application/declaration.js";
import {compileApplicationManifest} from "../src/application/manifest.js";
import type {ApplicationJson} from "../src/application/declaration.js";
const manifest=()=>({manifest_version:1,id:"org.example.app",name:"Example",homepage:"https://app.test",redirect_uris:["https://app.test/callback"],requirements:{access:"full_collection",contracts:[]}});
const declaration=(data:Record<string,ApplicationJson>)=>applicationDeclaration({id:"11111111-1111-4111-8111-111111111111",name:"Example",origin:"https://app.test",environment:"production",manifest:data});
describe("actual public canonical compiler from qualified protocol718 original artifact",()=>{
  it("bare full_collection is original semantic1/four readonly operations/files omitted, not implicit v2 or writes",()=>{
    const result=compileApplicationManifest(declaration(manifest()));expect(result.semanticVersion).toBe(1);expect(result.operations).toEqual(["describe","changes","read","query"]);expect("files" in result).toBe(false);expect(result.nativeCapabilities).toBeNull();
    expect(result.contracts).toEqual({operation_transport:3,authorization_binding:5,semantic_capabilities:1});
    expect(result.operations).not.toContain("create");expect(result.operations).not.toContain("update");expect(result.operations).not.toContain("list_files");
  });
  it("validated v2 required capability names are exact native projection, not translated wire operations or optional requirements",()=>{
    const result=compileApplicationManifest(declaration({...manifest(),requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read","records.edit"],optional:["records.create"]}}}));
    expect(result.semanticVersion).toBe(2);expect(result.operations).toContain("update");expect(result.operations).toContain("create");expect(result.nativeCapabilities).toEqual({capabilityContractVersion:2,requiredNativeCapabilities:["collection.read","records.edit"]});
    expect(Object.isFrozen(result.nativeCapabilities!.requiredNativeCapabilities)).toBe(true);expect(result.contracts).toEqual({operation_transport:3,authorization_binding:5,semantic_capabilities:2,durable_mutation:1});
  });
  it("keeps the canonical normalized manifest and operation terms isolated/immutable",()=>{
    const original=manifest(),result=compileApplicationManifest(declaration(original));original.name="Changed";original.redirect_uris.push("https://app.test/other");
    expect(result.manifest.name).toBe("Example");expect(result.manifest.distribution).toBeUndefined();expect(Object.isFrozen(result.manifest.requirements)).toBe(true);expect(Object.isFrozen(result.operations)).toBe(true);
  });
  it("compiles a declared manifest whose uniqueItems contract objects need deep equality",()=>{
    const contract=(id:string,n:string)=>({id,version:"1.0.0",digest:`sha256:${n.repeat(64)}`});
    const result=compileApplicationManifest(declaration({...manifest(),requirements:{access:"full_collection",contracts:[contract("tasknotes.task","a"),contract("obsidian.base","b"),contract("mdbase.view","c")],capabilities:{contract_version:2,required:["collection.read","records.edit"]}}}));
    expect(result.manifest.requirements.contracts?.map(c=>c.id)).toEqual(["tasknotes.task","obsidian.base","mdbase.view"]);
  });
  it("never strips malformed/unknown fields or manufactures a v2 capability projection to pass validation",()=>{
    expect(()=>compileApplicationManifest(declaration({...manifest(),unexpected:"must-not-strip"}))).toThrow();
    expect(()=>compileApplicationManifest(declaration({...manifest(),requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["update"]}}}))).toThrow();
  });
});
