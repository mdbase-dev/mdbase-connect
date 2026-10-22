import {beforeEach,describe,expect,it,vi} from "vitest";
import {readCollectionCreation,keepCollectionCreation,finishCollectionCreation} from "./collection-creation-intent";
const intent={accountId:"account-a",requestId:"11111111-1111-4111-a111-111111111111",displayName:"Original name",timezone:"UTC"};
beforeEach(()=>{localStorage.clear();vi.restoreAllMocks();});
describe("durable collection request metadata",()=>{
  it("retains original nonce/name across reload, scoped to the account",()=>{
    keepCollectionCreation(intent);expect(readCollectionCreation(intent.accountId)).toEqual(intent);
    expect(readCollectionCreation("account-b")).toBeNull();
    expect(JSON.parse(localStorage.getItem(`mdbase.connect.collection-creation:${intent.accountId}`)!)).toEqual(intent);
  });
  it("only clears the exact acknowledged request",()=>{
    keepCollectionCreation(intent);finishCollectionCreation({...intent,requestId:"22222222-2222-4222-a222-222222222222"});
    expect(readCollectionCreation(intent.accountId)).toEqual(intent);finishCollectionCreation(intent);expect(readCollectionCreation(intent.accountId)).toBeNull();
  });
  it("rejects malformed or cross-account restored metadata",()=>{
    for(const value of ["{",JSON.stringify({...intent,accountId:"other"}),JSON.stringify({...intent,requestId:"invalid"})]) {
      localStorage.setItem(`mdbase.connect.collection-creation:${intent.accountId}`,value);expect(readCollectionCreation(intent.accountId)).toBeNull();
    }
  });
  it("refuses persistence when browser storage fails",()=>{
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
    expect(()=>keepCollectionCreation(intent)).toThrow("quota");
  });
});
