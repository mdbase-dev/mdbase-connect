import {describe,expect,it} from "vitest";
import {ApplicationBrowserSelection,type ApplicationSelectionBrowserPort} from "../src/application/browser-selection.js";
import {ApplicationCollectionSelection,type ApplicationSelectionSession} from "../src/application/collection-selection.js";
import type {AppWebSignInSnapshot} from "../src/app-host/web-sign-in-session.js";
import type {AppInstallationSignInView} from "../src/app-host/installation-sign-in.js";

const origin="https://app.test",A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222",C="33333333-3333-4333-8333-333333333333";
function browser(href:string){
  const entries=[href],listeners=new Set<()=>void>(),writes:Array<"push"|"replace">=[];let cursor=0;
  const port:ApplicationSelectionBrowserPort={href:()=>entries[cursor]!,write:(next,history)=>{writes.push(history);if(history==="push"){entries.splice(cursor+1);entries.push(next);cursor++;}else entries[cursor]=next;},listen:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
  return{port,writes,param:()=>new URL(entries[cursor]!).searchParams.get("collection"),pop:(direction:number)=>{cursor+=direction;for(const listener of [...listeners])listener();}};
}
const view=(requestId:string,pick:string|null):AppInstallationSignInView=>({requestId,installationId:C,deviceId:C,appId:C,kind:"app-runtime",verificationUri:`https://connect.test/pair/${requestId}`,state:"paired",accountId:C,
  collectionSelection:pick?{requestId,selectedCollectionId:pick,createdCollectionIds:[]}:null,collectionIds:[],createCollections:false,requestedCreateCollections:false});
/** Mirrors AppWebSignInSession's published transitions under autoSelect
 * "never" (single op slot, consent receipt -> refreshCollections). */
function signInSession(initial:{collections:string[]}|"signed_out"){
  const listeners=new Set<()=>void>(),opened:Array<string|null>=[],failing=new Set<string>(),hints:Array<string|null>=[];let authorizations=0,receipt=0,busy=false;
  let snap:AppWebSignInSnapshot=initial==="signed_out"?{status:"signed_out",signIn:null,collections:[],selectedCollectionId:null,problem:null,timing:null}
    :{status:"unselected",signIn:view("00000000-0000-4000-8000-000000000000",null),collections:initial.collections.map(collectionId=>({collectionId,displayName:`n-${collectionId.slice(0,1)}`,role:"owner"})),selectedCollectionId:null,problem:null,timing:null};
  const publish=(update:Partial<AppWebSignInSnapshot>)=>{snap={...snap,...update};for(const listener of [...listeners])listener();};
  const open=async(id:string)=>{
    if(busy)throw new Error("busy");if(!snap.collections.some(c=>c.collectionId===id))throw new Error("refused");
    busy=true;opened.push(id);publish({status:"opening",selectedCollectionId:id});await Promise.resolve();busy=false;
    if(failing.delete(id)){publish({status:"blocked",problem:"open_failed"});throw new Error("open_failed");}
    publish({status:"ready",problem:null});
  };
  const port:ApplicationSelectionSession={getSnapshot:()=>snap,subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    open,clear:async()=>{opened.push(null);publish({status:"unselected",selectedCollectionId:null});},
    authorize:options=>{authorizations++;hints.push(options?.collectionHint??null);publish({status:"authorizing"});return Promise.resolve();}};
  return{port,opened,failing,hints,publish,authorizations:()=>authorizations,snapshot:()=>snap,
    /** Portal receipt consumed by background polling, as the real session does. */
    grant(add:string[],pick:string|null=null){
      const requestId=`4${String(++receipt).padStart(7,"0")}-0000-4000-8000-000000000000`;
      const collections=[...snap.collections];for(const id of add)if(!collections.some(c=>c.collectionId===id))collections.push({collectionId:id,displayName:`n-${id.slice(0,1)}`,role:"editor"});
      // autoSelect "never": a fresh portal pick is published, not opened.
      publish({status:"unselected",signIn:view(requestId,pick),collections,problem:null});
    }};
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
function setup(href:string,session:ReturnType<typeof signInSession>,memory?:{read():string|null;write(id:string|null):void}){
  const web=browser(href),selection=new ApplicationCollectionSelection({browser:new ApplicationBrowserSelection(origin,{},web.port),session:session.port,...(memory?{memory}:{})});
  selection.start();return{web,selection};
}

describe("SDK collection selection: requested URL collection vs usable collection",()=>{
  it("fresh device with a shared link: sign-in approves A and A opens, not another approved collection",async()=>{
    const session=signInSession("signed_out"),{web,selection}=setup(`${origin}/tasks?collection=${A}`,session);await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"pending",requested:{collectionId:A,source:"url",approved:false},usable:null});
    const approving=selection.approve();expect(session.authorizations()).toBe(1);expect(session.hints).toEqual([A]); // popup reserved inside the gesture, before any await; Connect preselects A
    expect(selection.getSnapshot().state).toBe("approving");await approving;
    session.grant([B,A]);await settle();
    expect(session.opened).toEqual([A]);expect(selection.getSnapshot()).toMatchObject({state:"usable",requested:{collectionId:A,approved:true,displayName:"n-1"},usable:{collectionId:A}});expect(web.param()).toBe(A);selection.close();
  });
  it("unapproved URL A never falls back to sole B; declined approval is reported; a different portal pick wins and the URL follows",async()=>{
    const session=signInSession({collections:[B]}),{web,selection}=setup(`${origin}/?collection=${A}`,session);await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"approval_required",requested:{collectionId:A,approved:false,displayName:null},usable:null,problem:null});expect(session.opened).toEqual([]);
    await selection.approve();session.grant([]);await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"approval_required",problem:"application_selection_not_approved"});expect(session.opened).toEqual([]);expect(web.param()).toBe(A);
    await selection.approve();session.grant([A,C],C);await settle();
    expect(session.opened).toEqual([C]);expect(selection.getSnapshot()).toMatchObject({state:"usable",requested:{collectionId:C},usable:{collectionId:C},problem:null});expect(web.param()).toBe(C);expect(web.writes).toEqual(["replace"]);selection.close();
  });
  it("Back/forward switches the open collection; choose another closes it with a pushed clean URL that Back restores",async()=>{
    const session=signInSession({collections:[A,B]}),{web,selection}=setup(`${origin}/?collection=${A}`,session);await settle();
    expect(selection.getSnapshot().usable?.collectionId).toBe(A);
    await selection.select(B,{history:"push"});expect(selection.getSnapshot()).toMatchObject({state:"usable",usable:{collectionId:B}});
    web.pop(-1);await settle();expect(selection.getSnapshot()).toMatchObject({state:"usable",requested:{collectionId:A},usable:{collectionId:A}});
    await selection.chooseAnother();expect(web.param()).toBeNull();expect(session.snapshot().selectedCollectionId).toBeNull();expect(selection.getSnapshot()).toMatchObject({state:"none",usable:null});
    web.pop(-1);await settle();expect(selection.getSnapshot().usable?.collectionId).toBe(A);expect(session.opened).toEqual([A,B,A,null,A]);selection.close();
  });
  it("reauthorizing the current collection keeps it usable after the consent receipt republishes unselected",async()=>{
    const session=signInSession({collections:[A,B]}),{selection}=setup(`${origin}/?collection=${A}`,session);await settle();
    await selection.reauthorize();expect(session.authorizations()).toBe(1);expect(selection.getSnapshot().state).toBe("approving");
    session.grant([]);expect(session.snapshot()).toMatchObject({status:"unselected",selectedCollectionId:A});await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"usable",usable:{collectionId:A}});selection.close();
  });
  it("a failed open is not retried automatically; an explicit select retries it",async()=>{
    const session=signInSession({collections:[A,B]});session.failing.add(A);
    const {selection}=setup(`${origin}/?collection=${A}`,session);await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"blocked",requested:{collectionId:A}});
    session.publish({problem:"open_failed"});await settle();expect(session.opened).toEqual([A]);
    await selection.select(A);expect(session.opened).toEqual([A,A]);expect(selection.getSnapshot().state).toBe("usable");selection.close();
  });
  it("explicit approve(null) requests the portal chooser without inheriting the current hint",async()=>{
    const session=signInSession({collections:[B]}),{web,selection}=setup(`${origin}/?collection=${A}`,session);await settle();
    await selection.approve(null);expect(session.hints).toEqual([null]);expect(session.authorizations()).toBe(1);
    expect(web.param()).toBe(A);expect(session.opened).toEqual([]);
    session.grant([],B);await settle();expect(web.param()).toBe(B);expect(session.opened).toEqual([B]);selection.close();
  });
  it("an unapproved stored hint cannot authorize or fall back to the sole approved collection",async()=>{
    const session=signInSession({collections:[B]}),writes:Array<string|null>=[],{selection}=setup(`${origin}/`,session,{read:()=>A,write:id=>writes.push(id)});await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"approval_required",requested:{collectionId:A,source:"stored",approved:false,displayName:null},usable:null});
    expect(session.opened).toEqual([]);expect(session.authorizations()).toBe(0);expect(writes).toEqual([]);selection.close();
  });
  it("an invalid URL blocks both stored and sole-collection fallback without starting approval",async()=>{
    const session=signInSession({collections:[B]}),{web,selection}=setup(`${origin}/?collection=`,session,{read:()=>B,write(){}});await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"invalid",problem:"application_selection_empty",requested:{collectionId:null,source:"url"},usable:null});
    expect(web.writes).toEqual([]);expect(session.opened).toEqual([]);expect(session.authorizations()).toBe(0);selection.close();
  });
  it("without a URL the remembered collection opens and is written to the URL by replace; usable selection is remembered",async()=>{
    const writes:Array<string|null>=[],session=signInSession({collections:[A,B]}),{web,selection}=setup(`${origin}/`,session,{read:()=>B,write:id=>writes.push(id)});await settle();
    expect(selection.getSnapshot()).toMatchObject({state:"usable",requested:{collectionId:B,source:"stored"},usable:{collectionId:B}});expect(web.param()).toBe(B);expect(web.writes).toEqual(["replace"]);
    await selection.select(A);expect(writes).toEqual([B,A]);selection.close();
  });
});
