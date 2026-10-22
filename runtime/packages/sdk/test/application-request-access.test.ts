import {describe,expect,it,vi} from "vitest";
import {awaitFileAccess,fileAccessGate,missingFileActions,type FileAccessDeclaration} from "../src/application/file-access.js";
import {bindFileAccess,FilesApi} from "../src/files.js";
import {describeError} from "../src/describe-error.js";
import type {MdbaseClient} from "../src/client.js";
import type {AppWebSignInSnapshot} from "../src/app-host/web-sign-in-session.js";

const declared:FileAccessDeclaration={required:["list","read"],optional:["add"]};
const reason={reason:"Insert an image"};
const base:AppWebSignInSnapshot={status:"ready",signIn:null,collections:[],selectedCollectionId:null,problem:null,timing:null};
const access=(state:"pending"|"granted"|"declined"|"expired",requestId="r1")=>({...base,fileAccess:{requestId,collectionId:"c",actions:["add" as const],state}});
/** Scripted Worker outcomes: start answers pending, then each poll the next state. */
function port(states:Array<"pending"|"granted"|"declined">){
  let current:AppWebSignInSnapshot=base;
  const poll=vi.fn(async()=>{current=access(states.shift()??"pending");});
  return {poll,start:vi.fn(async()=>(current=access("pending"))),native:()=>current,granted:()=>({status:"granted" as const,actions:["list","read","add"] as const})};
}
const window=(closedAfter=Infinity)=>{let reads=0;return {close:vi.fn(),get closed(){return ++reads>closedAfter;}};};

describe("requestAccess",()=>{
  it("needs no Connect window when the action is already allowed",()=>{
    expect(missingFileActions(declared,{files:["read"]},reason,[])).toEqual([]);
    expect(missingFileActions(declared,{files:["add"]},reason,["add"])).toEqual([]);
    expect(missingFileActions(declared,{files:["add"]},reason,[])).toEqual(["add"]);
  });
  it("refuses actions the manifest does not declare, and malformed reasons",()=>{
    expect(()=>missingFileActions(declared,{files:["delete"]},reason,[])).toThrow(expect.objectContaining({code:"forbidden",reason:"access_undeclared"}));
    expect(()=>missingFileActions(null,{files:["add"]},reason,[])).toThrow(expect.objectContaining({reason:"access_undeclared"}));
    expect(()=>missingFileActions(declared,{files:["add"]},{reason:"two\nlines"},[])).toThrow(expect.objectContaining({reason:"access_invalid"}));
  });
  it("resolves granted once the person allows it, and closes the window",async()=>{
    vi.useFakeTimers();try{
      const p=port(["pending","granted"]),w=window(),result=awaitFileAccess(p,w,new AbortController().signal);
      await vi.advanceTimersByTimeAsync(4000);
      await expect(result).resolves.toEqual({status:"granted",actions:["list","read","add"]});expect(w.close).toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
  it("resolves declined when the person says no",async()=>{
    vi.useFakeTimers();try{
      const result=awaitFileAccess(port(["declined"]),window(),new AbortController().signal);
      await vi.advanceTimersByTimeAsync(2000);await expect(result).resolves.toEqual({status:"declined"});
    }finally{vi.useRealTimers();}
  });
  it("resolves cancelled on abort, and after one last read when the window closes",async()=>{
    vi.useFakeTimers();try{
      const aborted=new AbortController(),w=window(),first=awaitFileAccess(port([]),w,aborted.signal);
      await vi.advanceTimersByTimeAsync(10);aborted.abort();await vi.advanceTimersByTimeAsync(10);
      await expect(first).resolves.toEqual({status:"cancelled"});expect(w.close).toHaveBeenCalled();
      const p=port(["pending"]),second=awaitFileAccess(p,window(0),new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1000);await expect(second).resolves.toEqual({status:"cancelled"});expect(p.poll).toHaveBeenCalledOnce();
      // Allowed just before Connect closed its window: the last read wins.
      const late=awaitFileAccess(port(["granted"]),window(0),new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1000);await expect(late).resolves.toMatchObject({status:"granted"});
    }finally{vi.useRealTimers();}
  });
  it("rejects file writes the person has not allowed with access_required, before any replica call",async()=>{
    const client={onSession:()=>{},hello:{version:{major:1,minor:2},grant:{capabilities:["collection.read","records.create","records.edit","records.delete"],role:"editor"}}} as unknown as MdbaseClient;
    const files=new FilesApi(client);let allowed:readonly ("add")[]=[];
    bindFileAccess(files,fileAccessGate(declared,()=>allowed));
    await expect(files.upload("a.png",new Uint8Array([1]))).rejects.toMatchObject({code:"forbidden",reason:"access_required"});
    await expect(files.delete("11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({reason:"access_undeclared"});
    expect(files.grant?.actions).toEqual(["list","read"]);
    allowed=["add"];expect(files.grant?.actions).toEqual(["list","read","add"]);
    const copy=describeError({code:"forbidden",reason:"access_required"});
    expect(copy).toMatchObject({action:"approve",actionLabel:"Allow"});expect(copy?.developerMessage).toContain("requestAccess");
    for(const code of ["access_required","access_undeclared","access_declined"]){
      const d=describeError(code)!;expect(d.key).toBe(code);
      expect(`${d.title} ${d.message} ${d.actionLabel??""}`).not.toMatch(/\b(replica|grant|native|runtime|manifest|declared|optional|scope|consent)\b/i);
    }
  });
});
