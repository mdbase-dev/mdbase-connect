import {beforeEach, describe, expect, it, vi} from "vitest";
import Fastify from "fastify";
import type {DatabasePool} from "../../database-types.js";
import {CreateError} from "../next/bootstrap-common.js";
import {createServiceCloudCopy, currentCloudCopy, type CloudCopyBootstrapOptions} from "../next/service-cloud-copy.js";
import {createHostedCollectionForUser} from "../hosted/service.js";
import {requireSessionContext} from "../../platform/request-authentication.js";
import {createAccountCollection} from "./collection-creation.js";
import {registerAccountCollectionCreationRoutes} from "./collection-creation-routes.js";
vi.mock("../next/migration-topology.js",()=>({requireNextAccountNotMigrationFrozen:vi.fn(async()=>false)}));
vi.mock("../next/service-cloud-copy.js",()=>({createServiceCloudCopy:vi.fn(),currentCloudCopy:vi.fn()}));
vi.mock("../hosted/service.js",()=>({createHostedCollectionForUser:vi.fn()}));
vi.mock("../../platform/request-authentication.js",()=>({requireSessionContext:vi.fn(),requireUser:vi.fn()}));
const account="11111111-1111-4111-a111-111111111111", requestId="22222222-2222-4222-a222-222222222222";
const input={requestId,displayName:"Original name",timezone:"Australia/Melbourne"};
function fixture(runtime="next", flipped=true) {
  const intents=new Map<string,Record<string,unknown>>(), collections=new Map<string,{id:string;display_name:string}>();
  const queries:string[]=[];
  const client={release(){},async query(sql:string,values:unknown[]=[]) {
    queries.push(sql);
    if(sql.includes("SELECT u.account_backend"))return{rows:[{account_backend:runtime,flipped}]};
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
  const options={db,publicUrl:"https://example.test",hostedCollections:true,native:{} as CloudCopyBootstrapOptions};
  const principal=vi.fn(async()=>{});
  vi.mocked(createServiceCloudCopy).mockImplementation(async(_options,args)=>{
    await args.current(client as never);
    collections.set(args.collection,{id:args.collection,display_name:args.displayName!});
    return {} as never;
  });
  vi.mocked(currentCloudCopy).mockImplementation(async(_client,id)=>{if(!collections.has(id))throw new CreateError(404,"collection_unavailable");});
  return{options,principal,intents,collections,queries};
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
    expect(Object.keys(calls[1]).sort()).toEqual(["collection","current","displayName","owner","runtime"]);
    expect(f.collections.size).toBe(1);expect(result.id).toBe(calls[0].collection);
    expect(f.principal).toHaveBeenCalled();
    expect(createHostedCollectionForUser).not.toHaveBeenCalled();
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
  it("requires the flipped-account fact and current principal before effects",async()=>{
    const f=fixture("next",false);
    await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({code:"account_not_ready"});
    expect(createServiceCloudCopy).not.toHaveBeenCalled();expect(f.intents.size).toBe(0);
    const g=fixture();g.principal.mockRejectedValue(new CreateError(403,"identity_not_current"));
    await expect(createAccountCollection(g.options,account,input,g.principal)).rejects.toMatchObject({code:"identity_not_current"});
    expect(g.intents.size).toBe(0);
  });
  it("publishes legacy receipt inside its creation transaction, then skips creation on retry",async()=>{
    const f=fixture("legacy");
    vi.mocked(createHostedCollectionForUser).mockImplementation(async(_options,_reference,_url,_user,name,_template,_tz,creation)=>{
      await creation!.current!(f.options.db as never);
      f.collections.set(creation!.collectionId!,{id:creation!.collectionId!,display_name:name});
      await creation!.published!(f.options.db as never);
      return {};
    });
    const first=await createAccountCollection(f.options,account,input,f.principal);
    expect((await createAccountCollection(f.options,account,input,f.principal)).id).toBe(first.id);
    expect(createHostedCollectionForUser).toHaveBeenCalledTimes(1);
    expect(f.queries.some(sql=>sql.includes("account_collection_creations")&&sql.endsWith("FOR UPDATE"))).toBe(true);
    f.collections.clear();await expect(createAccountCollection(f.options,account,input,f.principal)).rejects.toMatchObject({code:"collection_unavailable"});
    expect(createHostedCollectionForUser).toHaveBeenCalledTimes(1);
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
