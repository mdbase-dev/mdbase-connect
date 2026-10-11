import {afterEach,describe,expect,it,vi} from "vitest";
import {MdbaseClient} from "../src/client.js";
import {MemoryReplica} from "../src/testing/index.js";
import {ApplicationScope} from "../src/application/scope.js";
import {applicationDeclaration} from "../src/application/declaration.js";
import * as Web from "../src/app-host/web-collection.js";
import * as Configuration from "../src/application/configuration.js";
const collection="33333333-3333-4333-8333-333333333333",cleanup:Array<()=>Promise<void>|void>=[];
const declaration=applicationDeclaration({id:"org.example.app",name:"Example",origin:"https://app.test",environment:"lab",manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:"https://app.test",redirect_uris:["https://app.test/callback"],requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"],optional:[]}}}});
function handoff():Web.AppWebCollectionHandoff{
 const a=new MessageChannel(),b=new MessageChannel();cleanup.push(()=>{a.port1.close();a.port2.close();b.port1.close();b.port2.close();});return{schema:"mdbn-app-collection/1",scope:{account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection},generation:crypto.randomUUID(),displayName:"Original",setupMode:"inspect",dataPort:a.port1,controlPort:b.port1,people:true};
}
async function fixture(){
 // Actual SDK client/ports/journal/control/people wrappers. Memory transport
 // stand-in only; these tests neither authenticate approval nor qualify native.
 const client=await MdbaseClient.connect({app:{name:"Example",version:"1"},connector:new MemoryReplica({collection}).connector()}),connect=vi.spyOn(MdbaseClient,"connect").mockResolvedValue(client),signal=new AbortController(),owner=new ApplicationScope(declaration,{name:"Example",version:"1"},signal.signal);
 cleanup.push(async()=>{await owner.close().catch(()=>{});client.close();});return{client,connect,signal,owner};
}
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks();});
describe("SDK original scope facet composition",()=>{
 it("passes original private resourceSetup/journal to canonical configuration without public loans",async()=>{
  const f=await fixture(),open=Web.openAppWebCollectionClient,configuration=vi.spyOn(Configuration,"createApplicationConfiguration");let helper:Web.AppWebCollectionClient|undefined;
  vi.spyOn(Web,"openAppWebCollectionClient").mockImplementation(async(...args)=>{helper=await open(...args);return helper;});
  const c=await f.owner.adopt(handoff(),new AbortController().signal,()=>true),input=configuration.mock.calls[0]?.[0],port=configuration.mock.calls[0]?.[1];
  expect(c.records).toBe(f.client);expect(c.files).toBe(f.client.files);expect(input?.client).toBe(f.client);expect(input?.journal).toBe(helper?.journal);expect(port).toBe(helper?.resourceSetup);expect("resourceSetup"in c).toBe(false);expect("journal"in c).toBe(false);expect(f.connect).toHaveBeenCalledTimes(1);expect(f.owner.getReadiness()?.assessment).toBeNull();expect(f.owner.getReadiness()?.facets.files.problem?.code).toBe("files_unsupported");
 });
 it("refuses overlapping handoff without retiring the existing original client",async()=>{
  const f=await fixture(),c=await f.owner.adopt(handoff(),new AbortController().signal,()=>true);
  await expect(f.owner.adopt(handoff(),new AbortController().signal,()=>true)).rejects.toMatchObject({code:"application_connection_busy"});expect(c.isCurrent()).toBe(true);expect(c.records.link).toBe("open");expect(f.owner.connection(collection)).toBe(c);expect(f.connect).toHaveBeenCalledTimes(1);
 });
 it("retirement fences all facets before original UI close/drain, never a native ACK",async()=>{
  const f=await fixture(),c=await f.owner.adopt(handoff(),new AbortController().signal,()=>true),retired=f.owner.retire();expect(c.isCurrent()).toBe(false);expect(f.owner.connection(collection)).toBeNull();expect(f.owner.getReadiness()?.assessment).toBeNull();await retired;expect(f.client.link).toBe("closed");expect(f.owner.getReadiness()).toBeNull();
 });
});
