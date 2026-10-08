import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { mergeCollectionDeletionFloors, reconcileCollectionDeletionFloors, type CollectionDeletionFact, type CollectionDeletionPage } from "./collection-deletion.js";

const fact = (): CollectionDeletionFact => ({collection:randomUUID(),deletionId:randomUUID(),lifecycleEpoch:(1n<<64n)-1n});
function peer(onWrite = () => {}) {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => {
    onWrite(); return {rows:[],rowCount:1,command:"INSERT",oid:0,fields:[]};
  });
  const client: DatabaseConnection = {query,release:()=>{}};
  return {client,query};
}
describe("public reconciliation DTO admission (mock database, no native effects)",()=>{
  const max=(1n<<64n)-1n;
  const empty=():CollectionDeletionPage=>({generation:0n,rows:[],after:null,done:true});
  function database(onConnect=()=>{}) {
    const {client,query}=peer(), connect=vi.fn(async()=>{onConnect();return client;});
    return {db:{connect} as unknown as DatabasePool,connect,query};
  }
  it("captures only validated page/row primitives once before connect, including continuations and final confirmation",async()=>{
    const values=Array.from({length:129},(_,i)=>({...fact(),collection:`${(i+1).toString(16).padStart(8,"0")}-0000-4000-8000-000000000000`}));
    const originals=values.map(v=>({...v})), rowReads=values.map(()=>({collection:0,deletionId:0,lifecycleEpoch:0}));
    const inputs=values.map((v,i)=>({
      get collection(){rowReads[i]!.collection++;return v.collection;},
      get deletionId(){rowReads[i]!.deletionId++;return v.deletionId;},
      get lifecycleEpoch(){rowReads[i]!.lifecycleEpoch++;return v.lifecycleEpoch;},
      get unrelated(){throw new Error("row passthrough");},
    }));
    const pages:CollectionDeletionPage[]=[{generation:max,rows:inputs.slice(0,128),after:originals[127]!.collection,done:false},
      {generation:max,rows:inputs.slice(128),after:originals[128]!.collection,done:true},
      {generation:max,rows:[],after:originals[128]!.collection,done:true}];
    const reads=pages.map(()=>({generation:0,rows:0,after:0,done:0}));let calls=0,current=-1;
    const registry={registryCollectionDeletions:vi.fn(async(after:string|null,expected:bigint|null)=>{
      const index=calls++;current=index;const source=pages[index]!;
      expect(after).toBe(index===0?null:originals[index===1?127:128]!.collection);expect(expected).toBe(index===0?null:max);
      return {get generation(){reads[index]!.generation++;return source.generation;},get rows(){reads[index]!.rows++;return source.rows;},
        get after(){reads[index]!.after++;return source.after;},get done(){reads[index]!.done++;return source.done;},
        get unrelated(){throw new Error("page passthrough");}};
    })};
    const {db,connect,query}=database(()=>{
      const source=pages[current]!;
      for(const input of values.slice(current===0?0:128,current===0?128:129)){input.collection=randomUUID();input.deletionId=randomUUID();input.lifecycleEpoch=0n;}
      source.generation=0n;source.rows=[];source.after=randomUUID();source.done=!source.done;
    });
    expect(await reconcileCollectionDeletionFloors(db,registry)).toBe(max);
    expect(reads).toEqual(pages.map(()=>({generation:1,rows:1,after:1,done:1})));
    expect(rowReads).toEqual(values.map(()=>({collection:1,deletionId:1,lifecycleEpoch:1})));
    expect(connect).toHaveBeenCalledTimes(2);expect(registry.registryCollectionDeletions).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.filter(call=>call[1]!==undefined).map(call=>call[1])).toEqual(originals.map(v=>[v.collection,v.deletionId,v.lifecycleEpoch.toString()]));
  });
  it.each([-1n,max+1n,0,NaN,undefined,{valueOf(){throw new Error("coercion");}}])("refuses invalid runtime generation %s before connecting",async(generation)=>{
    const {db,connect}=database();const registry={registryCollectionDeletions:async()=>({...empty(),generation} as unknown as CollectionDeletionPage)};
    await expect(reconcileCollectionDeletionFloors(db,registry)).rejects.toThrow("invalid_collection_deletion_generation");expect(connect).not.toHaveBeenCalled();
  });
  it("refuses malformed bounds, tuples, cursor, ordering and done counts before connecting",async()=>{
    const first=fact(),second={...fact(),collection:first.collection};
    const invalid:unknown[]=[{...empty(),rows:null},{...empty(),rows:{length:0}},{...empty(),rows:Array.from({length:129},()=>fact())},
      {...empty(),done:1},{...empty(),done:false},{...empty(),rows:[first],after:null},
      {...empty(),rows:[first],after:randomUUID()},{...empty(),rows:[first,second],after:first.collection},
      {...empty(),rows:[{...first,lifecycleEpoch:0n}],after:first.collection},
      {...empty(),rows:[first],after:first.collection,done:false},
      {...empty(),rows:Array.from({length:128},(_,i)=>({...fact(),collection:`${(i+1).toString(16).padStart(8,"0")}-0000-4000-8000-000000000000`})),after:"00000080-0000-4000-8000-000000000000",done:true}];
    for(const after of ["00000000-0000-0000-0000-000000000000",first.collection+"\n",new String(first.collection),undefined])invalid.push({...empty(),after});
    const ordered=[first,fact()].sort((a,b)=>a.collection<b.collection?-1:1);
    invalid.push({...empty(),rows:ordered.toReversed(),after:ordered[0]!.collection});
    const {db,connect}=database();
    for(const page of invalid)await expect(reconcileCollectionDeletionFloors(db,{registryCollectionDeletions:async()=>page as CollectionDeletionPage})).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it("admits the final check through the same strict DTO boundary, retaining prior commits on refusal",async()=>{
    for(const final of [{...empty(),done:"truthy"},{...empty(),rows:{length:0}},{...empty(),after:undefined}]){
      const {db,connect,query}=database();let calls=0;
      await expect(reconcileCollectionDeletionFloors(db,{registryCollectionDeletions:async()=>calls++===0?empty():final as unknown as CollectionDeletionPage})).rejects.toThrow();
      expect(connect).toHaveBeenCalledOnce();expect(query.mock.calls.map(call=>call[0])).toEqual(["BEGIN","COMMIT"]);
    }
  });
});
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
