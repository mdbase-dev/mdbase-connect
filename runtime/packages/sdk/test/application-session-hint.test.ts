import {afterEach,expect,it,vi} from "vitest";
import {applicationSessionHint} from "../src/application/session-hint.js";
import type {AppWebSignInSnapshot} from "../src/app-host/web-sign-in-session.js";

afterEach(()=>vi.unstubAllGlobals());
it("records the paired list for a starting or second tab, clears on sign-out and ignores corrupt storage",()=>{
  const store=new Map<string,string>();
  vi.stubGlobal("localStorage",{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>void store.set(k,v),removeItem:(k:string)=>void store.delete(k)});
  const id="11111111-1111-4111-8111-111111111111";
  const signIn={requestId:id,installationId:id,deviceId:id,appId:id,kind:"app-runtime",verificationUri:"https://connect.test/pair",state:"paired",accountId:id,
    collectionSelection:{requestId:id,selectedCollectionId:id,createdCollectionIds:[]},collectionIds:[id],createCollections:false,requestedCreateCollections:false} as const;
  const paired:AppWebSignInSnapshot={status:"unselected",signIn,collections:[{collectionId:id,displayName:"Notes",role:"owner"}],selectedCollectionId:null,problem:null,timing:null};
  const hint=applicationSessionHint("app","https://connect.test");
  hint.observe({...paired,status:"authorizing"});expect(hint.read()).toBeNull(); // only settled lists
  hint.observe(paired);
  expect(applicationSessionHint("app","https://connect.test").read()).toMatchObject({signIn:{state:"paired",accountId:id},collections:[{collectionId:id,displayName:"Notes"}]});
  expect(hint.read()?.signIn).not.toHaveProperty("collectionSelection");
  hint.observe({...paired,status:"signed_out",signIn:null,collections:[]});expect(store.size).toBe(0);expect(hint.read()).toBeNull();
  store.set([...store.keys()][0]??"mdbase.app.session-hint.v1.https%3A%2F%2Fconnect.test","{not json");expect(hint.read()).toBeNull();
});
