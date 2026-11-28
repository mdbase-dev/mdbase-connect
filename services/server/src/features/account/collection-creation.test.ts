import {beforeEach, describe, expect, it, vi} from "vitest";
import Fastify from "fastify";
import {setTimeout as delay} from "node:timers/promises";
import type {DatabasePool} from "../../database-types.js";
import {CreateError} from "../next/bootstrap-common.js";
import {createServiceCloudCopy, currentCloudCopy, type CloudCopyBootstrapOptions} from "../next/service-cloud-copy.js";
import {requireSessionContext} from "../../platform/request-authentication.js";
import {createAccountCollection} from "./collection-creation.js";
import {registerAccountCollectionCreationRoutes} from "./collection-creation-routes.js";
vi.mock("../next/service-cloud-copy.js",async(importOriginal)=>({
  ...await importOriginal<typeof import("../next/service-cloud-copy.js")>(),
  createServiceCloudCopy:vi.fn(),currentCloudCopy:vi.fn()
}));
vi.mock("../../platform/request-authentication.js",()=>({requireSessionContext:vi.fn(),requireUser:vi.fn()}));
const account="11111111-1111-4111-a111-111111111111", requestId="22222222-2222-4222-a222-222222222222";
const input={requestId,displayName:"Original name",timezone:"Australia/Melbourne"};
function fixture(runtime="next", flipped=true) {
  const intents=new Map<string,Record<string,unknown>>(), collections=new Map<string,{id:string;display_name:string}>();
  const queries:string[]=[];
  const client={release(){},async query(sql:string,values:unknown[]=[]) {
    queries.push(sql);
    if(sql.includes("SELECT u.account_backend"))return{rows:[{account_backend:runtime,flipped}]};
    if(sql.includes("SELECT 1 FROM sessions s JOIN users u"))return{rows:[{}]};
    if(sql.includes("SELECT ops->>'region' AS region"))return{rows:[{region:"oc"}]};
    if(sql.includes("INSERT INTO account_collection_creations")) {
      const [user_id,request_id,collection_id,display_name,timezone,backend]=values;
      const key=`${user_id}:${request_id}`;
      if(!intents.has(key))intents.set(key,{user_id,request_id,collection_id,display_name,timezone,runtime:backend,published_at:null});
    }
    if(sql.includes("SELECT * FROM account_collection_creations"))return{rows:[intents.get(`${values[0]}:${values[1]}`)].filter(Boolean)};
    if(sql.includes("UPDATE account_collection_creations")) {const row=intents.get(`${values[0]}:${values[1]}`)!;row.published_at=new Date();return{rows:[{}]};}
    if(sql.includes("FROM next_collections")||sql.includes("FROM hosted_collections"))return{rows:[collections.get(String(values[0]))].filter(Boolean)};
    return{rows:[]};
  }};
  const db={...client,async connect(){return client;}} as unknown as DatabasePool;
  const fetchImpl = vi.fn<typeof fetch>(async (_endpoint, init) => Response.json({initialized:true,...JSON.parse(String(init?.body))}));
  const options={db,publicUrl:"https://example.test",hostedCollections:true,native:{db, fetchImpl, next:{
    logService:{},cloudCopyBootstrap:{hosted:{url:"https://hosted.test",token:"h".repeat(32)},escrow:{url:"https://escrow.test",token:"e".repeat(32)}}
  }} as CloudCopyBootstrapOptions};
  const principal=vi.fn(async()=>{});
  vi.mocked(createServiceCloudCopy).mockImplementation(async(_options,args)=>{
    await args.current(client as never);
    collections.set(args.collection,{id:args.collection,display_name:args.displayName!});
    await args.initialContent?.();
    return {} as never;
  });
  vi.mocked(currentCloudCopy).mockImplementation(async(_client,id)=>{if(!collections.has(id))throw new CreateError(404,"collection_unavailable");});
  return{options,principal,intents,collections,queries,fetchImpl};
}
beforeEach(()=>vi.resetAllMocks());
describe("account collection immutable intent",()=>{
  it("resumes an unknown native outcome with the SAME UUID/name, without pairing or browser authority",async()=>{
    const f=fixture();const normal=vi.mocked(createServiceCloudCopy).getMockImplementation()!;
    vi.mocked(createServiceCloudCopy).mockImplementationOnce(async(...args)=>{await normal(...args);throw new CreateError(503,"not_ready");});
    await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({status:503});
    const result=await createAccountCollection(f.options,account,input,f.principal);
    const calls=vi.mocked(createServiceCloudCopy).mock.calls.map(call=>call[1]);
    expect(calls[0].collection).toBe(calls[1].collection);
    expect(calls[1]).toMatchObject({owner:account,runtime:"next",displayName:input.displayName});
    expect(Object.keys(calls[1]).sort()).toEqual(["collection","current","displayName","initialContent","owner","runtime"]);
    expect(f.fetchImpl.mock.calls.map(([,init])=>JSON.parse(String(init?.body)))).toEqual(Array(2).fill({
      collection:result.id,request_id:requestId,timezone:input.timezone,region:"oc"
    }));
    expect(f.collections.size).toBe(1);expect(result.id).toBe(calls[0].collection);
    expect(f.principal).toHaveBeenCalled();
  });
  it("the Portal route publishes only a matching hosted confirmation, and a published retry does not reseed", async () => {
    const f = fixture();
    const app = Fastify();
    registerAccountCollectionCreationRoutes(app, f.options);
    vi.mocked(requireSessionContext).mockResolvedValue({user:{id:account},sessionId:"original"} as never);
    const create = () => app.inject({method:"POST",url:"/v1/account/collections",payload:{
      account_id:account,request_id:requestId,display_name:input.displayName,timezone:input.timezone
    }});
    f.fetchImpl.mockRejectedValueOnce(new Error("response lost"));
    f.fetchImpl.mockResolvedValueOnce(Response.json({initialized:true,collection:account,request_id:requestId}));
    expect((await create()).statusCode).toBe(503);
    expect(f.intents.get(`${account}:${requestId}`)?.published_at).toBeNull();
    expect((await create()).statusCode).toBe(503);
    expect(f.intents.get(`${account}:${requestId}`)?.published_at).toBeNull();
    const result = await create();
    expect(result.statusCode).toBe(200);
    const intent = f.intents.get(`${account}:${requestId}`)!;
    expect(intent.published_at).toBeInstanceOf(Date);
    expect(result.json()).toEqual({collection:{id:intent.collection_id,display_name:input.displayName}});
    expect((await create()).json()).toEqual(result.json());
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    for (const [endpoint, init] of f.fetchImpl.mock.calls) {
      expect(String(endpoint)).toBe("https://hosted.test/internal/v1/collections/initialize");
      expect(init?.headers).toMatchObject({authorization:`Bearer ${"h".repeat(32)}`});
      expect(JSON.parse(String(init?.body))).toEqual({collection:intent.collection_id,request_id:requestId,timezone:input.timezone,region:"oc"});
    }
    await app.close();
  });
  it("publishes on the first Portal request when hosted confirmation takes more than one attempt", async () => {
    const f = fixture();
    const app = Fastify();
    registerAccountCollectionCreationRoutes(app, f.options);
    vi.mocked(requireSessionContext).mockResolvedValue({user:{id:account},sessionId:"original"} as never);
    const create = () => app.inject({method:"POST",url:"/v1/account/collections",payload:{
      account_id:account,request_id:requestId,display_name:input.displayName,timezone:input.timezone
    }});
    const pending = () => Response.json({error:"initialization_not_confirmed"}, {status:503});
    const acknowledge = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async () => pending()).mockImplementationOnce(async () => pending());
    f.fetchImpl.mockImplementationOnce(async (endpoint, init) => {
      await delay(2_100, undefined, {signal:init?.signal ?? undefined});
      expect(f.intents.get(`${account}:${requestId}`)?.published_at).toBeNull();
      return acknowledge(endpoint, init);
    });
    try {
      const first = await create();
      expect(first.statusCode).toBe(200);
      const intent = f.intents.get(`${account}:${requestId}`)!;
      expect(first.json().collection.id).toBe(intent.collection_id);
      expect(intent.published_at).toBeInstanceOf(Date);
      expect(f.collections.size).toBe(1);
      expect(createServiceCloudCopy).toHaveBeenCalledTimes(1);
      expect((await create()).json()).toEqual(first.json());
      expect(f.fetchImpl.mock.calls.map(([,init])=>JSON.parse(String(init?.body)))).toEqual(Array(3).fill({
        collection:intent.collection_id,request_id:requestId,timezone:input.timezone,region:"oc"
      }));
      expect(new Set(f.fetchImpl.mock.calls.map(([,init])=>init?.signal)).size).toBe(1);
    } finally {
      await app.close();
    }
  }, 12_000);
  it("does not retry hosted initialization after the original principal becomes invalid", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementationOnce(async () => {
      f.principal.mockRejectedValue(new CreateError(403,"identity_not_current"));
      return Response.json({error:"initialization_not_confirmed"}, {status:503});
    });
    await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({status:403});
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.intents.get(`${account}:${requestId}`)?.published_at).toBeNull();
  });
  it("keeps the intent unpublished when the hosted retry budget expires", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(Response.json({error:"initialization_not_confirmed"}, {status:503}));
    const deadline = AbortSignal.timeout(100);
    const timeout = vi.spyOn(AbortSignal,"timeout").mockReturnValueOnce(deadline);
    try {
      await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({status:503,code:"not_ready"});
      expect(timeout).toHaveBeenCalledWith(20_000);
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.intents.get(`${account}:${requestId}`)?.published_at).toBeNull();
    } finally {
      timeout.mockRestore();
    }
  });
  it("refuses a changed name/timezone and never replaces its original intent",async()=>{
    const f=fixture();await createAccountCollection(f.options,account,input,f.principal);
    for(const change of [{displayName:"Replacement"},{timezone:"UTC"}]) await expect(createAccountCollection(f.options,account,{...input,...change},f.principal)).rejects.toMatchObject({code:"creation_intent_mismatch"});
    expect(createServiceCloudCopy).toHaveBeenCalledTimes(1);
  });
  it("does not recreate a deleted published collection",async()=>{
    const f=fixture();await createAccountCollection(f.options,account,input,f.principal);f.collections.clear();
    await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({code:"collection_unavailable"});
    expect(createServiceCloudCopy).toHaveBeenCalledTimes(1);
  });
  it("forwards a missing browser zone as null and rejects invalid supplied zones", async () => {
    const f = fixture();
    const app = Fastify();
    registerAccountCollectionCreationRoutes(app, f.options);
    vi.mocked(requireSessionContext).mockResolvedValue({user:{id:account},sessionId:"original"} as never);
    const payload = {account_id:account, request_id:requestId, display_name:input.displayName};
    const create = (timezone?: string) => app.inject({method:"POST",url:"/v1/account/collections",payload:{...payload,timezone}});
    for (const timezone of ["", "local", "Mars/Olympus", "+05:30"]) {
      expect((await create(timezone)).statusCode).toBe(400);
    }
    expect(f.fetchImpl).not.toHaveBeenCalled();
    const result = await create();
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      collection:result.json().collection.id, request_id:requestId, timezone:null,
    });
    await app.close();
  });
  it("requires the flipped-account fact and current principal before effects",async()=>{
    const f=fixture("next",false);
    await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({code:"account_not_ready"});
    expect(createServiceCloudCopy).not.toHaveBeenCalled();expect(f.intents.size).toBe(0);
    const g=fixture();g.principal.mockRejectedValue(new CreateError(403,"identity_not_current"));
    await expect(createAccountCollection(g.options,account,input,g.principal)).rejects.toMatchObject({code:"identity_not_current"});
    expect(g.intents.size).toBe(0);
  });
  it("refuses legacy accounts after legacy hosted retirement",async()=>{
    const f=fixture("legacy");
    await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({code:"account_not_ready"});
  });
  it("rejects caller runtime, keys, source, admission and flipped browser account before creation",async()=>{
    const f=fixture();const app=Fastify();registerAccountCollectionCreationRoutes(app,f.options);
    const body={account_id:account,request_id:requestId,display_name:input.displayName,timezone:input.timezone};
    for(const extra of [{runtime:"next"},{source:"pairing"},{key:"fake"},{admission:"fake"}]) expect((await app.inject({method:"POST",url:"/v1/account/collections",payload:{...body,...extra}})).statusCode).toBe(400);
    vi.mocked(requireSessionContext).mockResolvedValue({user:{id:account},sessionId:"original"} as never);
    expect((await app.inject({method:"POST",url:"/v1/account/collections",payload:{...body,account_id:requestId}})).statusCode).toBe(409);
    expect(f.intents.size).toBe(0);expect(createServiceCloudCopy).not.toHaveBeenCalled();await app.close();
  });
});
