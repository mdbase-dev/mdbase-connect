import {afterEach,describe,expect,it,vi} from "vitest";
import {attachAppTimerReceiver,appTimerPortClient} from "../src/app-host/timer-port.js";
import type {AppInstallationTimerChannel} from "../src/app-host/installation-sign-in.js";
import {TimersApi} from "../src/timers.js";
const scope={account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection:"33333333-3333-4333-8333-333333333333"};
const grant="44444444-4444-4444-8444-444444444444",generation="55555555-5555-4555-8555-555555555555",channelId="66666666-6666-4666-8666-666666666666";
const key=Uint8Array.from({length:65},(_,index)=>index===0?4:1),encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks();});
function fixture(handler:(url:string,init:RequestInit)=>Promise<Response>=async()=>Response.json({channel_id:channelId}),initial:AppInstallationTimerChannel|null=null){
  const channel=new MessageChannel(),life=new AbortController();let retained=initial;
  const write=vi.fn(async(value:AppInstallationTimerChannel|null)=>{retained=value;}),journal={read:()=>retained,write};
  const request=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>handler(String(input),init!));
  const owner=attachAppTimerReceiver(channel.port1,{scope,generation,grantId:grant,cpOrigin:"https://cp.example.test",signal:life.signal,isCurrent:()=>true,bearer:async()=>`idev_${"a".repeat(43)}`,fetch:request,journal});
  const port=appTimerPortClient(channel.port2,{scope,generation},{signal:life.signal,onClose:()=>{}}),api=new TimersApi(port);
  cleanup.push(async()=>{api.close();await owner.close();});return {api,port,owner,request,write,read:journal.read,life};
}
function platform(existing=false){
  const subscription={options:{applicationServerKey:key.buffer},toJSON:()=>({endpoint:"https://push.example.test/opaque",expirationTime:null,keys:{p256dh:encode(key),auth:encode(new Uint8Array(16).fill(2))}}),unsubscribe:vi.fn(async()=>true)};
  const pushManager={getSubscription:vi.fn(async()=>existing?subscription:null),subscribe:vi.fn(async()=>subscription)};
  return {subscription,pushManager,worker:{pushManager} as unknown as ServiceWorkerRegistration};
}
describe("native channel UI platform and fixed Worker journal admission",()=>{
  it("registers FCM only after durable ORIGINAL pending metadata, retains no target/token, and uses fixed original installation",async()=>{
    let f:ReturnType<typeof fixture>;f=fixture(async(url,init)=>{
      expect(f.read()).toMatchObject({grantId:grant,kind:"fcm",pending:"register",channelId:null});
      expect(url).toBe(`https://cp.example.test/v1/next/collections/${scope.collection}/background-grants/${grant}/notifications/channels`);
      expect(JSON.parse(String(init.body))).toEqual({installation_id:scope.installation,criteria:["reminder"],transport:"fcm",token:"native_fcm_opaque_token"});return Response.json({channel_id:channelId});
    });
    expect(await f.api.registerFcm({token:"native_fcm_opaque_token",criteria:["reminder"]})).toEqual({transport:"fcm",channelId,installationId:scope.installation,criteria:["reminder"]});
    expect(f.read()).toEqual({grantId:grant,kind:"fcm",targetDigest:expect.stringMatching(/^[0-9a-f]{64}$/),channelId,pending:null});
    expect(JSON.stringify(f.read())).not.toContain("native_fcm_opaque_token");expect(f.write).toHaveBeenCalledTimes(2);
  });
  it("unknown registration refuses even SAME-target replay and deletion until fresh approval retires this grant",async()=>{
    let count=0;const f=fixture(async(_url,init)=>{
      count++;if(count===1)throw Error("uncertain network");if(init.method==="DELETE")return new Response(null,{status:204});return Response.json({channel_id:channelId});
    });
    const input={token:"native_original_fcm_token",criteria:["reminder"]};
    await expect(f.api.registerFcm(input)).rejects.toMatchObject({code:"outcome_unknown"});const original=f.read();
    await expect(f.api.registerFcm({...input,token:"native_replacement_fcm_token"})).rejects.toMatchObject({code:"outcome_unknown",reason:"timer_channel_reapproval_required"});
    await expect(f.api.unregisterFcm()).rejects.toMatchObject({code:"outcome_unknown"});expect(f.request).toHaveBeenCalledOnce();expect(f.read()).toEqual(original);
    await expect(f.api.registerFcm(input)).rejects.toMatchObject({code:"outcome_unknown",reason:"timer_channel_reapproval_required"});expect(f.request).toHaveBeenCalledOnce();expect(f.read()).toEqual(original);
  });
  it("known HTTP refusal restores previous metadata; failed ack protection is UNKNOWN and cannot change target",async()=>{
    const f=fixture(async()=>Response.json({error:{code:"timer_grant_unusable"}},{status:403}));
    await expect(f.api.registerFcm({token:"native_fcm_opaque_token",criteria:["reminder"]})).rejects.toMatchObject({code:"unauthenticated"});expect(f.read()).toBeNull();
    const g=fixture(),retain=g.write.getMockImplementation()!;g.write.mockImplementationOnce(retain).mockImplementationOnce(async()=>{throw Error("protected commit failure");});
    await expect(g.api.registerFcm({token:"native_fcm_opaque_token",criteria:["reminder"]})).rejects.toMatchObject({code:"outcome_unknown"});expect(g.request).toHaveBeenCalledOnce();expect(g.read()).toMatchObject({pending:"register",channelId:null});
    await expect(g.api.registerFcm({token:"native_replacement_fcm_token",criteria:["reminder"]})).rejects.toMatchObject({code:"outcome_unknown",reason:"timer_channel_reapproval_required"});expect(g.request).toHaveBeenCalledOnce();
  });
  it("Web Push uses actual supplied UI platform; only original normalized DTO reaches Worker and unsubscribe follows acknowledged deletion",async()=>{
    const p=platform();let f:ReturnType<typeof fixture>;f=fixture(async(url,init)=>{
      if(url.endsWith("vapid-public-key"))return Response.json({public_key:encode(key)});
      if(init.method==="DELETE"){expect(p.subscription.unsubscribe).not.toHaveBeenCalled();return new Response(null,{status:204});}
      expect(JSON.parse(String(init.body))).toEqual({installation_id:scope.installation,criteria:["reminder"],subscription:p.subscription.toJSON()});return Response.json({channel_id:channelId});
    });
    await f.api.registerWebPush({serviceWorker:p.worker,criteria:["reminder"]});expect(p.pushManager.subscribe).toHaveBeenCalledWith({userVisibleOnly:true,applicationServerKey:key});
    p.pushManager.getSubscription.mockResolvedValue(p.subscription);await f.api.unregisterWebPush(p.worker);expect(p.subscription.unsubscribe).toHaveBeenCalledOnce();expect(f.read()).toBeNull();
    expect(JSON.stringify(f.read())).not.toContain("push.example.test");
  });
  it("calls the supplied fetch without an options receiver through Web Push VAPID lookup and Worker registration",async()=>{
    const p=platform(),channel=new MessageChannel(),life=new AbortController();let retained:AppInstallationTimerChannel|null=null;
    const request=vi.fn(async function(this:unknown,input:RequestInfo|URL,init?:RequestInit){
      if(this!==undefined&&this!==globalThis)throw new TypeError("Illegal invocation");
      expect(init).toMatchObject({credentials:"omit",redirect:"error",referrerPolicy:"no-referrer",headers:{authorization:`Bearer idev_${"a".repeat(43)}`}});
      expect(init?.signal).toBeInstanceOf(AbortSignal);expect(init?.signal?.aborted).toBe(false);
      if(String(input)==="https://cp.example.test/v1/notifications/vapid-public-key"){
        expect(init).toMatchObject({method:"GET",cache:"no-store"});expect(p.pushManager.subscribe).not.toHaveBeenCalled();
        return Response.json({public_key:encode(key)});
      }
      expect(String(input)).toBe(`https://cp.example.test/v1/next/collections/${scope.collection}/background-grants/${grant}/notifications/channels`);
      expect(init?.method).toBe("POST");expect(retained).toMatchObject({grantId:grant,pending:"register"});
      expect(JSON.parse(String(init?.body))).toEqual({installation_id:scope.installation,criteria:["reminder"],subscription:p.subscription.toJSON()});
      return Response.json({channel_id:channelId});
    });
    const owner=attachAppTimerReceiver(channel.port1,{scope,generation,grantId:grant,cpOrigin:"https://cp.example.test",signal:life.signal,isCurrent:()=>true,bearer:async()=>`idev_${"a".repeat(43)}`,fetch:request,
      journal:{read:()=>retained,write:async value=>{retained=value;}}});
    const port=appTimerPortClient(channel.port2,{scope,generation},{signal:life.signal,onClose:()=>{}}),api=new TimersApi(port);
    cleanup.push(async()=>{api.close();await owner.close();});
    expect(await api.registerWebPush({serviceWorker:p.worker,criteria:["reminder"]})).toEqual({channelId,installationId:scope.installation,criteria:["reminder"]});
    expect(request).toHaveBeenCalledTimes(2);expect(p.pushManager.subscribe).toHaveBeenCalledWith({userVisibleOnly:true,applicationServerKey:key});
    expect(retained).toMatchObject({channelId,pending:null});expect(JSON.stringify(retained)).not.toContain("push.example.test");
  });
  it("existing foreign VAPID key never silently resubscribes and no channel admission occurs",async()=>{
    const p=platform(true);p.subscription.options.applicationServerKey=new Uint8Array(65).buffer;
    const f=fixture(async()=>Response.json({public_key:encode(key)}));
    await expect(f.api.registerWebPush({serviceWorker:p.worker,criteria:["reminder"]})).rejects.toMatchObject({code:"invalid_request",reason:"timer_push_key_changed"});
    expect(p.pushManager.subscribe).not.toHaveBeenCalled();expect(f.request).toHaveBeenCalledOnce();expect(f.write).not.toHaveBeenCalled();
  });
  it("retains ONE full UI workflow slot across platform awaits, closes without deleting persistent channels",async()=>{
    let resolve!:(value:null)=>void;const p=platform();p.pushManager.getSubscription.mockImplementation(async()=>new Promise(r=>{resolve=r;}));
    const f=fixture(async url=>url.endsWith("vapid-public-key")?Response.json({public_key:encode(key)}):Response.json({channel_id:channelId}));
    const register=f.api.registerWebPush({serviceWorker:p.worker,criteria:["reminder"]});await vi.waitFor(()=>expect(p.pushManager.getSubscription).toHaveBeenCalledOnce());
    await expect(f.api.list("reminders")).rejects.toMatchObject({code:"unavailable",reason:"timer_port_busy"});f.api.close();resolve(null);
    await expect(register).rejects.toMatchObject({code:"cancelled"});expect(p.pushManager.subscribe).not.toHaveBeenCalled();expect(f.request).toHaveBeenCalledOnce();
  });
  it("replays uncertain DELETE only for the original protected channel; exact authenticated absence settles it",async()=>{
    const original={grantId:grant,kind:"fcm" as const,targetDigest:"ab".repeat(32),channelId,pending:"delete" as const};
    const f=fixture(async()=>Response.json({error:{code:"channel_not_found"}},{status:404}),original);
    await f.api.unregisterFcm();expect(f.read()).toBeNull();expect(f.request).toHaveBeenCalledOnce();
  });
});
