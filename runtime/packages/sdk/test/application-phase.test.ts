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

it("takes the person's language for every described problem and notice",()=>{
  const messages={access_removed:{title:"Accès retiré",message:"Demandez à nouveau l'accès."},recovery_account_mismatch:{title:"Autre compte"},unlock_failed:{message:"Réessayez."},refused:{title:"Connexion refusée"}};
  expect(applicationPhase(snap({status:"blocked",problem:"access_removed"}),{messages})).toMatchObject({kind:"problem",problem:{key:"access_removed",title:"Accès retiré",message:"Demandez à nouveau l'accès."}});
  // The account label still fills the untranslated message.
  expect(applicationPhase(snap({status:"blocked",problem:"recovery_account_mismatch",recoveryAccountLabel:"a@example.test"}),{messages}))
    .toMatchObject({kind:"problem",problem:{title:"Autre compte",message:"This collection belongs to a@example.test. Sign in as a@example.test to continue."}});
  const signedOut=applicationPhase(snap({status:"signed_out",selectedCollectionId:null,problem:"refused"}),{messages});
  expect(signedOut).toMatchObject({kind:"signed_out",notice:{title:"Connexion refusée"}});
  // The SDK's own module, with no options, is unchanged.
  expect(applicationPhase(snap({status:"blocked",problem:"access_removed"}))).not.toMatchObject({problem:{title:"Accès retiré"}});
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
  // A start that opens work before connecting next never shows sign-in on the way; a notice still does.
  expect(applicationPhase(snap({status:"signed_out",collections:[],selectedCollectionId:null,selection:none}),{openingUnsynced:true})).toEqual({kind:"starting"} satisfies MdbasePhase);
  expect(applicationPhase(snap({status:"signed_out",problem:"approval_window_closed",collections:[],selectedCollectionId:null,selection:none}),{openingUnsynced:true}))
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

it("the unsynced collection is its own phase: never ready, never listed, signing in shows over it",()=>{
  const U="22222222-2222-4222-8222-222222222222";
  const unsyncedConnection={id:U,isCurrent:()=>true} as unknown as MdbaseApplicationConnection;
  const shown=(over:Partial<MdbaseApplicationSnapshot>)=>snap({collections:[],selectedCollectionId:U,unsynced:{collectionId:U,sessionStatus:"signed_out"},
    selection:{state:"none",problem:null,usable:null,requested:{collectionId:null,source:"none",displayName:null,approved:false}},...over} as Partial<MdbaseApplicationSnapshot>);
  const phase=applicationPhase(shown({}),{connection:unsyncedConnection});
  expect(phase).toEqual({kind:"unsynced",collectionId:U,connection:unsyncedConnection,rechecking:false});
  // No current connection yet, or still configuring: opening, not ready.
  expect(applicationPhase(shown({}),{})).toMatchObject({kind:"opening",collectionId:U,displayName:null});
  expect(applicationPhase(shown({status:"setup_required",readiness:readiness({checking:true,assessment:null})}),{connection:unsyncedConnection})).toMatchObject({kind:"opening"});
  // Re-checks keep it; a settled setup failure or a refusal is a problem.
  expect(applicationPhase(shown({status:"opening",readiness:readiness({checking:true,assessment:null})}),{connection:unsyncedConnection,previous:phase})).toMatchObject({kind:"unsynced",rechecking:true});
  expect(applicationPhase(shown({status:"setup_required",readiness:readiness({assessment:{status:"setup_required",problem:null}})}),{connection:unsyncedConnection}).kind).toBe("problem");
  expect(applicationPhase(shown({status:"blocked",problem:"open_in_another_tab"}),{connection:unsyncedConnection})).toMatchObject({kind:"problem",collectionId:U});
  // Signing in from it shows the sign-in window, the work stays open behind it.
  expect(applicationPhase(shown({status:"authorizing"}),{connection:unsyncedConnection})).toMatchObject({kind:"authorizing",purpose:"sign_in"});
});

it("a locked Private collection is needs_unlock with the account-key mode, never opening, ready or a guessed mode",()=>{
  const locked=(unlock:MdbaseApplicationSnapshot["unlock"],over:Partial<MdbaseApplicationSnapshot>={})=>applicationPhase(snap({status:"needs_unlock",unlock,collections:[{...collection,mode:"private"}],
    selection:{state:"opening",problem:null,usable:null,requested:{collectionId:A,source:"url",displayName:"Notes",approved:true}},...over}));
  expect(locked({mode:"password",unlocking:false,problem:null})).toEqual({kind:"needs_unlock",collectionId:A,displayName:"Notes",mode:"password",unlocking:false,problem:null} satisfies MdbasePhase);
  expect(locked({mode:"strict",unlocking:false,problem:null})).toMatchObject({kind:"needs_unlock",mode:"strict"});
  expect(locked({mode:"none",unlocking:false,problem:null})).toMatchObject({kind:"needs_unlock",mode:"none"});
  expect(locked({mode:"password",unlocking:true,problem:null})).toMatchObject({kind:"needs_unlock",unlocking:true,problem:null});
  // The last failed attempt is described in plain language; the code never reaches the copy.
  const wrong=locked({mode:"password",unlocking:false,problem:"wrong_secret"});
  expect(wrong).toMatchObject({kind:"needs_unlock",unlocking:false,problem:{key:"wrong_secret"}});
  if(wrong.kind!=="needs_unlock"||!wrong.problem)throw Error("expected a described problem");
  expect(wrong.problem.message).not.toContain("wrong_secret");expect(wrong.problem.message).not.toContain(A);
  for(const key of ["invalid_recovery_key","no_account_key","unlock_strict","rate_limited","unavailable","unlock_unavailable","unlock_failed"])
    expect(locked({mode:"password",unlocking:false,problem:key})).toMatchObject({kind:"needs_unlock",problem:{key}});
  // An unknown code still shows a problem (never null, never the raw code).
  const unknown=locked({mode:"password",unlocking:false,problem:"some_new_code"});
  if(unknown.kind!=="needs_unlock"||!unknown.problem)throw Error("expected a fallback problem");
  expect(unknown.problem.message).not.toContain("some_new_code");
  // Malformed: locked without its lock display is a problem, not an unlock form with a guessed mode.
  expect(locked(null)).toMatchObject({kind:"problem",collectionId:A});
  expect(locked(undefined)).toMatchObject({kind:"problem",collectionId:A});
  // The display name falls back to the requested name, then null.
  expect(locked({mode:"password",unlocking:false,problem:null},{collections:[]})).toMatchObject({kind:"needs_unlock",displayName:"Notes"});
  // A previous ready phase of this collection never holds over a locked collection.
  const ready=applicationPhase(snap({}),{connection});
  expect(applicationPhase(snap({status:"needs_unlock",unlock:{mode:"password",unlocking:false,problem:null}}),{previous:ready}).kind).toBe("needs_unlock");
  // A stray lock on any other status is ignored.
  expect(applicationPhase(snap({unlock:{mode:"password",unlocking:false,problem:null}}),{connection}).kind).toBe("ready");
});

it("a paired session with nothing selected is still starting until the start request is decided",()=>{
  const none={state:"none" as const,problem:null,usable:null,requested:{collectionId:null,source:"none" as const,displayName:null,approved:false}};
  const paired={state:"paired"} as MdbaseApplicationSnapshot["signIn"];
  const idle=snap({status:"unselected",selectedCollectionId:null,signIn:paired,selection:none});
  expect(applicationPhase(idle,{startPending:true})).toEqual({kind:"starting"});
  expect(applicationPhase(idle,{startPending:false})).toMatchObject({kind:"choosing"});
  expect(applicationPhase(idle)).toMatchObject({kind:"choosing"});
  // Only that one wait is held: a problem, a request or a signed-out session shows as before.
  expect(applicationPhase(snap({status:"unselected",selectedCollectionId:null,signIn:paired,selection:none,problem:"unavailable"}),{startPending:true})).toMatchObject({kind:"choosing"});
  expect(applicationPhase(snap({status:"unselected",selectedCollectionId:null,signIn:null,selection:none}),{startPending:true})).toMatchObject({kind:"choosing"});
  expect(applicationPhase(snap({status:"unselected",selectedCollectionId:null,signIn:paired,selection:{...none,state:"opening",requested:{collectionId:A,source:"user",displayName:"Notes",approved:true}}}),{startPending:true})).toMatchObject({kind:"opening",collectionId:A});
});
