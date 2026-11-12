import {afterEach,describe,expect,it,vi} from "vitest";
import {ApplicationTabs,type ApplicationTabLocks} from "../src/application/tabs.js";
import {webLocks} from "./support/web-locks.js";

const scope={cpOrigin:"https://cp.test",appId:"55555555-5555-4555-8555-555555555555",build:`https://app.test/sdk-${Math.random()}.js`};
const live:ApplicationTabs[]=[];
afterEach(()=>{for(const tabs of live.splice(0))tabs.release();});
const next=(port:MessagePort)=>new Promise<MessageEvent>(resolve=>{port.addEventListener("message",resolve,{once:true});port.start();});

describe("one session per app per browser",()=>{
  it("vault namespaces elect separate Workers; sign-out and re-sign-in stay in their tab group",async()=>{
    const env={locks:webLocks(),BroadcastChannel},lost=vi.fn(),back=vi.fn();
    const a=new ApplicationTabs({...scope,storageNamespace:"vault/a"},env,vi.fn()),b=new ApplicationTabs({...scope,storageNamespace:"vault/b"},env,lost,back);
    live.push(a,b);
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    a.lead({attach:vi.fn(),detach:vi.fn()});
    expect((await b.elect(new AbortController().signal)).kind).toBe("leader");
    b.lead({attach:vi.fn(),detach:vi.fn()});
    const follower=new ApplicationTabs({...scope,storageNamespace:"vault/b"},env,lost);live.push(follower);
    expect((await follower.elect(new AbortController().signal)).kind).toBe("follower");
    a.signedOut();a.resign();
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    a.lead({attach:vi.fn(),detach:vi.fn()});a.signedIn();
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(b.leader).toBe(true);expect(lost).not.toHaveBeenCalled();expect(back).not.toHaveBeenCalled();
  });
  it("keeps default lock and broadcast names exact",async()=>{
    const locks=webLocks(),request=vi.spyOn(locks,"request"),channels:string[]=[];
    class Channel extends BroadcastChannel{constructor(name:string){super(name);channels.push(name);}}
    const a=new ApplicationTabs(scope,{locks,BroadcastChannel:Channel},vi.fn());live.push(a);
    expect((await a.elect(new AbortController().signal)).kind).toBe("leader");
    const base=`mdbn-app-tabs/1/${scope.cpOrigin}/${scope.appId}/${scope.build}`;
    expect(channels).toEqual([base]);expect(request.mock.calls.map(c=>c[0])).toEqual([`${base}/tab/${a.tab}`,`${base}/leader`]);
  });
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

describe("a context that never runs the Worker",()=>{
  const settled=()=>new Promise(resolve=>setTimeout(resolve,20));
  it("waits while no context leads, joins the one that starts, and leaves the lock to the next leader when that one goes",async()=>{
    const env={locks:webLocks(),BroadcastChannel},lost=vi.fn();
    const joiner=new ApplicationTabs(scope,env,lost,vi.fn(),{lead:false});live.push(joiner);
    let role:Awaited<ReturnType<ApplicationTabs["elect"]>>|null=null;
    const joining=joiner.elect(new AbortController().signal).then(value=>{role=value;});
    await settled();expect(role).toBeNull();expect(joiner.leader).toBe(false);
    const host=new ApplicationTabs(scope,env,vi.fn());live.push(host);
    expect((await host.elect(new AbortController().signal)).kind).toBe("leader");
    const attach=vi.fn();host.lead({attach,detach:vi.fn()});
    await joining;
    expect(role).toMatchObject({kind:"follower"});expect(attach).toHaveBeenCalledOnce();
    // The leader goes without a goodbye: the joiner hears it by the lock and does not keep it.
    host.release();
    await vi.waitFor(()=>expect(lost).toHaveBeenCalledWith(false));
    expect(joiner.leader).toBe(false);
    const next=new ApplicationTabs(scope,env,vi.fn());live.push(next);
    expect((await next.elect(new AbortController().signal)).kind).toBe("leader");
  });
  it("stopping the wait rejects it and leaves nothing behind",async()=>{
    const env={locks:webLocks(),BroadcastChannel},stop=new AbortController();
    const joiner=new ApplicationTabs(scope,env,vi.fn(),vi.fn(),{lead:false});live.push(joiner);
    const joining=joiner.elect(stop.signal);
    await settled();stop.abort();
    await expect(joining).rejects.toMatchObject({name:"AbortError"});
    const host=new ApplicationTabs(scope,env,vi.fn());live.push(host);
    const attach=vi.fn();
    expect((await host.elect(new AbortController().signal)).kind).toBe("leader");host.lead({attach,detach:vi.fn()});
    await settled();expect(attach).not.toHaveBeenCalled();
  });
  /** A context that led and stopped (signed out): idle, with its channel still open. */
  async function idleContext(env:{locks:ApplicationTabLocks;BroadcastChannel:typeof BroadcastChannel},wanted:()=>void){
    const idle=new ApplicationTabs(scope,env,vi.fn(),vi.fn(),{wanted});live.push(idle);
    expect((await idle.elect(new AbortController().signal)).kind).toBe("leader");
    idle.lead({attach:vi.fn(),detach:vi.fn()});idle.resign();
    return idle;
  }
  it("wakes an idle context that can lead when nobody leads, and then joins it",async()=>{
    const env={locks:webLocks(),BroadcastChannel},wanted=vi.fn();
    const idle=await idleContext(env,wanted);
    const joiner=new ApplicationTabs(scope,env,vi.fn(),vi.fn(),{lead:false});live.push(joiner);
    const joining=joiner.elect(new AbortController().signal);
    await vi.waitFor(()=>expect(wanted).toHaveBeenCalledOnce());
    expect((await idle.elect(new AbortController().signal)).kind).toBe("leader");
    idle.lead({attach:vi.fn(),detach:vi.fn()});
    expect((await joining).kind).toBe("follower");
  });
  it("leaves an idle context alone while another one leads or is starting to",async()=>{
    const env={locks:webLocks(),BroadcastChannel},wanted=vi.fn();
    await idleContext(env,wanted);
    // Holds the lock, not ready yet: the join goes unanswered, and nobody else starts.
    const host=new ApplicationTabs(scope,env,vi.fn());live.push(host);
    expect((await host.elect(new AbortController().signal)).kind).toBe("leader");
    const joiner=new ApplicationTabs(scope,env,vi.fn(),vi.fn(),{lead:false});live.push(joiner);
    const joining=joiner.elect(new AbortController().signal);
    await settled();expect(wanted).not.toHaveBeenCalled();
    host.lead({attach:vi.fn(),detach:vi.fn()});
    expect((await joining).kind).toBe("follower");
    // Ready: a second joiner is served by the leader alone.
    const second=new ApplicationTabs(scope,env,vi.fn(),vi.fn(),{lead:false});live.push(second);
    expect((await second.elect(new AbortController().signal)).kind).toBe("follower");
    await settled();expect(wanted).not.toHaveBeenCalled();
  });
  it("an ordinary tab's join never wakes an idle context",async()=>{
    const env={locks:webLocks(),BroadcastChannel},wanted=vi.fn();
    await idleContext(env,wanted);
    const starting=new ApplicationTabs(scope,env,vi.fn());live.push(starting);
    expect((await starting.elect(new AbortController().signal)).kind).toBe("leader");
    // The tab asks to join a leader that is not ready; it could lead itself, so nobody is woken.
    const tab=new ApplicationTabs(scope,env,vi.fn());live.push(tab);
    const joining=tab.elect(new AbortController().signal);
    await settled();expect(wanted).not.toHaveBeenCalled();
    starting.lead({attach:vi.fn(),detach:vi.fn()});
    expect((await joining).kind).toBe("follower");
    expect(wanted).not.toHaveBeenCalled();
  });
});
