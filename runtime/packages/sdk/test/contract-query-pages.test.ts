import {describe,expect,it,vi} from "vitest";
import {connect} from "../src/client.js";
import {MemoryReplica} from "../src/testing/index.js";

const contract={id:"mdbase.person",version:"2.0.0"};
describe("bounded contract query pages",()=>{
  it("clamps oversized pages and forwards the same cursor and predicate on continuation",async()=>{
    const replica=new MemoryReplica(),client=await connect({connector:replica.connector(),app:{name:"test",version:"0"},reconnect:false});
    try {
      const call=vi.spyOn(client,"call").mockResolvedValue({version:1,contractDigest:"a".repeat(64),records:[],page:{records:[],complete:true,asOf:0,cursor:"same-contract-cursor"}});
      const options={pageSize:500,where:'name != ""'};
      const first=await client.queryContract(contract,options);
      await client.queryContract(contract,{...options,cursor:first.page.cursor});
      expect(options.pageSize).toBe(500);
      expect(call.mock.calls.map(([method,params])=>[method,(params as Map<number,unknown>).get(3),(params as Map<number,unknown>).get(4),(params as Map<number,unknown>).get(5)])).toEqual([
        ["query_contract_v1",128,undefined,'name != ""'],["query_contract_v1",128,"same-contract-cursor",'name != ""'],
      ]);
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
});
