import {afterEach,describe,expect,it,vi} from "vitest";
import {AppLogPushChannel,LOG_CLOSE_EXPIRED,LOG_CLOSE_FORBIDDEN,type AppLogPushEvents,type AppLogPushSource} from "../src/app-host/log-push.js";
import {decode,encode,type CborValue} from "../src/cbor.js";

type Frame=Map<CborValue,CborValue>;
class FakeSocket {
  static all:FakeSocket[]=[];static silent=false;
  binaryType="blob";sent:unknown[]=[];closed:number|null=null;
  onopen:(()=>void)|null=null;onmessage:((event:{data:unknown})=>void)|null=null;onclose:((event:{code:number})=>void)|null=null;onerror:(()=>void)|null=null;
  constructor(readonly url:string){FakeSocket.all.push(this);if(!FakeSocket.silent)queueMicrotask(()=>this.onopen?.());}
  send(data:unknown){this.sent.push(data);}
  close(code=1000){this.closed=code;}
  requests(){return this.sent.filter(v=>v instanceof Uint8Array).map(v=>decode(v as Uint8Array) as Frame);}
  reply(id:number,result:CborValue){this.onmessage?.({data:encode(new Map<number,CborValue>([[0,1],[1,id],[2,result]])).buffer});}
  refuse(id:number,code:string,reason:string){this.onmessage?.({data:encode(new Map<number,CborValue>([[0,1],[1,id],[3,new Map<number,CborValue>([[0,code],[1,reason]])]])).buffer});}
  push(kind:string,payload:CborValue){this.onmessage?.({data:encode(new Map<number,CborValue>([[0,2],[1,kind],[2,payload]])).buffer});}
  serverClose(code:number){this.onclose?.({code});}
}
const collection="33333333-3333-4333-8333-333333333333",device="44444444-4444-4444-8444-444444444444";
function channel(signHello:AppLogPushSource["signHello"]=()=>new Uint8Array(64).fill(9)){
  FakeSocket.all=[];FakeSocket.silent=false;
  const invalidate=vi.fn(),tokens=["t1","t2","t3","t4"];let minted=0;
  const source:AppLogPushSource={origin:"https://log.test",collection,deviceId:device,isCurrent:()=>true,
    accessToken:async()=>tokens[minted++]??`t${minted}`,invalidateToken:invalidate,nonce:async()=>new Uint8Array(32).fill(7),signHello};
  const pushes:Frame[]=[],lives:boolean[]=[],ended:string[]=[];
  const events:AppLogPushEvents={push:frame=>pushes.push(decode(frame) as Frame),live:live=>lives.push(live),ended:reason=>ended.push(reason)};
  const push=new AppLogPushChannel(source,events,{WebSocket:FakeSocket as unknown as typeof WebSocket,random:()=>0});
  return {push,pushes,lives,ended,invalidate};
}
/** Open, hello, subscribe at head 5: live. */
async function subscribed(socket:FakeSocket){
  await vi.waitFor(()=>expect(socket.requests().map(r=>r.get(2))).toEqual(["hello"]));
  socket.reply(1,new Map());
  await vi.waitFor(()=>expect(socket.requests().map(r=>r.get(2))).toEqual(["hello","subscribe"]));
  socket.reply(2,new Map<number,CborValue>([[0,5],[1,new Uint8Array(32).fill(1)]]));
}
afterEach(()=>{vi.useRealTimers();});

describe("log push channel",()=>{
  it("hello then subscribe over a single-use nonce; the subscription head is delivered as catch-up; pushes flow",async()=>{
    const c=channel();c.push.start();
    await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(1));
    const socket=FakeSocket.all[0]!;
    expect(socket.url).toBe(`wss://log.test/v1/ws?c=${collection}&n=${"07".repeat(32)}`);
    await subscribed(socket);
    expect(c.push.live).toBe(true);expect(c.lives).toEqual([true]);
    expect(c.pushes[0]!.get(1)).toBe("head");
    socket.push("items",new Map<number,CborValue>([[0,new Uint8Array(16)]]));
    expect(c.pushes.map(p=>p.get(1))).toEqual(["head","items"]);
    // Extensible framing: an unknown push kind, frame type or text message is ignored, not an error.
    socket.push("future_kind",new Map<number,CborValue>([[0,1]]));
    socket.onmessage?.({data:encode(new Map<number,CborValue>([[0,9],[1,"x"]])).buffer});
    socket.onmessage?.({data:"future-text"});
    expect(socket.closed).toBe(null);expect(c.push.live).toBe(true);expect(c.ended).toEqual([]);
  });
  it("access ended: a closed push or a 4403 close ends the channel for good, no reconnect",async()=>{
    vi.useFakeTimers({shouldAdvanceTime:true});
    const c=channel();c.push.start();await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(1));
    await subscribed(FakeSocket.all[0]!);
    FakeSocket.all[0]!.push("closed",new Map<number,CborValue>([[0,new Uint8Array(16)],[1,"forbidden"]]));
    expect(c.ended).toEqual(["forbidden"]);expect(c.push.available).toBe(false);
    const d=channel();d.push.start();await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(1));
    await subscribed(FakeSocket.all[0]!);
    FakeSocket.all[0]!.serverClose(LOG_CLOSE_FORBIDDEN);
    expect(d.ended).toEqual(["forbidden"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
  it("a credentials_revoked hello ends the channel (stale tab fails closed)",async()=>{
    const c=channel();c.push.start();await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(1));
    const socket=FakeSocket.all[0]!;
    await vi.waitFor(()=>expect(socket.requests()).toHaveLength(1));
    socket.refuse(1,"forbidden","credentials_revoked");
    expect(c.ended).toEqual(["revoked"]);
  });
  it("4401 drops the token and reconnects at once; suspend closes and stays closed until resume",async()=>{
    vi.useFakeTimers({shouldAdvanceTime:true});
    const c=channel();c.push.start();await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(1));
    await subscribed(FakeSocket.all[0]!);
    FakeSocket.all[0]!.serverClose(LOG_CLOSE_EXPIRED);
    expect(c.invalidate).toHaveBeenCalledWith("t1");
    await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(2));
    await subscribed(FakeSocket.all[1]!);
    expect((FakeSocket.all[1]!.requests()[0]!.get(3) as Frame).get(1)).toBe("t2"); // a fresh token
    c.push.suspend();
    expect(FakeSocket.all[1]!.closed).toBe(1000);expect(c.push.live).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all).toHaveLength(2);
    c.push.resume();
    await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(3));
  });
  it("a socket that never opens is dropped after the open timeout and retried",async()=>{
    vi.useFakeTimers({shouldAdvanceTime:true});
    const c=channel();FakeSocket.silent=true;c.push.start();
    await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(FakeSocket.all[0]!.closed).toBe(1000);
    await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(2));
    expect(c.push.live).toBe(false);expect(c.push.available).toBe(true);
    // The retry opens: live as usual.
    FakeSocket.silent=false;FakeSocket.all[1]!.onopen?.();
    await subscribed(FakeSocket.all[1]!);
    expect(c.lives).toEqual([true]);
  });
  it("a hello the runtime cannot sign yet is retried, not given up for good",async()=>{
    vi.useFakeTimers({shouldAdvanceTime:true});
    let unsigned=2;
    const c=channel(()=>unsigned-->0?null:new Uint8Array(64).fill(9));c.push.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(()=>expect(FakeSocket.all).toHaveLength(1));
    // Never signable: gives up until the next focus, visibility or online.
    const d=channel(()=>null);d.push.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(d.push.available).toBe(false);
    d.push.nudge();expect(d.push.available).toBe(true);
  });
});
