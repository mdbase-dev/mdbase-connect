import {afterEach,describe,expect,it,vi} from "vitest";
import {MdbaseConnect,createMdbase,MdbaseApplicationUnavailableError,type MdbaseApplicationDeclaration,type MdbaseApplicationConnection,type MdbaseClient,type FilesApi,type MdbasePeopleClient} from "../src/index.js";
import {parseAppManifest} from "@mdbase-dev/connect-protocol/manifest";
import * as Manifest from "../src/application/manifest.js";
const origin="https://app.test",id="5cdfa020-c201-4da8-845a-f2cc9969eade";
function declaration():MdbaseApplicationDeclaration{return{id,name:"TaskNotes",origin,environment:"production",manifest:parseAppManifest({manifest_version:1,id:"dev.tasknotes.entry",name:"TaskNotes",homepage:origin,redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"]}}})};}
// Compile-only check: the public surface borrows the actual SDK types.
function borrowed(c:MdbaseApplicationConnection):[MdbaseClient,FilesApi,MdbasePeopleClient]{return[c.records,c.files,c.people];}
void borrowed;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("public entry on a host without an SDK module Worker",()=>{
  it("compiles once per entry before any registration and does not share an instance cache",()=>{
    const compile=vi.spyOn(Manifest,"compileApplicationManifest"),fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    new MdbaseConnect(declaration());expect(compile).toHaveBeenCalledOnce();
    new MdbaseConnect(declaration());expect(compile).toHaveBeenCalledTimes(2);expect(fetcher).not.toHaveBeenCalled();
    const invalid={...declaration(),manifest:{...declaration().manifest as object,manifest_version:999}};
    expect(()=>new MdbaseConnect(invalid)).toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
  it("exports declaration-only singleton and honest unavailable snapshots, never fake connection/READY",()=>{
    const connect=new MdbaseConnect(declaration()),app=connect.application();expect(connect.application()).toBe(app);expect(connect.connection(id)).toBeNull();
    const snapshot=app.getSnapshot();expect(snapshot.status).toBe("blocked");expect(snapshot.problem).toBe("application_not_yet_available");expect(snapshot.signIn).toBeNull();expect(snapshot.selectedCollectionId).toBeNull();expect(snapshot.readiness.assessment).toBeNull();expect(snapshot.selection).toEqual({state:"none",requested:{collectionId:null,source:"none",displayName:null,approved:false},usable:null,problem:null});
    expect(Object.keys(snapshot.readiness.facets).sort()).toEqual(["capabilities","configuration","contracts","files","notifications","people"]);
    for(const facet of Object.values(snapshot.readiness.facets)){expect(facet.assessment).toBeNull();expect(facet.checking).toBe(false);}
    expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.readiness.facets)).toBe(true);expect(app.subscribe(vi.fn())).toBeTypeOf("function");
    // The front door: the same entry, with the derived phase always present.
    const mdbase=createMdbase(declaration());expect(mdbase.getSnapshot().phase).toMatchObject({kind:"unavailable",problem:{key:"application_not_yet_available"}});expect(mdbase.connection(id)).toBeNull();
  });
  it("lifecycle signatures return explicit typed not-yet-available errors without runtime IO",async()=>{
    const fetcher=vi.fn(),open=vi.fn(),uuid=vi.spyOn(crypto,"randomUUID"),keys=vi.spyOn(crypto.subtle,"generateKey");vi.stubGlobal("fetch",fetcher);vi.stubGlobal("indexedDB",{open});
    const app=new MdbaseConnect(declaration()).application();
    for(const request of [()=>app.start(),()=>app.authorize(),()=>app.select(id),()=>app.approve(id),()=>app.reauthorize(),()=>app.chooseAnother(),()=>app.assess(),()=>app.configure(),()=>app.clearSelection(),()=>app.forget(id),()=>app.close()])await expect(request()).rejects.toMatchObject({name:"MdbaseApplicationUnavailableError",code:"application_not_yet_available"});
    expect(()=>app.setForeground(true)).toThrow(MdbaseApplicationUnavailableError);expect(fetcher).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();expect(uuid).not.toHaveBeenCalled();expect(keys).not.toHaveBeenCalled();
  });
  it("canonical typed manifest builders need no casts; unsupported constructor authority still refuses",()=>{
    expect(()=>new MdbaseConnect(declaration())).not.toThrow();const invalid={...declaration(),loadRuntime:vi.fn()};expect(()=>new MdbaseConnect(invalid)).toThrow();
  });
});
