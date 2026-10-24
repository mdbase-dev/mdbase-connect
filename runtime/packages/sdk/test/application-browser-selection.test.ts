import {describe,expect,it,vi} from "vitest";
import {ApplicationBrowserSelection,ApplicationSelectionError,applicationStartTarget,type ApplicationSelectionBrowserPort} from "../src/application/browser-selection.js";
const origin="https://app.test",a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
function browser(href:string){
  const entries=[href],listeners=new Set<()=>void>(),writes:Array<{href:string;history:"push"|"replace"}>=[];let cursor=0;
  const port:ApplicationSelectionBrowserPort={href:()=>entries[cursor]!,write:(next,history)=>{writes.push({href:next,history});if(history==="push"){entries.splice(cursor+1);entries.push(next);cursor++;}else entries[cursor]=next;},listen:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
  return{port,writes,listeners,pop:(direction:number)=>{cursor+=direction;for(const listener of [...listeners])listener();},replace:(next:string)=>{entries[cursor]=next;for(const listener of [...listeners])listener();}};
}
describe("SDK-owned browser requested-selection policy (not authority)",()=>{
  it("URL A beats stored/preferred B, including A not yet admitted; never silently opens B",()=>{
    const web=browser(`${origin}/base/tasks?collection=${a}`),selection=new ApplicationBrowserSelection(origin,{},web.port),hint=selection.start();
    expect(applicationStartTarget(hint,{storedId:b,preferredId:b,collections:[{collectionId:b}]})).toEqual({requestedCollectionId:a,source:"url",problem:null});selection.close();
  });
  it.each([["collection=","application_selection_empty"],[`collection=${a}&collection=${b}`,"application_selection_duplicate"],["collection=next%3Aaccount%3Acollection","application_selection_invalid"],["collection=00000000-0000-0000-0000-000000000000","application_selection_invalid"]])("malformed URL %s has a typed problem and does not fall back",(query,code)=>{
    const web=browser(`${origin}/?${query}`),selection=new ApplicationBrowserSelection(origin,{},web.port),hint=selection.start();
    expect(hint).toEqual({requestedCollectionId:null,source:"url",problem:code});expect(applicationStartTarget(hint,{storedId:b,collections:[{collectionId:b}]})).toBe(hint);selection.close();
  });
  it("without URL: stored before admitted preferred, then sole, then no forced selection",()=>{
    const selection=new ApplicationBrowserSelection(origin),hint=selection.start();expect(applicationStartTarget(hint,{storedId:a,preferredId:b,collections:[{collectionId:b}]})).toMatchObject({requestedCollectionId:a,source:"stored"});
    expect(applicationStartTarget(hint,{preferredId:b,collections:[{collectionId:a},{collectionId:b}]})).toMatchObject({requestedCollectionId:b,source:"preferred"});
    expect(applicationStartTarget(hint,{collections:[{collectionId:a}]})).toMatchObject({requestedCollectionId:a,source:"sole"});expect(applicationStartTarget(hint,{collections:[{collectionId:a},{collectionId:b}]})).toMatchObject({requestedCollectionId:null,source:"none"});selection.close();
  });
  it("select/history/clear preserve pathname/hash/unrelated parameters and history state policy",()=>{
    const web=browser(`${origin}/base/tasks?view=today&q=two+words&code=app-owned#detail`),selection=new ApplicationBrowserSelection(origin,{fallbackPath:"/base/"},web.port);selection.start();selection.select(a);expect(web.writes[0]?.history).toBe("replace");
    const first=new URL(web.port.href());expect(first.pathname).toBe("/base/tasks");expect(first.hash).toBe("#detail");expect(first.searchParams.get("view")).toBe("today");expect(first.searchParams.get("q")).toBe("two words");expect(first.searchParams.get("code")).toBe("app-owned");
    selection.select(b,{history:"push"});expect(web.writes[1]?.history).toBe("push");web.pop(-1);expect(selection.getSnapshot()).toMatchObject({requestedCollectionId:a,source:"url"});web.pop(1);expect(selection.getSnapshot()).toMatchObject({requestedCollectionId:b,source:"url"});
    selection.select(null);expect(new URL(web.port.href()).searchParams.has("collection")).toBe(false);expect(new URL(web.port.href()).hash).toBe("#detail");selection.close();
  });
  it("same-ID selection is idempotent; explicit selection fixes malformed URL, close stops popstate",()=>{
    const web=browser(`${origin}/?collection=${a}&collection=${b}`),selection=new ApplicationBrowserSelection(origin,{},web.port),listener=vi.fn();selection.subscribe(listener);selection.start();selection.select(a);const notifications=listener.mock.calls.length;selection.select(a);expect(web.writes).toHaveLength(1);expect(listener).toHaveBeenCalledTimes(notifications);
    expect(new URL(web.port.href()).searchParams.getAll("collection")).toEqual([a]);selection.close();selection.close();expect(web.listeners.size).toBe(0);expect(()=>selection.select(b)).toThrow(ApplicationSelectionError);expect(()=>selection.start()).toThrow(ApplicationSelectionError);
  });
  it("custom parameter/base-path with same-origin return path and no cross-origin navigation",()=>{
    const web=browser(`${origin}/base/?db=${a}&collection=unrelated`),selection=new ApplicationBrowserSelection(origin,{parameter:"db",fallbackPath:"/base/"},web.port);expect(selection.start().requestedCollectionId).toBe(a);
    expect(selection.returnUrl(`${origin}/base/task?view=today#task`)).toBe(`${origin}/base/task?view=today#task`);expect(selection.returnUrl("https://foreign.test/task")).toBe(`${origin}/base/`);selection.select(b);expect(new URL(web.port.href()).searchParams.get("collection")).toBe("unrelated");selection.close();
    expect(()=>new ApplicationBrowserSelection(origin,{fallbackPath:"https://foreign.test/"},web.port)).toThrow(ApplicationSelectionError);expect(()=>new ApplicationBrowserSelection(origin,{parameter:"code"},web.port)).toThrow(ApplicationSelectionError);
  });
  it("no-location policy remains requested metadata only; corrupt metadata never becomes a usable client",()=>{
    const selection=new ApplicationBrowserSelection(origin),hint=selection.start();expect(hint).toEqual({requestedCollectionId:null,source:"none",problem:null});expect(selection.select(a)).toMatchObject({requestedCollectionId:a,source:"user"});
    expect(applicationStartTarget(hint,{collections:[{collectionId:a},{collectionId:a}]}).problem).toBe("application_selection_metadata");expect(applicationStartTarget(hint,{preferredId:b,collections:[{collectionId:a}]}).problem).toBe("application_selection_metadata");expect(applicationStartTarget(hint,{storedId:"invalid",collections:[{collectionId:a}]}).problem).toBe("application_selection_invalid");selection.close();
  });
});
