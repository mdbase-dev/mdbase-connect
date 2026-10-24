/** Private setup is mediated by the original Native producer, never local resource writes. */
import type { MdbaseClient } from "../client.js";
import { MdbaseError, isMdbaseError, mdbaseError } from "../errors.js";
import { uuidToBytes } from "../codec.js";
import type { CborValue } from "../cbor.js";
import {isReplicaResponseProblem, type Session} from "../session.js";
import type { Receipt } from "../wire.js";
import { resourceDecisions } from "../app-host/collection-control.js";
import { setupPlan, setupRecords, type MdbaseSetupPlan, type MdbaseSetupPlanOptions } from "../application/setup.js";
import { manifestDigest } from "../application/registration.js";
import { hashBytes, setupRequest, type NativeSetupReview } from "./setup-producer.js";
import type { PrivateSetupJournal } from "./setup-attempt.js";
export type MdbasePrivateSetupStatus = "ready" | "setup_required" | "incompatible";
export interface MdbasePrivateSetup {
  assess(options?: {signal?:AbortSignal}):Promise<MdbasePrivateSetupStatus>;
  plan(options?:MdbaseSetupPlanOptions):Promise<MdbaseSetupPlan>;
  apply(plan:MdbaseSetupPlan,options?:{signal?:AbortSignal}):Promise<MdbasePrivateSetupStatus>;
}
/** @internal Original identity fences and protected MID register are mandatory. */
export interface PrivateSetupInput {
  readonly client:MdbaseClient; readonly manifest:unknown; readonly operations:readonly string[];
  readonly journal:PrivateSetupJournal;
  assertCurrent():Promise<unknown>;
}
const changed=(mid?:string,cause?:unknown)=>new MdbaseError(mdbaseError("conflict","This collection changed since setup was reviewed. Review it again.","setup_changed").toProblem(),{...(mid?{mutationId:mid}:{}),...(cause?{cause}:{})});
const unknown=(mid:string,cause?:unknown)=>new MdbaseError(mdbaseError("outcome_unknown","Reconcile the original setup before trying again.","setup_outcome_unknown").toProblem(),{mutationId:mid,...(cause?{cause}:{})});
const unavailable=()=>mdbaseError("unavailable","Native setup is unavailable.","resource_setup_unavailable");
function pause(signal?:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(mdbaseError("cancelled","Setup cancelled."));
  const abort=()=>{clearTimeout(timer);reject(mdbaseError("cancelled","Setup cancelled."));};
  const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},100);
  signal?.addEventListener("abort",abort,{once:true});
});}
/** @internal Construction neither activates nor replaces the held grant. */
export function privateCollectionSetup(input:PrivateSetupInput):MdbasePrivateSetup {
  const {client,journal}=input;
  const declared=input.operations.includes("assess_collection_setup")&&input.operations.includes("apply_collection_setup");
  const plans=new WeakMap<MdbaseSetupPlan,{session:Session;review:NativeSetupReview;options:MdbaseSetupPlanOptions;consumed:boolean}>();
  const noops=new WeakSet<MdbaseSetupPlan>();
  let busy=false;
  async function exclusive<T>(work:()=>Promise<T>):Promise<T>{if(busy)throw mdbaseError("rate_limited","A setup operation is already running.");busy=true;try{return await work();}finally{busy=false;}}
  async function fence(s?:Session,signal?:AbortSignal){if(!s)await client.readyForRead(signal);await input.assertCurrent();if(signal?.aborted)throw mdbaseError("cancelled","Setup cancelled.");if(s&&(s.closed||client.currentSession()!==s))throw changed();}
  async function cancel(s:Session,ticket:Uint8Array){try{await setupRequest(s,"cancel",[[2,ticket]],AbortSignal.timeout(1000));}catch{/* no write is issued by cancel */}}
  async function native(options:MdbaseSetupPlanOptions={}):Promise<{s:Session;review:NativeSetupReview;options:MdbaseSetupPlanOptions}>{
    await fence(undefined,options.signal);
    const s=await client.readyForRead(options.signal);await fence(s,options.signal);
    const expected=await manifestDigest(input.manifest);await fence(s,options.signal);
    const decisions=resourceDecisions(options.adopt===undefined?{}:{adopt:options.adopt}),records=setupRecords(options.records);
    const fields:[number,CborValue][]=[];
    if(decisions.adopt&&Object.keys(decisions.adopt).length) fields.push([3,new Map(Object.entries(decisions.adopt).map(([p,h])=>[p,hashBytes(h)]))]);
    if(records.length)fields.push([4,records.map(r=>new Map<number,CborValue>([[0,r.path],[1,r.document]]))]);
    let ticket:Uint8Array|undefined;
    try{
      let reply=await setupRequest(s,"assess",fields,options.signal);await fence(s,options.signal);
      for(let polls=0;reply.kind==="pending";polls++){
        ticket=reply.ticket;if(polls>=512)throw unavailable();
        await pause(options.signal);await fence(s,options.signal);
        reply=await setupRequest(s,"poll",[[2,ticket]],options.signal);await fence(s,options.signal);
      }
      if(reply.kind!=="review")throw unavailable();ticket=reply.ticket;
      if(reply.declaration!==expected || reply.application!==(input.manifest as {id?:unknown})?.id)throw changed();
      if(reply.records.length!==records.length || reply.records.some((r,i)=>r.path!==records[i]!.path))throw unavailable();
      return {s,review:reply,options:{records,...(decisions.adopt?{adopt:Object.freeze({...decisions.adopt})}:{})}};
    }catch(e){if(ticket)await cancel(s,ticket);throw e;}
  }
  async function reconcile(signal?:AbortSignal){
    await fence(undefined,signal);const mid=await journal.load();await fence(undefined,signal);if(!mid)return;
    let r:Receipt;try{r=await client.receipt(mid,signal);}catch(e){throw unknown(mid,e);}
    await fence(undefined,signal);
    if(r.mutation!==mid || (r.state!=="confirmed"&&r.state!=="rejected"))throw unknown(mid);
    await journal.clear(mid);
  }
  const api:MdbasePrivateSetup={
    async assess(options={}){
      const p=await api.plan(options),bound=plans.get(p);
      // Assessment does not return a usable plan: release its original review,
      // rather than occupying Native\'s bounded slot until the next page expires.
      if(bound){await cancel(bound.session,bound.review.ticket);await fence(bound.session,options.signal);}
      return p.status==="current"?"ready":p.status==="conflict"?"incompatible":"setup_required";
    },
    async plan(options={}){return exclusive(async()=>{
      await fence(undefined,options.signal);
      if(!declared){if(input.operations.includes("apply_collection_setup")||input.operations.includes("assess_collection_setup"))throw unavailable();const empty=setupPlan({status:"current",assessmentDigest:`sha256:${"0".repeat(64)}`,review:{configuration:[],packs:[],staged:[]}},{canManage:false,canCreateRecords:false,records:[]});noops.add(empty);return empty;}
      await reconcile(options.signal);const {s,review,options:original}=await native(options);
      let result=setupPlan(review.assessment,{canManage:true,canCreateRecords:s.hello.grant.capabilities.includes("records.create"),records:review.records.map(r=>({path:r.path,free:r.action==="create"}))});
      if(review.promoted){const changes=Object.freeze([...result.changes,{kind:"record" as const,target:"Existing files",message:`Recognize ${review.promoted} existing ${review.promoted===1?"file":"files"} as notes, preserving their contents.`}]);result=Object.freeze({...result,changes,summary:`This app will make ${changes.length} ${changes.length===1?"change":"changes"} to this collection.`});}
      plans.set(result,{session:s,review,options:original,consumed:false});return result;
    });},
    async apply(plan,options={}){return exclusive(async()=>{
      if(noops.has(plan)){await fence(undefined,options.signal);return "ready" as const;}
      let bound=plans.get(plan);if(!bound)throw new TypeError("setup.apply needs the original plan returned by setup.plan");
      if(bound.consumed)throw changed();
      if(plan.refusal)throw mdbaseError(plan.refusal.code==="setup_conflict"?"conflict":"forbidden",plan.refusal.message,plan.refusal.code);
      await fence(bound.session,options.signal);if(plan.status==="current"){const after=await native({signal:options.signal});await cancel(after.s,after.review.ticket);if(after.review.assessment.status!=="current")throw changed();return "ready" as const;}
      bound.consumed=true;
      for(let retry=0;;retry++){
        const mid=crypto.randomUUID();let original:string;try{original=await journal.begin(mid);}catch(e){throw unknown(mid,e);}if(original!==mid)throw unknown(original);
        let dispatched=false,terminal=false;
        try{
          await fence(bound.session,options.signal);dispatched=true;
          const reply=await setupRequest(bound.session,"apply",[[2,bound.review.ticket],[3,uuidToBytes(mid)],[4,bound.review.revision],[5,hashBytes(plan.digest)]],options.signal);
          await input.assertCurrent();if(reply.kind!=="receipt"||reply.receipt.mutation!==mid)throw unknown(mid);
          const r=reply.receipt.state==="pending"?await client.awaitReceipt(mid,30_000,options.signal):reply.receipt;
          await input.assertCurrent();
          if(r.mutation!==mid || (r.state!=="confirmed"&&r.state!=="rejected"))throw unknown(mid);
          terminal=true;await journal.clear(mid);
          if(r.state==="rejected" || (r.conflicts?.length??0)>0 || r.status!==undefined&&r.status!=="applied")throw changed(mid,r.problem);
          const after=await native({signal:options.signal});
          if(after.review.assessment.status!=="current")throw unavailable();
          await cancel(after.s,after.review.ticket);
          return "ready" as const;
        }catch(e){
          if(!dispatched || terminal || isReplicaResponseProblem(e)&&e.code!=="outcome_unknown"){
            await journal.clear(mid);
            // Only a certified pre-mutation refusal permits a fresh attempt.
            // Another plan can retire this ticket without changing its consented work.
            if(!terminal&&isReplicaResponseProblem(e)&&e.code==="not_found"){
              if(retry)throw changed(mid,e);
              await fence(bound.session,options.signal);
              const fresh=await native({...bound.options,signal:options.signal});
              try{
                await fence(bound.session,options.signal);
                if(fresh.s!==bound.session || fresh.review.assessment.assessmentDigest!==plan.digest
                  || fresh.review.assessment.status!=="provision"
                  || fresh.review.promoted!==bound.review.promoted || fresh.review.retained!==bound.review.retained
                  || fresh.review.records.some((r,i)=>r.action!==bound!.review.records[i]?.action))throw changed(mid,e);
              }catch(error){await cancel(fresh.s,fresh.review.ticket);throw error;}
              bound={...bound,review:fresh.review};continue;
            }
            throw new MdbaseError((isMdbaseError(e)?e:changed()).toProblem(),{mutationId:mid,cause:e});
          }
          throw unknown(mid,e);
        }
      }
    });},
  };
  return Object.freeze(api);
}
