import {afterEach,describe,expect,it,vi} from "vitest";
import {ApplicationTabs,type ApplicationTabLocks} from "../src/application/tabs.js";

/** Exclusive Web Locks with ifAvailable, waiting and abort; one realm stands in for the browser. */
function webLocks():ApplicationTabLocks{
  const held=new Set<string>(),queues=new Map<string,Array<()=>void>>();
  const next=(name:string)=>{const run=queues.get(name)?.shift();if(run)run();};
  const grant=(name:string,callback:(lock:unknown)=>Promise<void>|void)=>{held.add(name);
    return Promise.resolve().then(()=>callback({name})).finally(()=>{held.delete(name);next(name);});};
  return {request(name:string,options:{ifAvailable?:true;signal?:AbortSignal},callback:(lock:unknown)=>Promise<void>|void){
    if(options.ifAvailable)return held.has(name)||queues.get(name)?.length?Promise.resolve(callback(null)):grant(name,callback);
    if(!held.has(name))return grant(name,callback);
    return new Promise((resolve,reject)=>{
      const queue=queues.get(name)??[];queues.set(name,queue);
      const run=()=>{options.signal?.removeEventListener("abort",abort);grant(name,callback).then(resolve,reject);};
      const abort=()=>{queue.splice(queue.indexOf(run),1);reject(options.signal!.reason);};
      queue.push(run);options.signal?.addEventListener("abort",abort,{once:true});
    });
  }} as ApplicationTabLocks;
}
const scope={cpOrigin:"https://cp.test",appId:"55555555-5555-4555-8555-555555555555",build:`https://app.test/sdk-${Math.random()}.js`};
const live:ApplicationTabs[]=[];
afterEach(()=>{for(const tabs of live.splice(0))tabs.release();});
const next=(port:MessagePort)=>new Promise<MessageEvent>(resolve=>{port.addEventListener("message",resolve,{once:true});port.start();});

describe("one session per app per browser",()=>{
  it("a follower reaches the leader's Worker through tunnelled ports, both ways; leaving detaches it; it takes over when the leader goes",async()=>{
    const locks=webLocks(),env={locks,BroadcastChannel};
    const lostB=vi.fn();
    const a=new ApplicationTabs(scope,env,vi.fn()),b=new ApplicationTabs(scope,env,lostB);live.push(a,b);
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    // The leader's Worker: answers a "connect" with a fresh data port.
    const workerSide:MessagePort[]=[];const detach=vi.fn();
    a.lead({attach:(port)=>{port.onmessage=event=>{
      const data=new MessageChannel();workerSide.push(data.port1);
      port.postMessage(["handoff",0,{dataPort:data.port2,echo:event.data}],[data.port2]);
    };},detach});
    const role=await b.elect(new AbortController().signal);
    if(role.kind!=="follower")throw new Error("expected a follower");
    const reply=next(role.port);role.port.postMessage("connect");
    const handoff=(await reply).data as [string,number,{dataPort:MessagePort;echo:string}];
    expect(handoff[2].echo).toBe("connect");
    expect(handoff[2].dataPort).toBeInstanceOf(MessagePort);
    // Worker → follower and follower → Worker on the tunnelled data port.
    const down=next(handoff[2].dataPort);workerSide[0]!.postMessage(new Uint8Array([1,2,3]));
    expect([...(await down).data as Uint8Array]).toEqual([1,2,3]);
    const up=next(workerSide[0]!);handoff[2].dataPort.postMessage("write");
    expect((await up).data).toBe("write");
    // The leader goes: the follower restarts and now leads.
    a.resign();
    await vi.waitFor(()=>expect(lostB).toHaveBeenCalledOnce());
    expect(b.leader).toBe(true);
    expect((await b.elect(new AbortController().signal)).kind).toBe("leader");
    // A follower of the new leader leaving is detached from its Worker.
    const c=new ApplicationTabs(scope,env,vi.fn());live.push(c);
    const detachC=vi.fn();b.lead({attach:()=>{},detach:detachC});
    const joined=await c.elect(new AbortController().signal);
    if(joined.kind!=="follower")throw new Error("expected a follower");
    joined.leave();
    await vi.waitFor(()=>expect(detachC).toHaveBeenCalledWith(joined.binding));
  });
  it("the leader's Worker failing fails every follower's session, including one that joins later",async()=>{
    const locks=webLocks(),env={locks,BroadcastChannel};
    const a=new ApplicationTabs(scope,env,vi.fn()),b=new ApplicationTabs(scope,env,vi.fn()),c=new ApplicationTabs(scope,env,vi.fn());live.push(a,b,c);
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    a.lead({attach:()=>{},detach:vi.fn()});
    const failed=(port:MessagePort)=>new Promise<void>(resolve=>port.addEventListener("messageerror",()=>resolve(),{once:true}));
    const first=await b.elect(new AbortController().signal);
    if(first.kind!=="follower")throw new Error("expected a follower");
    const firstFailed=failed(first.port);
    a.fault();
    await firstFailed;
    const late=await c.elect(new AbortController().signal);
    if(late.kind!=="follower")throw new Error("expected a follower");
    await failed(late.port);
  });
  it("a leader that signed out tells its followers, so none starts a new session as the next leader",async()=>{
    const locks=webLocks(),env={locks,BroadcastChannel};
    const lostB=vi.fn(),lostC=vi.fn();
    const a=new ApplicationTabs(scope,env,vi.fn()),b=new ApplicationTabs(scope,env,lostB),c=new ApplicationTabs(scope,env,lostC);live.push(a,b,c);
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    a.lead({attach:()=>{},detach:vi.fn()});
    expect((await b.elect(new AbortController().signal)).kind).toBe("follower");
    a.signedOut();
    // The leader's Worker stop takes a round trip before it resigns.
    await new Promise(resolve=>setTimeout(resolve,10));
    a.resign();
    await vi.waitFor(()=>expect(lostB).toHaveBeenCalledOnce());
    expect(lostB).toHaveBeenCalledWith(true);
    // A plain handover (no sign-out) still restarts the next tab.
    const joining=c.elect(new AbortController().signal);
    b.lead({attach:()=>{},detach:vi.fn()});
    expect((await joining).kind).toBe("follower");
    b.resign();
    await vi.waitFor(()=>expect(lostC).toHaveBeenCalledOnce());
    expect(lostC).toHaveBeenCalledWith(false);
  });
  it("after every tab signed out, a tab signing in again brings the signed-out tabs back to its session",async()=>{
    const locks=webLocks(),env={locks,BroadcastChannel};
    const back=vi.fn();
    // As the entry does: a tab whose leader signed out resigns and stays signed out.
    const lostB=vi.fn(()=>b.resign());
    const a=new ApplicationTabs(scope,env,vi.fn()),b:ApplicationTabs=new ApplicationTabs(scope,env,lostB,back);live.push(a,b);
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    a.lead({attach:()=>{},detach:vi.fn()});
    expect((await b.elect(new AbortController().signal)).kind).toBe("follower");
    a.signedOut();await new Promise(resolve=>setTimeout(resolve,10));a.resign();
    await vi.waitFor(()=>expect(lostB).toHaveBeenCalledWith(true));
    // a signs in again as the new leader; b, signed out with no session, follows.
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    a.lead({attach:()=>{},detach:vi.fn()});
    a.signedIn();a.signedIn();
    await vi.waitFor(()=>expect(back).toHaveBeenCalledOnce());
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(back).toHaveBeenCalledOnce();
  });
});
