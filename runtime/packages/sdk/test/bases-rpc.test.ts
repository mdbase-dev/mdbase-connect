import {describe,expect,it,vi} from "vitest";
import {NativeBasesReads} from "../src/transport/bases-rpc.js";
describe("original-session native Bases READ FIFO",()=>{
  it("keeps cancelled in-flight work occupied, wipes abandoned reply and dispatches the next original READ",async()=>{
    let finish!: (reply:Uint8Array)=>void;
    const abandoned=Uint8Array.of(9);
    const request=vi.fn().mockImplementationOnce(()=>new Promise<Uint8Array>(resolve=>{finish=resolve;})).mockResolvedValueOnce(Uint8Array.of(8));
    const queue=new NativeBasesReads(request),abort=new AbortController();
    const input=Uint8Array.of(1),first=queue.read("app_bases_list_views_v1",input,1024,abort.signal);
    input.fill(0);
    await Promise.resolve();
    expect(request.mock.calls[0]![1]).toEqual(Uint8Array.of(1));
    const second=queue.read("app_bases_execute_v1",Uint8Array.of(2),1024);
    abort.abort();
    await expect(first).rejects.toMatchObject({code:"cancelled"});
    expect(request).toHaveBeenCalledOnce();
    finish(abandoned);
    expect(await second).toEqual(Uint8Array.of(8));
    expect(abandoned).toEqual(Uint8Array.of(0));
    expect(request.mock.calls[1]![0]).toBe("app_bases_execute_v1");
  });
  it("bounded waiters reject overflow and cancelled waiters never reach the replica",async()=>{
    let finish!: (reply:Uint8Array)=>void;
    const request=vi.fn(()=>new Promise<Uint8Array>(resolve=>{finish=resolve;}));
    const queue=new NativeBasesReads(request);
    const first=queue.read("app_bases_list_views_v1",Uint8Array.of(1),1024);
    await Promise.resolve();
    const aborts=Array.from({length:32},()=>new AbortController());
    const waiting=aborts.map(abort=>queue.read("app_bases_list_views_v1",Uint8Array.of(2),1024,abort.signal).catch(error=>error));
    await expect(queue.read("app_bases_execute_v1",Uint8Array.of(3),1024)).rejects.toMatchObject({reason:"bases_read_backpressure"});
    aborts.forEach(abort=>abort.abort());
    expect((await Promise.all(waiting)).every(error=>error.code==="cancelled")).toBe(true);
    finish(Uint8Array.of(9));
    expect(await first).toEqual(Uint8Array.of(9));
    for(let i=0;i<34;i++) await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
  });
  it("preserves native Problems, rejects nonbytes/oversized replies and never retries",async()=>{
    const problem=Object.assign(new Error("native refusal"),{code:"forbidden",reason:"view_full_collection_required"});
    const request=vi.fn().mockRejectedValueOnce(problem).mockResolvedValueOnce("not bytes").mockResolvedValueOnce(new Uint8Array(3));
    const queue=new NativeBasesReads(request);
    await expect(queue.read("app_bases_list_views_v1",Uint8Array.of(1),2)).rejects.toBe(problem);
    await expect(queue.read("app_bases_list_views_v1",Uint8Array.of(1),2)).rejects.toMatchObject({code:"internal"});
    await expect(queue.read("app_bases_list_views_v1",Uint8Array.of(1),2)).rejects.toMatchObject({code:"internal"});
    expect(request).toHaveBeenCalledTimes(3);
  });
});
