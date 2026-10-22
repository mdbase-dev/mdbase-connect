import { describe, expect, it, vi } from "vitest";
import { MdbasePeopleClient, PERSON_CONTRACT, sameIdentity, type PeopleAuthority } from "../src/people.js";
import { mdbaseError } from "../src/errors.js";
import type { ContractQueryResult } from "../src/contract-query.js";
import type { Session } from "../src/session.js";
import { toFmMap, type PlainValue } from "../src/values.js";

const identity = { issuer: "https://id.example", subject: "acct_exact" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function page(names: Array<{name: string; claims?: PlainValue; error?: boolean; duplicate?: string}>, cursor?: string, asOf = 7): ContractQueryResult {
  const records = names.map((row, i) => ({ id: id(i+1), implementations: [{ typeName: "arbitrary", fields: toFmMap({name:row.name, identities:row.claims ?? [identity]}), issues: row.error ? [{ code:"data_contract_record_invalid",severity:"error" as const,message:"invalid name" }] : [] }, ...(row.duplicate ? [{typeName:"other",fields:toFmMap({name:row.duplicate,identities:[identity]}),issues:[]}] : [])] }));
  return { version:1, contractDigest:"a".repeat(64), records, page:{ records:records.map(row=>({id:row.id,path:`people/${row.id}.md`,revision:"b".repeat(64),frontmatter:new Map(),types:["arbitrary"],state:{state:"confirmed",confirmedSeq:1}})),complete:true,asOf,hasMore:!!cursor,...(cursor?{cursor}:{}) } };
}
function fixture(pages = [page([{name:"Alice"}])]) {
  const newSession = () => ({closed:false,hello:{collection:id(100)}} as Session);
  let current = true, session = newSession(), at = 0;
  const request = vi.fn(async (resource:string):Promise<unknown> => resource === "identity" ? {...identity,name:"Account Alice",account_id:id(99)} : {members:[{...identity,name:"Account Alice",role:"owner",account_id:id(99)}]});
  const authority: PeopleAuthority = {collection:id(100),request,isCurrent:()=>current};
  const client = {queryContract:vi.fn(async()=>pages[at++]!),readyForRead:vi.fn(async()=>session),currentSession:()=>session};
  const people = new MdbasePeopleClient(client,authority);
  return {people,client,request,authority,lose:()=>{current=false;},replaceSession:()=>{session=newSession();}};
}

describe("native Person directory",()=>{
  it("sequences identity THEN members on one metadata slot while SAME native data lane proceeds",async()=>{
    const f=fixture(); let release!:(value:unknown)=>void, occupied=false;
    f.request.mockImplementation(resource=>{
      if(occupied) return Promise.reject(mdbaseError("unavailable","occupied","people_busy"));
      if(resource==="identity") {occupied=true; return new Promise(resolve=>{release=value=>{occupied=false;resolve(value);};});}
      return Promise.resolve({members:[]});
    });
    const directory=f.people.directory();
    void directory.catch(()=>{}); // Original concurrent implementation may reject before the test's release.
    try {
      await vi.waitFor(()=>expect(f.client.queryContract).toHaveBeenCalledOnce());
      expect(f.request.mock.calls.map(([resource])=>resource)).toEqual(["identity"]);
    } finally {release({...identity,name:"Account Alice",account_id:id(99)});}
    expect((await directory).me.status).toBe("linked");
    expect(f.request.mock.calls.map(([resource])=>resource)).toEqual(["identity","members"]);
  });
  it("does not start members after the original identity caller was canceled",async()=>{
    const f=fixture(), caller=new AbortController();
    f.request.mockImplementation(async()=>{caller.abort();return {...identity,name:"Alice"};});
    await expect(f.people.directory({signal:caller.signal})).rejects.toBeDefined();
    expect(f.request).toHaveBeenCalledOnce();
  });
  it("uses canonical contract projections, native IDs and exact issuer/subject",async()=>{
    const f=fixture(), result=await f.people.directory();
    expect(f.client.queryContract).toHaveBeenCalledWith(PERSON_CONTRACT,{pageSize:128});
    expect(result.me).toMatchObject({status:"linked",person:{id:id(1),name:"Alice",typeNames:["arbitrary"]}});
    expect(result.account).toMatchObject({name:"Account Alice",accountId:id(99)});
    expect(result.members?.[0]?.accountId).toBe(id(99));
    expect(sameIdentity(identity,{...identity,issuer:"https://ID.example"})).toBe(false);
  });
  it("refuses mixed CP/native collection scopes before querying records",async()=>{
    const f=fixture(); Object.assign(f.authority,{collection:id(101)});
    await expect(f.people.directory()).rejects.toMatchObject({reason:"people_binding"});
    expect(f.client.queryContract).not.toHaveBeenCalled();
  });
  it("never guesses identity from name or normalized issuer",async()=>{
    const f=fixture([page([{name:"Account Alice",claims:[{...identity,issuer:"https://ID.example"}]}])]);
    expect((await f.people.directory()).me).toEqual({status:"unlinked"});
  });
  it("requires canonical map name rather than unrelated display entries",async()=>{
    const result=page([{name:"Alice"}]);
    result.records[0]!.implementations[0]!.fields.delete("name");
    result.records[0]!.implementations[0]!.fields.set("displayName","Alice");
    const directory=await fixture([result]).people.directory();
    expect(directory.people).toHaveLength(0);
    expect(directory.me.status).toBe("invalid");
    expect(directory.invalid[0]?.reason).toBe("It needs a non-blank name.");
  });
  it("only exact nested canonical issuer and subject entries create claims",async()=>{
    const result=page([{name:"Alice",claims:[{provider:identity.issuer,subject:identity.subject},{issuer:identity.issuer,account:identity.subject}]}]);
    result.records[0]!.implementations[0]!.issues=[{code:"data_contract_record_invalid",severity:"error",message:"invalid identity"}];
    const directory=await fixture([result]).people.directory();
    expect(directory.me).toEqual({status:"unlinked"});
    expect(directory.invalid[0]?.reason).toBe("invalid identity");
    expect(directory.people).toHaveLength(0);
  });
  it("reports ambiguous records",async()=>{
    expect((await fixture([page([{name:"A"},{name:"B"}])]).people.directory()).me).toMatchObject({status:"ambiguous",paths:[expect.any(String),expect.any(String)]});
  });
  it("an invalid projection claiming the account blocks a valid match",async()=>{
    const result=await fixture([page([{name:"",error:true},{name:"Alice"}])]).people.directory();
    expect(result.me.status).toBe("invalid"); expect(result.invalid[0]?.reason).toBe("invalid name");
    expect(result.people).toHaveLength(1);
  });
  it("coalesces identical implementations, rejects differing projections",async()=>{
    const same=await fixture([page([{name:"Alice",duplicate:"Alice"}])]).people.directory();
    expect(same.people[0]?.typeNames).toEqual(["arbitrary","other"]);
    expect((await fixture([page([{name:"Alice",duplicate:"Bob"}])]).people.directory()).me.status).toBe("invalid");
  });
  it("reads every page and never presents an incomplete prefix",async()=>{
    const first=page([{name:"A",claims:[]}],"q1.cursor"), second=page([{name:"B"}]);
    second.records[0]!.id=id(2); second.page.records[0]!.id=id(2); second.page.records[0]!.path="people/B.md";
    second.page.totalCount=2;
    const f=fixture([first,second]); expect((await f.people.directory()).people).toHaveLength(2);
    expect(f.client.queryContract.mock.calls[1]).toEqual([PERSON_CONTRACT,{pageSize:128,cursor:"q1.cursor"}]);
    const broken=fixture([first]); broken.client.queryContract.mockImplementationOnce(async()=>first).mockRejectedValueOnce(mdbaseError("invalid_request","stale","cursor_stale"));
    await expect(broken.people.directory()).rejects.toMatchObject({reason:"cursor_stale"});
  });
  it.each(["view","digest","complete"])("fails closed on %s change",async kind=>{
    const first=page([{name:"A"}],"q1.cursor"), second=page([{name:"B"}]);
    second.records[0]!.id=id(2);second.page.records[0]!.id=id(2);
    const f=fixture([first,second]);
    if(kind==="view")second.page.asOf++;
    if(kind==="digest")second.contractDigest="c".repeat(64);
    if(kind==="complete")second.page.complete=false;
    await expect(f.people.directory()).rejects.toBeDefined();
  });
  it("omits members only for explicit permission decline, not other refusals",async()=>{
    const f=fixture();f.request.mockImplementation(async resource=>{if(resource==="members")throw mdbaseError("forbidden","declined","people_permission_declined");return {...identity,name:"Alice",account_id:id(99)};});
    expect(await f.people.directory()).not.toHaveProperty("members");
    await expect(f.people.directory({members:"require"})).rejects.toMatchObject({reason:"people_permission_declined"});
    const denied=fixture();denied.request.mockRejectedValue(mdbaseError("forbidden","scope","people_access"));
    await expect(denied.people.directory()).rejects.toMatchObject({reason:"people_access"});
    const omitted=fixture(); await omitted.people.directory({members:"omit"}); expect(omitted.request.mock.calls.map(([resource])=>resource)).toEqual(["identity"]);
  });
  it("only a first-page absent Person contract means an empty directory",async()=>{
    const f=fixture();f.client.queryContract.mockRejectedValue(mdbaseError("not_found","absent","data_contract_not_found"));
    expect((await f.people.directory()).me).toEqual({status:"unlinked"});
    const later=fixture([page([{name:"A"}],"q1.cursor")]);later.client.queryContract.mockImplementationOnce(async()=>page([{name:"A"}],"q1.cursor")).mockRejectedValueOnce(mdbaseError("not_found","absent","data_contract_not_found"));
    await expect(later.people.directory()).rejects.toMatchObject({reason:"data_contract_not_found"});
  });
  it("late metadata and native replies cannot escape a lost scope",async()=>{
    const f=fixture();f.request.mockImplementation(async()=>{f.lose();return {...identity,name:"Alice",account_id:id(99)};});
    await expect(f.people.current()).rejects.toMatchObject({reason:"people_fenced"});
    const g=fixture();g.client.queryContract.mockImplementation(async()=>{g.lose();return page([{name:"Alice"}]);});
    await expect(g.people.directory()).rejects.toMatchObject({reason:"people_fenced"});
  });
});
