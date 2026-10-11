import {describe,expect,it,vi} from "vitest";
import {applicationDeclaration,type MdbaseApplicationDeclaration} from "../src/application/declaration.js";
const id="5cdfa020-c201-4da8-845a-f2cc9969eade";
function declaration():MdbaseApplicationDeclaration{return{id,name:"TaskNotes",origin:"https://tasknotes.dev",environment:"production",manifest:{id:"dev.tasknotes.tasknotes",name:"TaskNotes",distribution:"web",requirements:{access:"full_collection",contracts:[]}}};}
describe("generic application declaration custody (not registration/trust/manifest semantics)",()=>{
  it("keeps actual registered app ID separate from optional original storage compatibility data",()=>{
    const source=declaration(),storage={joinDatabaseName:"tasknotes.native-collection-join.v1",setupDatabaseName:"tasknotes.native-model-setup.v1",applicationNamespace:"tasknotes-web"};
    const copy=applicationDeclaration({...source,storage});expect(copy.id).toBe(id);expect(copy.manifest.id).toBe("dev.tasknotes.tasknotes");expect(copy.storage).toEqual(storage);
    storage.applicationNamespace="replacement";expect(copy.storage.applicationNamespace).toBe("tasknotes-web");expect(Object.isFrozen(copy.storage)).toBe(true);
  });
  it("new declarations derive defaults from exact ID without copying another application's names or asserting registration",()=>{
    const copy=applicationDeclaration({...declaration(),id:"dev.tasknotes.planner",name:"Planner",origin:"https://planner.tasknotes.dev"});
    expect(copy.id).toBe("dev.tasknotes.planner");expect(copy.storage).toEqual({joinDatabaseName:"mdbase.dev.tasknotes.planner.native-collection-join.v1",setupDatabaseName:"mdbase.dev.tasknotes.planner.native-model-setup.v1",applicationNamespace:"dev.tasknotes.planner"});
    expect("applicationId" in copy).toBe(false);expect("registered" in copy).toBe(false);
  });
  it("snapshots declaration and nested manifest before any asynchronous loader/storage work",()=>{
    const source=declaration(),copy=applicationDeclaration(source);(source as {id:string}).id="other";(source.manifest as {name:string}).name="Other";
    expect(copy.id).toBe(id);expect(copy.manifest.name).toBe("TaskNotes");expect(Object.isFrozen(copy)).toBe(true);expect(Object.isFrozen(copy.manifest.requirements)).toBe(true);
    expect(copy.manifest.requirements).toEqual({access:"full_collection",contracts:[]});expect("capabilities" in (copy.manifest.requirements as object)).toBe(false);
  });
  it.each(["http://tasknotes.dev","https://tasknotes.dev/path"])("refuses unsafe/nonexact production origin %s without normalization",origin=>{expect(()=>applicationDeclaration({...declaration(),origin})).toThrow("application declaration");});
  it("explicit lab only permits loopback HTTP, not arbitrary insecure origin",()=>{
    expect(applicationDeclaration({...declaration(),environment:"lab",origin:"http://127.0.0.1:32111"}).origin).toBe("http://127.0.0.1:32111");
    expect(()=>applicationDeclaration({...declaration(),environment:"lab",origin:"http://foreign.test"})).toThrow("application declaration");
  });
  it.each(["trustedRoots"])("declaration does not accept app-supplied %s plumbing/authority",key=>{expect(()=>applicationDeclaration({...declaration(),[key]:"not-declaration-data"})).toThrow("application declaration");});
  it("refuses accessors/custom serialization/prototypes without invoking them",()=>{
    const getter=vi.fn(()=>"replacement"),source=declaration();Object.defineProperty(source,"name",{enumerable:true,get:getter});
    expect(()=>applicationDeclaration(source)).toThrow("application declaration");expect(getter).not.toHaveBeenCalled();
    expect(()=>applicationDeclaration({...declaration(),manifest:Object.assign(Object.create({inherited:true}),{id:"x"})})).toThrow("application declaration");
    expect(()=>applicationDeclaration({...declaration(),manifest:{toJSON:vi.fn()} as unknown as MdbaseApplicationDeclaration["manifest"]})).toThrow("application declaration");
  });
  it("never aliases storage collisions, invalid names or nil application ID",()=>{
    expect(()=>applicationDeclaration({...declaration(),storage:{joinDatabaseName:"same",setupDatabaseName:"same"}})).toThrow("application declaration");
    expect(()=>applicationDeclaration({...declaration(),storage:{applicationNamespace:"bad\0namespace"}})).toThrow("application declaration");
    expect(()=>applicationDeclaration({...declaration(),id:"00000000-0000-0000-0000-000000000000"})).toThrow("application declaration");
  });
});
