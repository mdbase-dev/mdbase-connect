import {afterEach,describe,expect,it,vi} from "vitest";
import {MdbaseClient} from "../src/client.js";
import {MdbasePeopleClient} from "../src/people.js";
import {MemoryReplica} from "../src/testing/index.js";
import * as WebCollection from "../src/app-host/web-collection.js";
import {ApplicationUiConnections} from "../src/application/ui-connections.js";
const collection="33333333-3333-4333-8333-333333333333",other="44444444-4444-4444-8444-444444444444";
const cleanup:Array<()=>Promise<void>|void>=[];
function handoff():WebCollection.AppWebCollectionHandoff{
  const data=new MessageChannel(),control=new MessageChannel();cleanup.push(()=>{data.port1.close();data.port2.close();control.port1.close();control.port2.close();});
  return {schema:"mdbn-app-collection/1",scope:{account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection},generation:crypto.randomUUID(),displayName:"Original collection",setupMode:"inspect",dataPort:data.port1,controlPort:control.port1,people:true};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
async function fixture(id=collection){
  // Actual SDK MemoryReplica/Session/MdbaseClient. The connector redirection is
  // an explicit transport stand-in, NOT native, people authority or READY proof.
  const client=await MdbaseClient.connect({app:{name:"Fixture",version:"1"},connector:new MemoryReplica({collection:id}).connector()});
  const connect=vi.spyOn(MdbaseClient,"connect").mockResolvedValue(client),global=new AbortController(),caller=new AbortController(),owner=new ApplicationUiConnections({name:"Fixture",version:"1"},global.signal);
  cleanup.push(async()=>{await owner.close().catch(()=>{});client.close();});
  return{client,connect,global,caller,owner,options:{caller:caller.signal,isCurrent:()=>true},value:handoff()};
}
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks();});
describe("SDK UI original borrowed connection ownership",()=>{
  it("returns SAME actual client/files/people, captures original metadata and keeps journal private",async()=>{
    const f=await fixture(),entered=deferred<void>(),gate=deferred<MdbaseClient>();f.connect.mockImplementation(()=>{entered.resolve();return gate.promise;});
    const result=f.owner.adopt(f.value,f.options);await entered.promise;Reflect.set(f.value,"people",false);Reflect.set(f.value,"displayName","Replacement");Reflect.set(f.value.scope,"collection",other);gate.resolve(f.client);
    const c=await result;expect(c.records).toBe(f.client);expect(c.files).toBe(f.client.files);expect(c.people).toBeInstanceOf(MdbasePeopleClient);expect(c.people).toBe(f.owner.owned()!.people);expect(c.id).toBe(collection);expect(c.displayName).toBe("Original collection");expect(c.scope.collection).toBe(collection);expect(c.isCurrent()).toBe(true);expect(f.owner.connection(collection)).toBe(c);expect(f.owner.connection(other)).toBeNull();expect("journal"in c).toBe(false);expect("host"in c).toBe(false);expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("retires immediately and stops original borrowed reads; close is not a native drain certificate",async()=>{
    const f=await fixture(),c=await f.owner.adopt(f.value,f.options),retired=f.owner.retire();expect(c.isCurrent()).toBe(false);expect(f.owner.connection(collection)).toBeNull();expect(c.records.link).toBe("closed");await retired;
    await expect(c.records.query({})).rejects.toMatchObject({code:"unavailable"});const first=f.owner.close();expect(f.owner.close()).toBe(first);await first;
  });
  it("refuses actual client collection mismatch rather than relabeling the genuine client",async()=>{
    const f=await fixture(other);await expect(f.owner.adopt(f.value,f.options)).rejects.toMatchObject({code:"application_connection_binding"});expect(f.owner.connection(collection)).toBeNull();expect(f.client.link).toBe("closed");
  });
  it("owns an ignored-abort late actual client, retains pending slot and never delivers retired scope",async()=>{
    const f=await fixture(),entered=deferred<void>(),gate=deferred<MdbaseClient>();f.connect.mockImplementation(()=>{entered.resolve();return gate.promise;});
    const result=f.owner.adopt(f.value,f.options),refused=expect(result).rejects.toMatchObject({reason:"fenced"});await entered.promise;f.caller.abort();
    await expect(f.owner.adopt(handoff(),f.options)).rejects.toMatchObject({code:"application_connection_busy"});gate.resolve(f.client);await refused;expect(f.owner.connection(collection)).toBeNull();expect(f.client.link).toBe("closed");
  });
  it("duplicate/mixed ports never close another already-owned generation",async()=>{
    const f=await fixture(),c=await f.owner.adopt(f.value,f.options),next=handoff(),fresh=vi.spyOn(next.controlPort,"close"),original=vi.spyOn(f.value.dataPort,"close");
    await expect(f.owner.adopt({...next,dataPort:f.value.dataPort},f.options)).rejects.toMatchObject({code:"application_connection_binding"});expect(fresh).toHaveBeenCalledOnce();expect(original).not.toHaveBeenCalled();expect(c.isCurrent()).toBe(true);
  });
  it("memoizes a failed UI closer and quarantines the original rather than borrowing a replacement",async()=>{
    const f=await fixture(),open=WebCollection.openAppWebCollectionClient,failure=new Error("declared UI closer failure"),stop=vi.fn(()=>{throw failure;});
    vi.spyOn(WebCollection,"openAppWebCollectionClient").mockImplementation(async(value,options)=>({...await open(value,options),close:stop}));
    const c=await f.owner.adopt(f.value,f.options),first=f.owner.retire();await expect(first).rejects.toBe(failure);expect(f.owner.retire()).toBe(first);expect(c.isCurrent()).toBe(false);expect(stop).toHaveBeenCalledOnce();await expect(f.owner.adopt(handoff(),f.options)).rejects.toMatchObject({code:"application_connection_busy"});expect(f.connect).toHaveBeenCalledTimes(1);
  });
});
