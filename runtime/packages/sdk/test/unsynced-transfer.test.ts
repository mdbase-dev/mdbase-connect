import {describe,expect,it} from "vitest";
import {connect,isMdbaseError,type MdbaseClient} from "../src/index.js";
import {MemoryReplica} from "../src/testing/index.js";
import {planUnsyncedTransfer,runUnsyncedTransfer,unsyncedTransferComplete} from "../src/application/unsynced-transfer.js";

const app={name:"unsynced-transfer-test",version:"0.0.0"};
const SOURCE="0192f3a4-6000-7abc-8def-000000000001",DESTINATION="0192f3a4-6000-7abc-8def-000000000002";
const A="0192f3a4-6000-7abc-8def-0000000000a1",B="0192f3a4-6000-7abc-8def-0000000000b2",C="0192f3a4-6000-7abc-8def-0000000000c3";

async function pair(seedDestination:(replica:MemoryReplica)=>void=()=>{}){
  const from=new MemoryReplica({collection:SOURCE}),to=new MemoryReplica({collection:DESTINATION});
  from.seed({id:A,path:"notes/first.md",types:["note"],frontmatter:{type:"note",title:"First"},body:"Started before connecting.\n"});
  from.seed({id:B,path:"todo.md",frontmatter:{status:"open"},body:"Buy milk\n"});
  from.seed({id:C,path:"scratch.md",body:"throwaway\n"});
  to.seedType("note");seedDestination(to);
  const source=await connect({connector:from.connector(),app}),destination=await connect({connector:to.connector(),app});
  return {source,destination,to};
}
const all=async(client:MdbaseClient)=>(await client.query({},{body:true})).records;

describe("unsynced transfer",()=>{
  it("keeps IDs, paths and content, and a second run creates nothing",async()=>{
    const {source,destination}=await pair();
    const plan=await planUnsyncedTransfer(source,destination);
    expect(plan.counts).toEqual({create:3,present:0,skipped:0,renamed:0,changed:0});
    expect(plan.missingTypes).toEqual([]);
    const progress:number[]=[];
    const result=await runUnsyncedTransfer(plan,destination,{onProgress:p=>progress.push(p.done)});
    expect(result).toMatchObject({created:3,present:0,failed:[]});expect(result.mutations).toHaveLength(3);
    expect(progress).toEqual([0,1,2,3]);
    const records=await all(destination);
    expect(records.map(r=>[r.id,r.path]).sort()).toEqual([[A,"notes/first.md"],[B,"todo.md"],[C,"scratch.md"]].sort());
    expect(records.find(r=>r.id===A)!.body).toBe("Started before connecting.\n");
    const again=await planUnsyncedTransfer(source,destination);
    expect(again.counts).toEqual({create:0,present:3,skipped:0,renamed:0,changed:0});
    expect(await runUnsyncedTransfer(again,destination)).toMatchObject({created:0,present:3,failed:[],mutations:[]});
  });

  it("renames a taken path beside it and reports types the destination lacks",async()=>{
    const {source,destination}=await pair(to=>{to.seed({path:"todo.md",body:"theirs\n"});to.seed({path:"todo 2.md",body:"also theirs\n"});});
    const plan=await planUnsyncedTransfer(source,destination,{map:record=>({path:record.path,document:record.document!,...(record.id===B?{type:"task"}:{})})});
    expect(plan.items.find(i=>i.sourceId===B)).toEqual({sourceId:B,sourcePath:"todo.md",outcome:"create",path:"todo 3.md",renamedFrom:"todo.md"});
    expect(plan.counts.renamed).toBe(1);expect(plan.missingTypes).toEqual(["task"]);
    await runUnsyncedTransfer(plan,destination);
    expect((await destination.get(B,{body:true})).path).toBe("todo 3.md");
    expect((await destination.get({path:"todo.md"},{body:true})).body).toBe("theirs\n");
  });

  it("adds the types the destination lacks from the source's own definitions, and a rerun finds them present",async()=>{
    const from=new MemoryReplica({collection:SOURCE}),to=new MemoryReplica({collection:DESTINATION});
    from.seedType("task",{fields:{status:{type:"string"}}});from.seedType("note");to.seedType("note");
    from.seed({id:A,path:"a.md",types:["task"],frontmatter:{type:"task",status:"open"},body:"A\n"});
    from.seed({id:B,path:"b.md",types:["idea"],frontmatter:{type:"idea"},body:"B\n"});
    from.seed({id:C,path:"c.md",types:["note"],frontmatter:{type:"note"},body:"C\n"});
    const source=await connect({connector:from.connector(),app}),destination=await connect({connector:to.connector(),app});
    const without=await planUnsyncedTransfer(source,destination);
    expect(without).toMatchObject({missingTypes:["idea","task"],addTypes:[]});
    const plan=await planUnsyncedTransfer(source,destination,{addTypes:true});
    // "idea" is not defined in the source either: it stays missing.
    expect(plan).toMatchObject({missingTypes:["idea"],addTypes:["task"]});
    const result=await runUnsyncedTransfer(plan,destination);
    expect(result).toMatchObject({created:3,addedTypes:["task"],failedTypes:[],failed:[]});
    expect((await destination.describe()).types.map(t=>t.name).sort()).toEqual(["note","task"]);
    // Running the same plan again replays the same writes: nothing doubles.
    expect(await runUnsyncedTransfer(plan,destination)).toMatchObject({failed:[],addedTypes:["task"],failedTypes:[]});
    expect(await all(destination)).toHaveLength(3);
    expect((await destination.describe()).types.filter(t=>t.name==="task")).toHaveLength(1);
  });

  it("brings in a record changed here after its transfer as a copy beside it, keeping both versions",async()=>{
    const {source,destination}=await pair();
    const rows=new Map<string,Map<string,string>>();
    const ledger={read:async(id:string)=>new Map(rows.get(id)??[]),record:async(id:string,revisions:ReadonlyMap<string,string>)=>{const row=rows.get(id)??new Map<string,string>();for(const [k,v] of revisions)row.set(k,v);rows.set(id,row);}};
    const first=await planUnsyncedTransfer(source,destination,{ledger});
    await runUnsyncedTransfer(first,destination);
    expect([...rows.get(SOURCE)!.keys()].sort()).toEqual([A,B,C].sort());
    // Edited in both places after the transfer.
    await destination.update(B,{body:"Buy milk and eggs\n"});
    await source.update(B,{body:"Buy oat milk\n"});
    expect(await unsyncedTransferComplete(first,source,destination)).toBe(false);
    const plan=await planUnsyncedTransfer(source,destination,{ledger});
    expect(plan.counts).toEqual({create:0,present:2,skipped:0,renamed:0,changed:1});
    const item=plan.items.find(i=>i.sourceId===B)!;
    expect(item).toMatchObject({outcome:"changed",path:"todo 2.md"});
    expect(await runUnsyncedTransfer(plan,destination)).toMatchObject({created:1,failed:[]});
    expect((await destination.get(B,{body:true})).body).toBe("Buy milk and eggs\n");
    expect((await destination.get(item.copyId!,{body:true})).body).toBe("Buy oat milk\n");
    expect(await unsyncedTransferComplete(plan,source,destination)).toBe(true);
    // A run interrupted after the copy landed but before its revision was recorded: the copy is found, not made twice.
    rows.get(SOURCE)!.set(B,(await source.get(B)).revision.replace(/.$/,c=>c==="0"?"1":"0"));
    const again=await planUnsyncedTransfer(source,destination,{ledger});
    expect(again.counts).toMatchObject({create:0,changed:0});
    expect(await all(destination)).toHaveLength(4);
  });

  it("applies the app's map, which may leave records out but not change their IDs",async()=>{
    const {source,destination}=await pair();
    const plan=await planUnsyncedTransfer(source,destination,{map:record=>record.path==="scratch.md"?null:{path:record.path,frontmatter:{...Object.fromEntries([...record.frontmatter].map(([k,v])=>[k,v as never])),moved:true},body:record.body ?? ""}});
    expect(plan.counts).toEqual({create:2,present:0,skipped:1,renamed:0,changed:0});
    await runUnsyncedTransfer(plan,destination);
    expect((await destination.get(B)).frontmatter.get("moved")).toBe(true);
    await expect(planUnsyncedTransfer(source,destination,{map:record=>({path:record.path,id:A})})).rejects.toSatisfy(e=>isMdbaseError(e,"invalid_request"));
  });

  it("resumes after a failure without repeating what was done",async()=>{
    const {source,destination}=await pair();
    const plan=await planUnsyncedTransfer(source,destination);
    let calls=0;
    const flaky=new Proxy(destination,{get(target,key,receiver){
      if(key==="create")return (input:Parameters<MdbaseClient["create"]>[0],o:Parameters<MdbaseClient["create"]>[1])=>{if(++calls===2)return Promise.reject(Object.assign(new Error("offline"),{code:"unavailable"}));return target.create(input,o);};
      const value=Reflect.get(target,key,receiver);return typeof value==="function"?value.bind(target):value;
    }});
    const first=await runUnsyncedTransfer(plan,flaky);
    expect(first.created).toBe(2);expect(first.failed).toHaveLength(1);
    const retry=await planUnsyncedTransfer(source,destination);
    expect(retry.counts).toEqual({create:1,present:2,skipped:0,renamed:0,changed:0});
    expect(await runUnsyncedTransfer(retry,destination)).toMatchObject({created:1,present:2,failed:[]});
    expect(await all(destination)).toHaveLength(3);
  });

  it("counts a create whose reply was lost but which landed as present",async()=>{
    const {source,destination}=await pair();
    const plan=await planUnsyncedTransfer(source,destination);
    const lossy=new Proxy(destination,{get(target,key,receiver){
      if(key==="create")return async(input:Parameters<MdbaseClient["create"]>[0],o:Parameters<MdbaseClient["create"]>[1])=>{await target.create(input,o);throw Object.assign(new Error("lost"),{code:"unavailable"});};
      const value=Reflect.get(target,key,receiver);return typeof value==="function"?value.bind(target):value;
    }});
    expect(await runUnsyncedTransfer(plan,lossy)).toMatchObject({created:0,present:3,failed:[]});
  });

  it("is complete only when planning again with the same map finds nothing left",async()=>{
    const {source,destination}=await pair();
    const map=(record:Parameters<NonNullable<Parameters<typeof planUnsyncedTransfer>[2]>["map"] & {}>[0])=>record.path==="scratch.md"?null:{path:record.path,document:record.document!};
    const plan=await planUnsyncedTransfer(source,destination,{map});
    expect(await unsyncedTransferComplete(plan,source,destination)).toBe(false);
    expect((await runUnsyncedTransfer(plan,destination)).retired).toBe(false);
    // The record the map leaves out does not hold the transfer open.
    expect(await unsyncedTransferComplete(plan,source,destination)).toBe(true);
    // Work saved after the plan does.
    await source.create({path:"later.md",body:"written after planning\n"});
    expect(await unsyncedTransferComplete(plan,source,destination)).toBe(false);
    expect(await unsyncedTransferComplete(plan,destination,source)).toBe(false);
  });

  it("refuses a plan it did not make, another destination, and a collection into itself",async()=>{
    const {source,destination}=await pair();
    const plan=await planUnsyncedTransfer(source,destination);
    await expect(runUnsyncedTransfer({...plan},destination)).rejects.toSatisfy(e=>isMdbaseError(e,"invalid_request"));
    await expect(runUnsyncedTransfer(plan,source)).rejects.toSatisfy(e=>isMdbaseError(e,"invalid_request"));
    await expect(planUnsyncedTransfer(source,source)).rejects.toSatisfy(e=>isMdbaseError(e,"invalid_request"));
  });
});
