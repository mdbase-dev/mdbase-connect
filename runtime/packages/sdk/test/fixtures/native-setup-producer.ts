// Actual SDK Session/Frames fixture; deliberately not a physical Native service.
import {onTestFinished} from "vitest";
import { connect } from "../../src/client.js";
import { MemoryReplica } from "../../src/testing/memory-replica.js";
import { clientFrame,helloResult,receipt } from "../../src/wire.js";
import { decode,encode,type CborValue } from "../../src/cbor.js";
import { uuidFromBytes } from "../../src/codec.js";
import { manifestDigest } from "../../src/application/registration.js";
import { mdbaseError } from "../../src/errors.js";
import type { PrivateSetupJournal } from "../../src/app-grant/setup-attempt.js";
import { privateCollectionSetup } from "../../src/app-grant/setup.js";
function cbor(v:unknown):CborValue {if(Array.isArray(v))return v.map(cbor);if(v&&typeof v==="object")return new Map(Object.entries(v).map(([k,x])=>[k,cbor(x)]));return v as CborValue;}
export async function nativeSetupFixture(manifest:Record<string,unknown>,o:{support?:boolean;capabilities?:string[];dropApply?:boolean;dropCode?:"conflict"|"not_found";oversized?:boolean;pending?:boolean;pendingForever?:boolean;receiptPending?:boolean}={}) {
 const bytes=Uint8Array.from((await manifestDigest(manifest)).match(/../g)!,v=>parseInt(v,16));
 const replica=new MemoryReplica({capabilities:o.capabilities??["collection.read","records.create","records.edit"]}),base=replica.connector();
 const state={installed:false,stale:false,drop:!!o.dropApply,digest:3,promoted:0,retireOnApply:0,mid:undefined as string|undefined,attempt:undefined as string|undefined};
 let activeTicket:Uint8Array|undefined,ticketSequence=0;
 const matches=(ticket:unknown)=>ticket instanceof Uint8Array&&activeTicket!==undefined&&ticket.length===activeTicket.length&&ticket.every((v,i)=>v===activeTicket![i]);
 const methods:string[]=[],requests:Map<number,CborValue>[]=[];
 let jobRecords:Map<number,CborValue>[]=[];
 const journal:PrivateSetupJournal={load:async()=>state.attempt,begin:async mid=>state.attempt??=mid,clear:async mid=>{if(state.attempt===mid)state.attempt=undefined;}};
 const connector={description:"original-session-setup-fixture",open:async(...args:Parameters<typeof base.open>)=>{
   const opened=await base.open(...args),h=clientFrame.dec(opened.helloResponse);
   if(h.kind!=="response"||!h.result)throw Error("hello");
   const hello=helloResult.dec(h.result);h.result=helloResult.enc({...hello,features:o.support===false?[]:["declared-collection-setup-v1"]});opened.helloResponse=clientFrame.enc(h);
   const send=opened.port.send.bind(opened.port);
   opened.port.send=(raw)=>{
     const f=clientFrame.dec(raw);if(f.kind!=="request")return send(raw);methods.push(f.method);
     const respond=(result:CborValue)=>queueMicrotask(()=>opened.port.onframe?.(clientFrame.enc({kind:"response",id:f.id,result})));
     const done=()=>receipt.enc({mutation:state.mid!,state:o.receiptPending?"pending":"confirmed",...(o.receiptPending?{}:{status:"applied" as const,seq:1})});
     if((f.method==="receipt"||f.method==="await")&&state.mid){respond(done());return;}
     if(f.method!=="app_collection_setup_v1")return send(raw);
     const m=decode((f.params as Map<number,CborValue>).get(0) as Uint8Array) as Map<number,CborValue>;requests.push(m);
     const action=m.get(1);
     if(action==="cancel"){if(matches(m.get(2)))activeTicket=undefined;respond(encode(new Map<number,CborValue>([[0,1],[1,"cancelled"]])));return;}
     if(action==="apply"){
       if(state.retireOnApply>0){state.retireOnApply--;activeTicket=undefined;}
       if(!matches(m.get(2))){queueMicrotask(()=>opened.port.onframe?.(clientFrame.enc({kind:"response",id:f.id,problem:mdbaseError("not_found","Setup review not found.").toProblem()})));return;}
       if(state.stale){queueMicrotask(()=>opened.port.onframe?.(clientFrame.enc({kind:"response",id:f.id,problem:mdbaseError("conflict","changed","setup_changed").toProblem()})));return;}
       state.mid=uuidFromBytes(m.get(3) as Uint8Array);state.installed=true;
       if(state.drop){state.drop=false;queueMicrotask(()=>opened.port.onclose?.(mdbaseError(o.dropCode??"conflict","transport closed after capture")));return;}
       respond(encode(new Map<number,CborValue>([[0,1],[1,"receipt"],[3,done()]])));return;
     }
     if(action==="assess"){jobRecords=(m.get(4)??[]) as Map<number,CborValue>[];activeTicket=new Uint8Array(16);new DataView(activeTicket.buffer).setUint32(12,++ticketSequence);}
     if(o.pendingForever||o.pending&&action==="assess"){respond(encode(new Map<number,CborValue>([[0,1],[1,"pending"],[2,activeTicket!]])));return;}
     const rows=jobRecords;
     const review={configuration:[],staged:state.installed?[]:[{path:"_types/task.md",document:"---\nname: task\n---\n"}],packs:[{id:"tasks",version:"1.0.0",status:state.installed?"current":"install",installedVersion:state.installed?"1.0.0":null,resources:state.installed?[]:[{target:"_types/task.md",kind:"type",mode:"managed",action:"create",installed:false}]}]};
     respond(o.oversized?new Uint8Array(256*1024+1):encode(new Map<number,CborValue>([
       [0,1],[1,"review"],[2,activeTicket!],[3,state.installed?"ready":"setup_required"],[4,new Uint8Array(32).fill(2)],[5,new Uint8Array(32).fill(state.digest)],[6,cbor(review)],[7,bytes],[8,manifest.id as string],[9,new Map([[0,state.promoted],[1,0]])],[10,rows.map(r=>new Map<number,CborValue>([[0,r.get(0)!],[1,state.installed?"skip":"create"]]))],
     ])));
   };return opened;
 }};
 const client=await connect({connector,app:{name:"private-setup-test",version:"1"},reconnect:{minDelayMs:1,maxDelayMs:5}});
 onTestFinished(()=>client.close());
 const input={client,manifest,operations:["assess_collection_setup","apply_collection_setup"],journal,assertCurrent:async()=>{}};
 return {client,state,methods,requests,journal,input,setup:privateCollectionSetup(input)};
}
