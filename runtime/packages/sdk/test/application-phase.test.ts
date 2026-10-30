import {expect,it} from "vitest";
import {applicationPhase,type MdbasePhase} from "../src/application/phase.js";
import type {MdbaseApplicationConnection,MdbaseApplicationSnapshot} from "../src/application/entry.js";

const A="11111111-1111-4111-8111-111111111111";
const facet={checking:false,assessment:{status:"ready" as const,problem:null},problem:null};
const readiness=(over:Partial<MdbaseApplicationSnapshot["readiness"]>={})=>({...facet,facets:{capabilities:facet,contracts:facet,configuration:facet,files:facet,people:facet,notifications:facet},...over});
const collection={collectionId:A,displayName:"Notes",role:"owner" as const};
const snap=(over:Partial<MdbaseApplicationSnapshot>):MdbaseApplicationSnapshot=>({status:"ready",signIn:null,collections:[collection],selectedCollectionId:A,problem:null,timing:null,readiness:readiness(),
  selection:{state:"usable",problem:null,usable:collection,requested:{collectionId:A,source:"url",displayName:"Notes",approved:true}},...over} as MdbaseApplicationSnapshot);
const connection={id:A,isCurrent:()=>true} as unknown as MdbaseApplicationConnection;

it("opening progress belongs only to the selected opening scope and never grants ready",()=>{
  expect(applicationPhase(snap({status:"opening",openingProgress:"replaying"}))).toMatchObject({kind:"opening",progress:"replaying"});
  expect(applicationPhase(snap({status:"opening",selectedCollectionId:null,openingProgress:"replaying"}))).not.toHaveProperty("progress");
  expect(applicationPhase(snap({openingProgress:"replaying"}),{connection})).toMatchObject({kind:"ready"});
  expect(applicationPhase(snap({openingProgress:"replaying"}),{connection})).not.toHaveProperty("progress");
});

it("a scoped wrong-account refusal names only the original account and offers the explicit approval gesture",()=>{
  const phase=applicationPhase(snap({status:"blocked",problem:"recovery_account_mismatch",recoveryAccountLabel:"a@example.test",removedScopeIds:[A]}));
  expect(phase).toMatchObject({kind:"problem",collectionId:A,problem:{title:"Use a different account",message:"This collection belongs to a@example.test. Sign in as a@example.test to continue.",action:"approve",actionLabel:"Sign in as a@example.test",severity:"info"}});
  if(phase.kind!=="problem")throw Error("expected account problem");
  expect(phase.problem.message).not.toContain("recovery_account_mismatch");expect(phase.problem.message).not.toContain(A);
});

it("ready holds through re-checks and transient results; a settled non-ready outcome replaces it",()=>{
  const ready=applicationPhase(snap({}),{connection});
  expect(ready).toMatchObject({kind:"ready",collectionId:A,rechecking:false,problem:null});
  // Re-check: readiness checking and the session briefly reports opening.
  const rechecking=applicationPhase(snap({status:"opening",readiness:readiness({checking:true,assessment:null})}),{connection,previous:ready});
  expect(rechecking).toMatchObject({kind:"ready",rechecking:true});
  // Busy is transient: still ready, with the problem for an optional notice.
  const busy=applicationPhase(snap({status:"blocked",problem:"busy"}),{connection,previous:rechecking});
  expect(busy).toMatchObject({kind:"ready",problem:{key:"busy"}});
  // Settled: setup is needed now.
  expect(applicationPhase(snap({status:"setup_required",readiness:readiness({assessment:{status:"setup_required",problem:null}})}),{connection,previous:busy}).kind).toBe("needs_setup");
  // Durable problem (access removed) replaces ready.
  expect(applicationPhase(snap({status:"blocked",problem:"access_removed"}),{connection,previous:ready})).toMatchObject({kind:"problem",problem:{key:"access_removed"}});
  // A stale connection never holds ready.
  const stale={id:A,isCurrent:()=>false} as unknown as MdbaseApplicationConnection;
  expect(applicationPhase(snap({status:"opening"}),{connection:stale,previous:ready}).kind).toBe("opening");
});

it("setup stays on screen while applying it re-checks, so a failed apply is shown, not dropped",()=>{
  const setup=applicationPhase(snap({status:"setup_required",readiness:readiness({assessment:{status:"setup_required",problem:null}})}),{connection});
  expect(setup.kind).toBe("needs_setup");
  expect(applicationPhase(snap({status:"opening",readiness:readiness({checking:true,assessment:null})}),{connection,previous:setup})).toBe(setup);
  // Not a re-check (the collection is opening again): opening.
  expect(applicationPhase(snap({status:"opening",readiness:readiness({checking:false,assessment:null})}),{connection,previous:setup}).kind).toBe("opening");
});

it("maps sign-in, approval, choosing and the second-tab case to phases with typed actions",()=>{
  const none={state:"none",problem:null,usable:null,requested:{collectionId:null,source:"none",displayName:null,approved:false}} as const;
  expect(applicationPhase(snap({status:"signed_out",collections:[],selectedCollectionId:null,selection:none}))).toEqual({kind:"signed_out",notice:null} satisfies MdbasePhase);
  expect(applicationPhase(snap({status:"signed_out",problem:"approval_window_closed",collections:[],selectedCollectionId:null,selection:none})))
    .toMatchObject({kind:"signed_out",notice:{key:"approval_window_closed"}});
  const lastApproval={kind:"add",outcome:"closed",collectionId:null} as const;
  expect(applicationPhase(snap({status:"unselected",selectedCollectionId:null,selection:{...none,lastApproval}}))).toEqual({kind:"choosing",lastApproval});
  expect(applicationPhase(snap({status:"unselected",selectedCollectionId:null,selection:{state:"approval_required",problem:"application_selection_not_approved",usable:null,requested:{collectionId:A,source:"url",displayName:null,approved:false}}})))
    .toMatchObject({kind:"needs_approval",collectionId:A,declined:true});
  // Second tab: a problem without a sign-in action.
  const other=applicationPhase(snap({status:"blocked",problem:"open_in_another_tab",signIn:null,collections:[],selectedCollectionId:null,selection:none}));
  expect(other).toMatchObject({kind:"problem",problem:{key:"open_in_another_tab"}});
  expect(other.kind==="problem"&&other.problem.action).not.toBe("sign_in");
});
