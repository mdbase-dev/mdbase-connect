import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {APPLICATION_WORKER_PROTOCOL} from "../src/application/worker-protocol.js";
const state=vi.hoisted(()=>({loaded:vi.fn(),constructed:vi.fn(),messages:[] as unknown[]}));
vi.mock("../src/application/worker-host.js",()=>{
  state.loaded();
  return {ApplicationWorkerHost:class {
    constructor(port:MessagePort){state.constructed();port.addEventListener("message",event=>state.messages.push(event.data));port.start();}
  }};
});
vi.mock("../src/application/packaged-assets.js",()=>({packagedApplicationAssets:vi.fn(()=>({}))}));
vi.mock("../src/app-host/app-origin.js",()=>({currentAppOrigin:()=>"https://app.test",appOriginPlatform:()=>"web"}));
let events:EventTarget,ports:MessagePort[]=[];
beforeEach(()=>{
  vi.resetModules();state.loaded.mockClear();state.constructed.mockClear();state.messages.length=0;events=new EventTarget();
  // Synthetic Worker globals only; actual MessagePorts. Not browser/native proof.
  vi.stubGlobal("WorkerGlobalScope",class {static [Symbol.hasInstance](value:unknown){return value===globalThis;}});
  vi.stubGlobal("addEventListener",events.addEventListener.bind(events));vi.stubGlobal("removeEventListener",events.removeEventListener.bind(events));vi.stubGlobal("navigator",{locks:undefined});
});
afterEach(()=>{for(const port of ports.splice(0))port.close();vi.unstubAllGlobals();});
function channel(){const c=new MessageChannel();ports.push(c.port1,c.port2);return c;}
const binding="original_bootstrap_binding_123",declaration={id:"org.example.app",name:"Example",origin:"https://app.test",environment:"lab",manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:"https://app.test",redirect_uris:["https://app.test/callback"],requirements:{access:"full_collection",contracts:[]}}};
it("constructs the original host only after bootstrap binding and preserves queued start/close on the same port",async()=>{
  await import("../src/application/worker.js");expect(state.constructed).not.toHaveBeenCalled();
  const c=channel();events.dispatchEvent(new MessageEvent("message",{data:[APPLICATION_WORKER_PROTOCOL,binding,declaration],ports:[c.port1]}));
  c.port2.postMessage(["original-start"]);c.port2.postMessage(["original-close"]);
  // The global bootstrap listener was synchronously removed, even though host
  // import is pending. A second bootstrap cannot acquire another owner.
  events.dispatchEvent(new MessageEvent("message",{data:[APPLICATION_WORKER_PROTOCOL,binding,declaration],ports:[channel().port1]}));
  await vi.waitFor(()=>expect(state.messages).toEqual([["original-start"],["original-close"]]));
  expect(state.loaded).toHaveBeenCalledOnce();expect(state.constructed).toHaveBeenCalledOnce();
});
it("rejects an invalid original binding before constructing any host",async()=>{
  await import("../src/application/worker.js");const c=channel(),reply=new Promise<unknown>(resolve=>{c.port2.addEventListener("message",event=>resolve(event.data));c.port2.start();});
  events.dispatchEvent(new MessageEvent("message",{data:[APPLICATION_WORKER_PROTOCOL,binding,{...declaration,origin:"https://other.test"}],ports:[c.port1]}));
  await expect(reply).resolves.toEqual([APPLICATION_WORKER_PROTOCOL,binding,"fatal",0,{code:"application_worker_binding"}]);expect(state.constructed).not.toHaveBeenCalled();
});
