import {describe,expect,it,vi} from "vitest";
import {connect} from "../src/client.js";
import {MemoryReplica} from "../src/testing/index.js";

const contract={id:"mdbase.person",version:"2.0.0"};
describe("bounded contract query pages",()=>{
  it("supports larger pages up to 1000, clamps above 1000, and forwards cursor, where, and orderBy",async()=>{
    const replica=new MemoryReplica(),client=await connect({connector:replica.connector(),app:{name:"test",version:"0"},reconnect:false});
    try {
      const call=vi.spyOn(client,"call").mockResolvedValue({version:1,contractDigest:"a".repeat(64),records:[],page:{records:[],complete:true,asOf:0,cursor:"same-contract-cursor"}});
      const options={pageSize:1500,where:'name != ""',orderBy:[{field:"date",direction:"desc" as const}]};
      const first=await client.queryContract(contract,options);
      await client.queryContract(contract,{...options,cursor:first.page.cursor});
      expect(options.pageSize).toBe(1500);
      expect(call.mock.calls.map(([method,params])=>{
        const m=params as Map<number,unknown>;
        return [method,m.get(3),m.get(4),m.get(5),m.get(6)];
      })).toEqual([
        ["query_contract_v1",1000,undefined,'name != ""',[new Map([["field","date"],["direction","desc"]])]],
        ["query_contract_v1",1000,"same-contract-cursor",'name != ""',[new Map([["field","date"],["direction","desc"]])]],
      ]);
    } finally {client.close();}
  });
  it("clamps to 128 and refuses orderBy against older replicas without contract-query-order-v1",async()=>{
    const replica=new MemoryReplica({features:[]}),client=await connect({connector:replica.connector(),app:{name:"test",version:"0"},reconnect:false});
    try {
      const call=vi.spyOn(client,"call").mockResolvedValue({version:1,contractDigest:"a".repeat(64),records:[],page:{records:[],complete:true,asOf:0}});
      await client.queryContract(contract,{pageSize:500});
      expect((call.mock.calls[0]![1] as Map<number,unknown>).get(3)).toBe(128);
      expect((call.mock.calls[0]![1] as Map<number,unknown>).has(6)).toBe(false);
      await expect(client.queryContract(contract,{orderBy:[{field:"date",direction:"desc"}]})).rejects.toMatchObject({code:"upgrade_required",reason:"contract_query_order_unsupported"});
      expect(call).toHaveBeenCalledTimes(1);
    } finally {client.close();}
  });
  it("orders contract pages and binds orderBy to the continuation cursor",async()=>{
    const replica=new MemoryReplica({
      contracts:[{id:"dev.mdbase.writer.manuscript",version:"1.0.0",type:"manuscript",fields:{title:"title",date:"date"}}],
    });
    replica.seed({path:"m/a.md",types:["manuscript"],frontmatter:{title:"A",date:"2026-01-01"}});
    replica.seed({path:"m/b.md",types:["manuscript"],frontmatter:{title:"B",date:"2026-03-01"}});
    replica.seed({path:"m/c.md",types:["manuscript"],frontmatter:{title:"C",date:"2026-02-01"}});
    const client=await connect({connector:replica.connector(),app:{name:"test",version:"0"},reconnect:false});
    try {
      const mContract={id:"dev.mdbase.writer.manuscript",version:"1.0.0"};
      const p1=await client.queryContract(mContract,{pageSize:2,orderBy:[{field:"date",direction:"desc"}]});
      expect(p1.page.records.map(r=>r.path)).toEqual(["m/b.md","m/c.md"]);
      expect(p1.page.cursor).toBeTruthy();
      const p2=await client.queryContract(mContract,{pageSize:2,orderBy:[{field:"date",direction:"desc"}],cursor:p1.page.cursor});
      expect(p2.page.records.map(r=>r.path)).toEqual(["m/a.md"]);
      expect(p2.page.cursor).toBeUndefined();
      await expect(client.queryContract(mContract,{pageSize:2,orderBy:[{field:"date",direction:"asc"}],cursor:p1.page.cursor})).rejects.toMatchObject({code:"invalid_request",reason:"invalid_query_cursor"});
    } finally {client.close();}
  });
  it.each([0,-1,1.5,NaN,Infinity])("rejects invalid page size %s before issuing a request",async pageSize=>{
    const replica=new MemoryReplica(),client=await connect({connector:replica.connector(),app:{name:"test",version:"0"},reconnect:false});
    try {
      const call=vi.spyOn(client,"call");
      await expect(client.queryContract(contract,{pageSize})).rejects.toMatchObject({code:"invalid_request"});
      expect(call).not.toHaveBeenCalled();
    } finally {client.close();}
  });
  it("rejects invalid orderBy before issuing a request",async()=>{
    const replica=new MemoryReplica(),client=await connect({connector:replica.connector(),app:{name:"test",version:"0"},reconnect:false});
    try {
      const call=vi.spyOn(client,"call");
      for (const orderBy of [[], [{field:""}], [{field:"date",direction:"sideways" as "asc"}], Array.from({length:9},(_,i)=>({field:`f${i}`}))]) {
        await expect(client.queryContract(contract,{orderBy})).rejects.toMatchObject({code:"invalid_request",reason:"invalid_query"});
      }
      expect(call).not.toHaveBeenCalled();
    } finally {client.close();}
  });
});
