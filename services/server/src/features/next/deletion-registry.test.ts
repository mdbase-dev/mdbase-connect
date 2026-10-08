import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LogServiceClient } from "./log-service-client.js";
import { decodeCbor, encodeCbor, uuidBytes, type Cbor, type Decoded } from "./policy-wire.js";

const c="11111111-1111-4111-8111-111111111111", d="22222222-2222-4222-8222-222222222222", max=(1n<<64n)-1n;
const map=(...values:Cbor[]):Cbor=>({struct:values.map((value,key)=>[key,value] as const)});
const row:Cbor=[uuidBytes(c),uuidBytes(d),max];
const page=(rows:Cbor[]=[],cursor:Cbor=null,generation:Cbor=0n,done:Cbor=true)=>map(1,generation,rows,cursor,done);
function peer(result:Cbor | ((request:Map<number|string,Decoded>)=>Cbor|Response)) {
  const issuer=generateKeyPairSync("ed25519").privateKey, transport=generateKeyPairSync("ed25519").privateKey, nonce=Buffer.alloc(32,0x45);
  const calls:Array<{request:Map<number|string,Decoded>;init:RequestInit}>=[];
  const fetcher:typeof fetch=async(input,init)=>{
    expect(init?.signal).toBeDefined();
    if(new URL(String(input)).pathname==="/v1/nonce")return new Response(nonce.toString("hex"));
    const body=Buffer.from(init!.body as Buffer), request=decodeCbor(body) as Map<number|string,Decoded>, params=request.get(3) as Map<number,Decoded>;
    const headers=new Headers(init!.headers),token=headers.get("authorization")!.slice(7);
    const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest(),tag=Buffer.from("mdbase/v1/ls-http");
    const digest=sha(Buffer.concat([Buffer.of(tag.length),tag,Buffer.from(request.get(2) as string),Buffer.of(0),Buffer.from("/v1/rpc"),Buffer.of(0),params.get(0) as Uint8Array,sha(token),sha(body),nonce]));
    expect(verify(null,digest,transport,Buffer.from(headers.get("x-mdbase-sig")!,"hex"))).toBe(true);
    expect((decodeCbor(Buffer.from(token.split(".")[0]!,"hex")) as Map<number,Decoded>).get(0)).toBe(1);
    calls.push({request,init:init!});
    const value=typeof result==="function"?result(request):result;
    return value instanceof Response?value:new Response(encodeCbor({struct:[[0,1],[1,request.get(1) as number],[2,value]]}),{headers:{"content-type":"application/vnd.mdbase.v1+cbor"}});
  };
  const client=new LogServiceClient({url:"https://log.example.test",tokenIssuerKeyPem:issuer.export({type:"pkcs8",format:"pem"}).toString(),transportKeyPem:transport.export({type:"pkcs8",format:"pem"}).toString()},fetcher,()=>1_000_000);
  return {client,calls};
}
describe("CP nil registry wire consumer (signed mock peer, no native effects)",()=>{
  it("encodes explicit nulls/exact nil actor and losslessly pins generation/u64 rows",async()=>{
    const p=peer(page([row],uuidBytes(c),max));
    expect(await p.client.registryCollectionDeletions()).toEqual({generation:max,rows:[{collection:c,deletionId:d,lifecycleEpoch:max}],after:c,done:true});
    const params=p.calls[0]!.request.get(3) as Map<number,Decoded>;
    expect(params.size).toBe(3);expect(params.get(0)).toEqual(new Uint8Array(16));expect(params.get(1)).toBeNull();expect(params.get(2)).toBeNull();
    expect(p.calls[0]!.request.get(2)).toBe("registry_collection_deletions");expect(p.calls[0]!.init.redirect).toBe("manual");
    expect(Buffer.from(encodeCbor(null)).toString("hex")).toBe("f6");
  });
  it("uses the retained terminal cursor for the final same-generation empty check",async()=>{
    const p=peer(page([],uuidBytes(c),max));
    expect(await p.client.registryCollectionDeletions(c,max)).toEqual({generation:max,rows:[],after:c,done:true});
    const params=p.calls[0]!.request.get(3) as Map<number,Decoded>;expect(params.get(1)).toEqual(Uint8Array.from(uuidBytes(c)));expect(params.get(2)).toBe(max);
  });
  it("strictly matches typed record receipt and full-u64 request, not a bool acknowledgement",async()=>{
    const p=peer(map(1,uuidBytes(c),uuidBytes(d),max,max));
    expect(await p.client.recordCollectionDeletion({collection:c,deletionId:d,lifecycleEpoch:max})).toEqual({fact:{collection:c,deletionId:d,lifecycleEpoch:max},generation:max});
    const params=p.calls[0]!.request.get(3) as Map<number,Decoded>;expect(params.size).toBe(4);expect(params.get(0)).toEqual(new Uint8Array(16));expect(params.get(3)).toBe(max);
    expect(p.calls[0]!.request.get(2)).toBe("registry_record_collection_deletion");
    await expect(peer(map(true)).client.recordCollectionDeletion({collection:c,deletionId:d,lifecycleEpoch:1n})).rejects.toThrow();
    await expect(peer(map(1,uuidBytes(c),uuidBytes(d),1,max)).client.recordCollectionDeletion({collection:c,deletionId:d,lifecycleEpoch:max})).rejects.toThrow();
  });
  it("retains typed conflict details without treating them as successful matching receipt",async()=>{
    const details=map(1,uuidBytes(c),uuidBytes(d),max,9);
    const p=peer(request=>new Response(encodeCbor({struct:[[0,1],[1,request.get(1) as number],[3,{struct:[[0,"forbidden"],[1,"collection_deletion_conflict"],[4,details]]}]]}),{headers:{"content-type":"application/vnd.mdbase.v1+cbor"}}));
    await expect(p.client.recordCollectionDeletion({collection:c,deletionId:d,lifecycleEpoch:1n})).rejects.toMatchObject({code:"forbidden",reason:"collection_deletion_conflict",details:decodeCbor(encodeCbor(details))});
  });
  it.each([
    page([row,row],uuidBytes(c)), page([row],null), page([row],uuidBytes(c),0,false),
    page([[new Uint8Array(16),uuidBytes(d),1]],uuidBytes(c)), page([[uuidBytes(c),uuidBytes(d),0]],uuidBytes(c)),
    page([[uuidBytes(c),uuidBytes(d),1,1]],uuidBytes(c)), page(Array.from({length:129},()=>row),uuidBytes(c)),
    map(1,0,[],null,true,1), map(2,0,[],null,true), page([],null,-1), page([],null,0,1),
  ])("refuses malformed/order/duplicate/cursor/size/schema/epoch page %#",async result=>{
    await expect(peer(result).client.registryCollectionDeletions()).rejects.toThrow();
  });
  it("refuses mixed generation or nonadvancing keyset before any consumer union",async()=>{
    await expect(peer(page([],uuidBytes(c),8)).client.registryCollectionDeletions(c,7n)).rejects.toThrow();
    await expect(peer(page([row],uuidBytes(c),7)).client.registryCollectionDeletions(c,7n)).rejects.toThrow();
    const p=peer(page());await expect(p.client.registryCollectionDeletions(c)).rejects.toThrow("generation_required");expect(p.calls).toHaveLength(0);
  });
  it("matches the response request ID, including overlapping async requests",async()=>{
    const p=peer(request=>new Response(encodeCbor({struct:[[0,1],[1,(request.get(1) as number)+1],[2,page()]]}),{headers:{"content-type":"application/vnd.mdbase.v1+cbor"}}));
    await expect(p.client.registryCollectionDeletions()).rejects.toThrow();
    const good=peer(page());expect(await Promise.all([good.client.registryCollectionDeletions(),good.client.registryCollectionDeletions()])).toHaveLength(2);
  });
  it("cancels oversized streamed CBOR before decode/arrayBuffer and blocks redirect destinations",async()=>{
    let cancelled=false;
    const p=peer(()=>{
      const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(32768));controller.enqueue(Uint8Array.of(0));},cancel(){cancelled=true;}}));
      vi.spyOn(response,"arrayBuffer").mockImplementation(()=>{throw new Error("must stream");});return response;
    });
    await expect(p.client.registryCollectionDeletions()).rejects.toThrow("byte bound");expect(cancelled).toBe(true);
    const redirect=peer(()=>new Response(null,{status:302,headers:{location:"https://elsewhere.example.test"}}));
    await expect(redirect.client.registryCollectionDeletions()).rejects.toMatchObject({code:"unavailable",reason:"redirect"});expect(redirect.calls).toHaveLength(1);
  });
  it("does not impose the small-control limit/redirect policy on unrelated read responses",async()=>{
    const p=peer(map(1,new Uint8Array(65536)));expect((await p.client.head(c)).chain.length).toBe(65536);expect(p.calls[0]!.init.redirect).toBeUndefined();
  });
  it("rejects floating/noncanonical integers in canonical response mode",()=>{
    expect(()=>decodeCbor(Uint8Array.from([0xfb,0x3f,0xf0,0,0,0,0,0,0]),{canonicalStructs:true})).toThrow();
    expect(()=>decodeCbor(Uint8Array.of(0x18,0x01),{canonicalStructs:true})).toThrow();
    expect(decodeCbor(Uint8Array.from([0xfb,0x3f,0xf0,0,0,0,0,0,0]))).toBe(1);
  });
});
