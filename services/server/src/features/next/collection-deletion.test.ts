import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "../../database-types.js";
import { mergeCollectionDeletionFloors, type CollectionDeletionFact } from "./collection-deletion.js";

const fact = (): CollectionDeletionFact => ({collection:randomUUID(),deletionId:randomUUID(),lifecycleEpoch:(1n<<64n)-1n});
function peer(onWrite = () => {}) {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => {
    onWrite(); return {rows:[],rowCount:1,command:"INSERT",oid:0,fields:[]};
  });
  const client: DatabaseConnection = {query,release:()=>{}};
  return {client,query};
}
describe("bounded deletion DTO admission (mock database, no native effects)",()=>{
  it("captures only the three validated primitive fields, never unrelated getters",async()=>{
    const value=fact(), original={...value}, reads={collection:0,deletionId:0,lifecycleEpoch:0};
    const input={
      get collection(){reads.collection++;return value.collection;},
      get deletionId(){reads.deletionId++;return value.deletionId;},
      get lifecycleEpoch(){reads.lifecycleEpoch++;return value.lifecycleEpoch;},
      get unrelated(){throw new Error("unbounded extra property must not be copied");},
    };
    const {client,query}=peer(()=>{value.collection=randomUUID();value.deletionId=randomUUID();value.lifecycleEpoch=1n;});
    await mergeCollectionDeletionFloors(client,[input]);
    expect(reads).toEqual({collection:1,deletionId:1,lifecycleEpoch:1});
    expect(query.mock.calls[0][1]).toEqual([original.collection,original.deletionId,original.lifecycleEpoch.toString()]);
  });
  it("snapshots every row before the first database await, preserving the full u64",async()=>{
    const input=[fact(),fact()], originals=input.map(v=>({...v}));
    const {client,query}=peer(()=>{for(const v of input){v.collection=randomUUID();v.deletionId=randomUUID();v.lifecycleEpoch=1n;}});
    await mergeCollectionDeletionFloors(client,input);
    expect(query.mock.calls.map(call=>call[1])).toEqual(originals.map(v=>[v.collection,v.deletionId,v.lifecycleEpoch.toString()]));
  });
  it("refuses non-primitive/coercible UUIDs without coercion or any writes",async()=>{
    const stringify=vi.fn(()=>randomUUID());
    const {client,query}=peer();
    for(const invalid of [{toString:stringify},36,null,undefined,new String(randomUUID())]){
      const value={...fact(),collection:invalid} as unknown as CollectionDeletionFact;
      await expect(mergeCollectionDeletionFloors(client,[fact(),value])).rejects.toThrow("invalid_collection_deletion_uuid");
    }
    expect(stringify).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
  });
  it("refuses noncanonical length, nil and alternate UUID text before any writes",async()=>{
    const {client,query}=peer(), id=randomUUID();
    for(const invalid of [id+"\n",id+" ",` ${id}`,id.replaceAll("-",""),"00000000-0000-0000-0000-000000000000","é".repeat(36)]){
      const value={...fact(),deletionId:invalid};
      await expect(mergeCollectionDeletionFloors(client,[fact(),value])).rejects.toThrow("invalid_collection_deletion_uuid");
    }
    expect(query).not.toHaveBeenCalled();
  });
});
