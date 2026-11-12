import {afterEach,expect,it,vi} from "vitest";
import {MdbaseEntry} from "../src/application/entry.js";
import type {ApplicationRuntime} from "../src/application/runtime.js";

const origin="https://app.test",id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(()=>{vi.unstubAllGlobals();});

function links(selectedCollectionId:string|null){
  const page=Object.assign(new EventTarget(),{location:{origin,href:`${origin}/`},history:{state:null,pushState(){},replaceState(){}}});
  vi.stubGlobal("window",page);vi.stubGlobal("location",page.location);vi.stubGlobal("Worker",class{});
  vi.stubGlobal("navigator",{storage:{persisted:async()=>false,persist:async()=>false}});
  const entry=new MdbaseEntry({id:"org.example.app",name:"Example",origin,environment:"lab",manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
    redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}},{privateCollections:false});
  const raw={status:"ready",signIn:{state:"paired",accountId:"account"},collections:[{collectionId:id,displayName:"A",role:"owner"}],selectedCollectionId,problem:null,
    transport:null,readiness:{checking:false,assessment:null,problem:null,facets:{}}};
  const runtime={getSnapshot:()=>raw,getNativeSnapshot:()=>raw,connection:()=>null,close:async()=>{}};
  // The environment's trust bundle exists only in built SDKs, so its origin is set here.
  Object.assign(entry,{runtime:runtime as unknown as ApplicationRuntime,cpOrigin:"https://connect-lab.mdbase.dev",
    links:{account:"https://connect-lab.mdbase.dev/account",manageAccess:"https://connect-lab.mdbase.dev/account/applications"}});
  return entry.mdbase.getSnapshot().links;
}

it("points Manage access at the selected collection in the app's own environment",()=>{
  expect(links(id)).toEqual({account:"https://connect-lab.mdbase.dev/account",manageAccess:`https://connect-lab.mdbase.dev/access?collection=${id}`});
});

it("falls back to the account's apps with no selection",()=>{
  expect(links(null)?.manageAccess).toBe("https://connect-lab.mdbase.dev/account/applications");
});
