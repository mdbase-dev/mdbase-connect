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

it("marks each opening stage transition on the main thread with fixed stage names only",()=>{
  const mark=vi.fn();vi.stubGlobal("performance",{mark});
  const opening=(id:string,progress?:string|null,slow=false)=>({
    selection:{requested:{collectionId:id,approved:true}},
    phase:{kind:"opening",collectionId:id,displayName:"Secret Notes",slow,...(progress===undefined?{}:{progress})},
  }) as unknown as Pick<MdbaseSnapshot,"selection"|"phase">;
  const stages=["joining","opening_store","connecting_log","syncing","waiting_for_key","loading_snapshot","replaying","verifying_read","checking_setup"] as const;
  let prev=opening("col-a");
  markCollectionOpen(prev.selection,prev.phase);
  for(const stage of stages){
    const next=opening("col-a",stage);
    markCollectionOpen(next.selection,next.phase,prev);
    prev=next;
  }
  // Unchanged stage (e.g. slow flag toggling) does not re-emit; returning to a stage does.
  const slowSame=opening("col-a","checking_setup",true);
  markCollectionOpen(slowSame.selection,slowSame.phase,prev);
  const revisit=opening("col-a","syncing");
  markCollectionOpen(revisit.selection,revisit.phase,slowSame);
  // Switching collections at the same stage marks the new collection's transition.
  const other=opening("col-b","syncing");
  markCollectionOpen(other.selection,other.phase,revisit);
  // Non-allowlisted or absent progress never emits a mark.
  for(const invalid of [null,undefined,"Secret Notes","/tmp/vault","11111111-1111-4111-8111-111111111111"]){
    const bad=opening("col-b",invalid);
    markCollectionOpen(bad.selection,bad.phase,other);
  }
  expect(mark.mock.calls).toEqual([
    ["mdbase:open:requested"],["mdbase:open:approved"],
    ...stages.map(stage=>[`mdbase:open:stage:${stage}`]),
    ["mdbase:open:stage:syncing"],
    ["mdbase:open:requested"],["mdbase:open:approved"],["mdbase:open:stage:syncing"],
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
