import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {afterAll,describe,expect,it} from "vitest";
import {build,type Rollup} from "vite";

// Apps bundle the SDK with Vite. Rollup's default tree-shaking once deleted the
// calls that deliver a carrier's messages and close: the carrier was an object
// literal with `onmessage: null` that left its module only through a Promise's
// resolve(), so Rollup decided the handler stayed null. A Private collection
// then never finished opening. Build each carrier the way an app does and drive
// the result.
const sdk=fileURLToPath(new URL("..",import.meta.url));
const out=mkdtempSync(join(tmpdir(),"mdbase-carrier-bundle-"));
afterAll(()=>rmSync(out,{recursive:true,force:true}));

async function bundled<T>(source:string):Promise<T>{
  const result=await build({root:sdk,configFile:false,logLevel:"silent",
    build:{write:false,lib:{entry:join(sdk,source),formats:["es"],fileName:"carrier"}}});
  const chunk=(Array.isArray(result)?result[0]:result as Rollup.RollupOutput)?.output[0];
  if(chunk?.type!=="chunk")throw new Error(`no chunk built for ${source}`);
  const file=join(out,`${source.replace(/\W/g,"_")}.mjs`);
  writeFileSync(file,chunk.code);
  return await import(pathToFileURL(file).href) as T;
}

interface Carrier{onmessage:((m:Uint8Array)=>void)|null;onclose:((e?:unknown)=>void)|null}
class FakeSocket{
  binaryType="";sent:unknown[]=[];
  onopen:(()=>void)|null=null;onmessage:((ev:{data:unknown})=>void)|null=null;onerror:(()=>void)|null=null;onclose:((ev:{code?:number;reason?:string})=>void)|null=null;
  send(d:unknown){this.sent.push(d);}close(){}
}
const frame=(m:number[])=>{const f=new Uint8Array(4+m.length);new DataView(f.buffer).setUint32(0,m.length);f.set(m,4);return f.buffer;};
function listen(c:Carrier){const got:{messages:number[][];closed:number}={messages:[],closed:0};c.onmessage=m=>got.messages.push([...m]);c.onclose=()=>got.closed++;return got;}

describe("carriers in an app's production bundle",()=>{
  it("a relay pipe delivers messages and its close to the handlers set after it opens",async()=>{
    const {relayPipeCarrier}=await bundled<{relayPipeCarrier:(url:string,auth:object,factory:(url:string)=>FakeSocket)=>Promise<Carrier>}>("src/transport/relay-pipe.ts");
    const ws=new FakeSocket();
    const opening=relayPipeCarrier("wss://relay.test/v1/next/relay/client",{accessToken:"t",collection:"c",grant:"g",device:"d",devicePublicKey:new Uint8Array(32)},()=>ws);
    ws.onopen!();ws.onmessage!({data:JSON.stringify({type:"pipe_opened",pipe_id:"p"})});
    const got=listen(await opening);
    ws.onmessage!({data:frame([1,2,3])});ws.onclose!({code:1006});
    expect(got).toEqual({messages:[[1,2,3]],closed:1});
  },60_000);

  it("a WebSocket carrier delivers messages and its close to the handlers set after it opens",async()=>{
    const {webSocketCarrier}=await bundled<{webSocketCarrier:(url:string,factory:(url:string)=>FakeSocket)=>Promise<Carrier>}>("src/transport/noise-session.ts");
    const ws=new FakeSocket();
    const opening=webSocketCarrier("wss://relay.test/session",()=>ws);
    ws.onopen!();
    const got=listen(await opening);
    ws.onmessage!({data:new Uint8Array([4,5]).buffer});ws.onmessage!({data:new Uint8Array([6])});ws.onclose!({code:1006});
    expect(got).toEqual({messages:[[4,5],[6]],closed:1});
  },60_000);
});
