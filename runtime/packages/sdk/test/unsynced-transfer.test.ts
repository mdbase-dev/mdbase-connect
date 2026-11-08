import {describe,expect,it} from "vitest";
import {connect,isMdbaseError,type MdbaseClient} from "../src/index.js";
import {MemoryReplica} from "../src/testing/index.js";
import {planUnsyncedTransfer,runUnsyncedTransfer} from "../src/application/unsynced-transfer.js";

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
    expect(plan.counts).toEqual({create:3,present:0,skipped:0,renamed:0});
    expect(plan.missingTypes).toEqual([]);
    const progress:number[]=[];
    const result=await runUnsyncedTransfer(plan,destination,{onProgress:p=>progress.push(p.done)});
    expect(result).toMatchObject({created:3,present:0,failed:[]});expect(result.mutations).toHaveLength(3);
    expect(progress).toEqual([0,1,2,3]);
    const records=await all(destination);
    expect(records.map(r=>[r.id,r.path]).sort()).toEqual([[A,"notes/first.md"],[B,"todo.md"],[C,"scratch.md"]].sort());
    expect(records.find(r=>r.id===A)!.body).toBe("Started before connecting.\n");
    const again=await planUnsyncedTransfer(source,destination);
    expect(again.counts).toEqual({create:0,present:3,skipped:0,renamed:0});
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

  it("applies the app's map, which may leave records out but not change their IDs",async()=>{
    const {source,destination}=await pair();
    const plan=await planUnsyncedTransfer(source,destination,{map:record=>record.path==="scratch.md"?null:{path:record.path,frontmatter:{...Object.fromEntries([...record.frontmatter].map(([k,v])=>[k,v as never])),moved:true},body:record.body ?? ""}});
    expect(plan.counts).toEqual({create:2,present:0,skipped:1,renamed:0});
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
    expect(retry.counts).toEqual({create:1,present:2,skipped:0,renamed:0});
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

  it("refuses a plan it did not make, another destination, and a collection into itself",async()=>{
    const {source,destination}=await pair();
    const plan=await planUnsyncedTransfer(source,destination);
    await expect(runUnsyncedTransfer({...plan},destination)).rejects.toSatisfy(e=>isMdbaseError(e,"invalid_request"));
    await expect(runUnsyncedTransfer(plan,source)).rejects.toSatisfy(e=>isMdbaseError(e,"invalid_request"));
    await expect(planUnsyncedTransfer(source,source)).rejects.toSatisfy(e=>isMdbaseError(e,"invalid_request"));
  });
});
