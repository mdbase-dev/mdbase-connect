import {afterEach,expect,it,vi} from "vitest";
import {markCollectionOpen} from "../src/application/startup-timing.js";
import type {MdbaseSnapshot} from "../src/application/front-door.js";
import {connect} from "../src/client.js";
import {MemoryReplica} from "../src/testing/index.js";

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it("marks requested, approval and usable connection transitions without payloads",()=>{
  const mark=vi.fn();vi.stubGlobal("performance",{mark});
  const snapshot=(id:string|null,approved:boolean,kind:string,connection?:object)=>({
    selection:{requested:{collectionId:id,approved}},phase:{kind,connection},
  }) as Pick<MdbaseSnapshot,"selection"|"phase">;
  const requested=snapshot("private-id",false,"signed_out");
  const approved=snapshot("private-id",true,"opening");
  const ready=snapshot("private-id",true,"ready",{});
  markCollectionOpen(requested.selection,requested.phase);
  markCollectionOpen(approved.selection,approved.phase,requested);
  markCollectionOpen(ready.selection,ready.phase,approved);
  markCollectionOpen(ready.selection,ready.phase,ready);
  const next=snapshot("other-private-id",true,"opening");
  markCollectionOpen(next.selection,next.phase,ready);
  expect(mark.mock.calls).toEqual([
    ["mdbase:open:requested"],["mdbase:open:approved"],["mdbase:open:ready"],
    ["mdbase:open:requested"],["mdbase:open:approved"],
  ]);
});

it.each([false,true])("marks only the first successful query, including empty answers; no performance: %s",async absent=>{
  const mark=vi.fn();if(absent)vi.stubGlobal("performance",undefined);else vi.spyOn(performance,"mark").mockImplementation(mark);
  const client=await connect({connector:new MemoryReplica().connector(),app:{name:"timing-test",version:"0"},reconnect:false});
  try{
    const call=vi.spyOn(client,"call").mockRejectedValueOnce(new Error("query failed"));
    await expect(client.query({})).rejects.toThrow("query failed");
    expect(mark).not.toHaveBeenCalled();call.mockRestore();
    const results=await Promise.all([client.query({}),client.query({})]);
    expect(results[0].records).toEqual([]);
    expect(mark.mock.calls).toEqual(absent?[]:[["mdbase:query:first-result"]]);
  }finally{client.close();}
});

it("marks a validated contract query as the first answer and skips rejected contract answers",async()=>{
  const mark=vi.spyOn(performance,"mark").mockImplementation(vi.fn());
  const client=await connect({connector:new MemoryReplica().connector(),app:{name:"timing-test",version:"0"},reconnect:false});
  try{
    const call=vi.spyOn(client,"call").mockResolvedValueOnce({version:2});
    await expect(client.queryContract({id:"test",version:"1"})).rejects.toMatchObject({code:"upgrade_required"});
    expect(mark).not.toHaveBeenCalled();
    call.mockResolvedValue({version:1,records:[],page:{records:[]}});
    await client.queryContract({id:"test",version:"1"});call.mockRestore();
    await client.query({});
    expect(mark.mock.calls).toEqual([["mdbase:query:first-result"]]);
  }finally{client.close();}
});

it("counts the first live snapshot, once for the records client",async()=>{
  const mark=vi.spyOn(performance,"mark").mockImplementation(vi.fn());
  const client=await connect({connector:new MemoryReplica().connector(),app:{name:"timing-test",version:"0"},reconnect:false});
  const live=client.live({});
  try{
    await live.ready;await client.query({});
    expect(mark.mock.calls).toEqual([["mdbase:query:first-result"]]);
  }finally{live.close();client.close();}
});
