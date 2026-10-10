import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LogServiceClient, type NativeRestorePlan } from "./log-service-client.js";
import { decodeCbor, domainHash, encodeCbor, uuidBytes, type Cbor, type Decoded } from "./policy-wire.js";
const collection = "11111111-1111-4111-8111-111111111111", session = Buffer.alloc(16, 2), digest = Buffer.alloc(32, 3);
const sha = (raw: Uint8Array | string) => createHash("sha256").update(raw).digest();
const map = (values: Cbor[]): Cbor => ({struct: values.map((value, key) => [key, value])});
const plan: NativeRestorePlan = [1, 10, 1, digest, 1, digest, digest, digest];
function fixture(reply: (method: string, params: Map<number, Decoded>) => Cbor = () => map([true])) {
  const issuer = generateKeyPairSync("ed25519"), transport = generateKeyPairSync("ed25519"), nonce = Buffer.alloc(32, 7);
  const calls: Array<{method: string; params: Map<number, Decoded>}> = [];
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    expect(init?.redirect).toBe("manual");
    if (init?.method === "GET") return new Response(nonce.toString("hex"));
    const raw = Buffer.from(init!.body as Uint8Array), frame = decodeCbor(raw) as Map<number, Decoded>, headers = new Headers(init!.headers);
    const method = frame.get(2) as string, params = frame.get(3) as Map<number, Decoded>, token = headers.get("authorization")!.slice(7);
    const [claims, signature] = token.split(".");
    expect(verify(null, domainHash("mdbase/v1/ls-token", Buffer.from(claims!, "hex")), issuer.publicKey, Buffer.from(signature!, "hex"))).toBe(true);
    const parsed = decodeCbor(Buffer.from(claims!, "hex")) as Map<number, Decoded>;
    expect(parsed.get(0)).toBe(1); expect(parsed.has(1)).toBe(false);
    const transcript = Buffer.concat([Buffer.from(method), Buffer.of(0), Buffer.from("/v1/rpc"), Buffer.of(0), params.get(0) as Uint8Array, sha(token), sha(raw), nonce]);
    expect(verify(null, domainHash("mdbase/v1/ls-http", transcript), transport.publicKey, Buffer.from(headers.get("x-mdbase-sig")!, "hex"))).toBe(true);
    calls.push({method, params});
    return new Response(encodeCbor(map([1, frame.get(1) as number, reply(method, params)])), {headers: {"content-type": "application/vnd.mdbase.v1+cbor"}});
  });
  const client = new LogServiceClient({url: "https://log-lab.example.test", tokenIssuerKeyPem: issuer.privateKey.export({format: "pem", type: "pkcs8"}).toString(), transportKeyPem: transport.privateKey.export({format: "pem", type: "pkcs8"}).toString()}, fetcher);
  return {client, calls, fetcher};
}

describe("bounded typed native CP transport", () => {
  it("backup BEGIN/PAGE carries original canonical bytes with exact SHA and role1 PoP", async () => {
    const raw = encodeCbor(map([1]));
    const f = fixture(() => map([raw, sha(raw)]));
    expect(Buffer.from((await f.client.backupBegin(collection)).raw)).toEqual(Buffer.from(raw));
    await f.client.backupPage(collection, session, 1, digest);
    expect(f.calls.map(call => call.method)).toEqual(["backup_begin", "backup_page"]);
    expect(f.calls[1]!.params.get(2)).toBe(1); expect(Buffer.from(f.calls[1]!.params.get(3) as Uint8Array)).toEqual(digest);
  });
  it("FINISH checks exact original UUID/session/final hash and retains canonical observation", async () => {
    const result = map([1, uuidBytes(collection), session, 10, digest, 4, 6, digest]);
    const f = fixture(() => result), finish = await f.client.backupFinish(collection, session, digest);
    expect(Buffer.from(finish.raw)).toEqual(Buffer.from(encodeCbor(result))); expect(finish.pageCount).toBe(6);
  });
  it.each([1, 2, 7])("rejects substituted FINISH field %s", async key => {
    const values: Cbor[] = [1, uuidBytes(collection), session, 10, digest, 4, 6, digest]; values[key] = Buffer.alloc(key === 7 ? 32 : 16, 9);
    const f = fixture(() => map(values)); await expect(f.client.backupFinish(collection, session, digest)).rejects.toThrow("binding");
  });
  it("bounded range reads never expose or follow a signed object URL", async () => {
    const raw = Buffer.alloc(64, 5), f = fixture(() => ({struct: [[0, raw], [2, 256], [3, digest]]}));
    const object = await f.client.nativeObjectRange(collection, digest, 64, 64);
    expect(object.size).toBe(256); expect(Buffer.from(object.bytes)).toEqual(raw); expect(f.calls[0]!.params.get(2)).toEqual([64,64]);
  });
  it("strict item import sends original settings/plan and rejects non-strict target replies", async () => {
    const f = fixture(() => map([1, digest, false, true]));
    await f.client.importNativeItems(collection, {items: [[1, Buffer.of(1)]], settings: [1,[100,2,3,4],30,1], plan});
    const params = f.calls[0]!.params;
    expect(params.get(3)).toEqual([1,[100,2,3,4],30,1]); expect(params.get(4)).toEqual(decodeCbor(encodeCbor([...plan])));
    const bad = fixture(() => map([1,digest,false,false]));
    await expect(bad.client.importNativeItems(collection, {items: []})).rejects.toThrow("strict_import");
  });
  it("snapshot import uses the existing struct-map pointer, not an invented tuple wire ABI", async () => {
    const f = fixture(); await f.client.importNativeSnapshot(collection, [1,digest,session,20,true], [digest]);
    const pointer = f.calls[0]!.params.get(1) as Map<number, Decoded>;
    expect(pointer).toBeInstanceOf(Map); expect([...pointer.keys()]).toEqual([0,1,2,3,4]); expect(pointer.get(4)).toBe(true);
  });
  it("object import, abort and aux use fixed method names and bounded positive acknowledgements", async () => {
    const f = fixture(method => method.startsWith("restore_aux") ? map([true,0,digest]) : map([true]));
    await f.client.importNativeObject(collection, digest, 18, Buffer.of(1)); await f.client.backupAbort(collection, session);
    await f.client.restoreAuxBegin(collection, Buffer.of(1), digest, 6); await f.client.restoreAuxPage(collection, Buffer.of(1));
    expect(f.calls.map(call => call.method)).toEqual(["import_object","backup_abort","restore_aux_begin","restore_aux_page"]);
  });
  it("refuses nil/wrong UUID, foreign byte lengths and overflow BEFORE RPC", async () => {
    const f = fixture();
    await expect(f.client.backupBegin("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
    await expect(f.client.backupPage(collection, Buffer.alloc(15), 1, digest)).rejects.toThrow();
    await expect(f.client.backupPage(collection, session, 65_537, digest)).rejects.toThrow();
    await expect(f.client.nativeObjectRange(collection, digest, 0, 1024 * 1024 + 1)).rejects.toThrow();
    await expect(f.client.importNativeItems(collection, {items: [], plan})).rejects.toThrow("settings_required");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects transport UNKNOWN without automatically retrying nonce/RPC", async () => {
    const f = fixture(); f.fetcher.mockRejectedValueOnce(new Error("UNKNOWN"));
    await expect(f.client.backupBegin(collection)).rejects.toThrow("UNKNOWN"); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects redirect rather than transporting CP authority elsewhere", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response(null, {status:302,headers:{location:"https://other.example.test"}}));
    await expect(f.client.backupBegin(collection)).rejects.toMatchObject({reason:"redirect"}); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed or mismatched request identity frames", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response("07".repeat(32))).mockResolvedValueOnce(new Response(encodeCbor(map([1,999,map([true])]))));
    await expect(f.client.backupAbort(collection, session)).rejects.toMatchObject({reason:"native_backup_frame"}); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects corruption in observed page hash", async () => {
    const f = fixture(() => map([Buffer.of(1),digest])); await expect(f.client.backupBegin(collection)).rejects.toThrow("frame_hash");
  });
});
