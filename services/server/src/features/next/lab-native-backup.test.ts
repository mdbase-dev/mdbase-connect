import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { captureLabNativeCut } from "./lab-native-backup.js";
import { runLabNativeBackupAdmin } from "./lab-native-backup-admin.js";
import { decodeCbor, domainHash, encodeCbor, type Cbor, type Decoded, type PolicySigner } from "./policy-wire.js";
import type { LogServiceClient, NativeBackupFinish } from "./log-service-client.js";
import type { DatabasePool } from "../../database-types.js";

const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest();
const uuid = (value: Uint8Array) => {const hex = Buffer.from(value).toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;};
function fixture() {
  // Independent public TEST-ONLY Node/SDK golden already accepted by #719.
  // No runtime keys, operational cut, collection key or private user data.
  const vector = new Map(readFileSync(new URL("./fixtures/native-cut-ordinary-v1.txt", import.meta.url), "utf8").trim().split("\n").map(line => {
    const [name, hex] = line.split("="); return [name!, Buffer.from(hex!, "hex")] as const;
  }));
  const header = decodeCbor(vector.get("header")!) as Map<number, Decoded>;
  const pages = [...vector.entries()].filter(([name]) => /^page\d+$/.test(name)).map(([, value]) => value);
  const first = decodeCbor(pages[0]!) as Map<number, Decoded>;
  const genesis = ((first.get(7) as Decoded[][])[0]![2]) as Uint8Array;
  const finish = decodeCbor(vector.get("finish")!) as Map<number, Decoded>;
  const key = generateKeyPairSync("ed25519"), events: string[] = [];
  const signer: PolicySigner = {privateKey: key.privateKey, cert: {policyPublicKey: Buffer.alloc(32), notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER, root: Buffer.alloc(16), signature: Buffer.alloc(64)}};
  const objectMetadata = new Map<string, {size: number; checksum: Uint8Array}>();
  for (const raw of pages) {
    const page = decodeCbor(raw) as Map<number, Decoded>;
    if (page.get(6) === 4) for (const row of page.get(7) as Decoded[][]) objectMetadata.set(Buffer.from(row[1] as Uint8Array).toString("hex"), {size: row[3] as number, checksum: row[4] as Uint8Array});
  }
  const log = {
    backupBegin: vi.fn(async () => {events.push("begin"); return {raw: vector.get("header")!, hash: sha(vector.get("header")!)};}),
    backupPage: vi.fn(async (_collection: string, _session: Uint8Array, number: number) => {events.push(`page:${number}`); const raw = pages[number - 1]!; return {raw, hash: sha(raw)};}),
    nativeObjectRange: vi.fn(async (_collection: string, address: Uint8Array, offset: number, length: number) => {
      events.push("object"); const hex = Buffer.from(address).toString("hex"), raw = vector.get(`object_${hex}`)!;
      return {bytes: raw.subarray(offset, offset + length), ...objectMetadata.get(hex)!};
    }),
    backupFinish: vi.fn(async (): Promise<NativeBackupFinish> => {events.push("finish"); return {raw: vector.get("finish")!, collection: finish.get(1) as Uint8Array, session: finish.get(2) as Uint8Array,
      head: finish.get(3) as number, chain: finish.get(4) as Uint8Array, revision: finish.get(5) as number, pageCount: finish.get(6) as number, finalHash: finish.get(7) as Uint8Array};}),
  };
  const context = {collection: uuid(header.get(1) as Uint8Array), operationId: "11111111-1111-4111-8111-111111111111", sourceOrigin: "https://log-lab.example.test", runtimeRevision: "a".repeat(40),
    originalGenesis: genesis, signer, log: log as unknown as LogServiceClient, denyFirst: vi.fn(async () => {events.push("deny");})};
  return {vector, header, pages, log, context, events, key};
}

describe("observed LAB native completion", () => {
  it("computes719 inventory roots from independently generated complete pages and exact objects", async () => {
    const f = fixture(), cut = await captureLabNativeCut(f.context);
    const independent = decodeCbor(f.vector.get("completion")!) as Map<number, Decoded>;
    const actual = decodeCbor(cut.completion) as Map<number, Decoded>;
    expect(actual.size).toBe(13); expect(actual.get(0)).toBe("mdbase-native-backup-completion/1");
    expect(actual.get(2)).toBe("lab"); expect(Buffer.from(encodeCbor([...cut.plan]))).toEqual(Buffer.from(encodeCbor(independent.get(7) as Cbor)));
    for (const key of [3,4,5,6,7,8,9,11]) expect(actual.get(key)).toEqual(independent.get(key));
    expect(Buffer.from(actual.get(10) as Uint8Array)).toEqual(sha(cut.captureContext));
    expect(cut.pages).toEqual(f.pages); expect(cut.objects).toHaveLength(actual.get(8) as number);
    expect(f.events.filter(value => value === "finish")).toHaveLength(1);
    expect(f.events.indexOf("finish")).toBeGreaterThan(f.events.lastIndexOf("object"));
    for (let index = 0; index < f.events.length; index++) if (f.events[index] !== "deny") expect(f.events[index - 1]).toBe("deny");
    expect(f.events.at(-1)).toBe("deny");
  });
  it("same-key cross-purpose signatures refuse in BOTH directions", async () => {
    const f = fixture(), cut = await captureLabNativeCut(f.context), completion = decodeCbor(cut.completion) as Map<number, Cbor>;
    const unsigned = encodeCbor({struct: [...completion.entries()].filter(([key]) => key !== 12)});
    const signature = completion.get(12) as Uint8Array;
    expect(verify(null, domainHash("mdbase/v1/native-backup-completion", unsigned), f.key.publicKey, signature)).toBe(true);
    for (const domain of ["mdbase/v1/item-sig", "mdbase/v1/cp-cert", "mdbase/v1/ls-token"]) {
      expect(verify(null, domainHash(domain, unsigned), f.key.publicKey, signature)).toBe(false);
      const other = sign(null, domainHash(domain, unsigned), f.key.privateKey);
      expect(verify(null, domainHash("mdbase/v1/native-backup-completion", unsigned), f.key.publicKey, other)).toBe(false);
    }
  });
  it("refuses current CP denial before BEGIN with zero remote effects", async () => {
    const f = fixture(); f.context.denyFirst.mockRejectedValue(new Error("deleted"));
    await expect(captureLabNativeCut(f.context)).rejects.toThrow("deleted"); expect(f.events).toEqual([]); expect(f.log.backupBegin).not.toHaveBeenCalled();
  });
  it("refuses deletion during capture before FINISH/signature", async () => {
    const f = fixture(); let reads = 0;
    f.context.denyFirst.mockImplementation(async () => {if (++reads > 3) throw new Error("deleted");});
    await expect(captureLabNativeCut(f.context)).rejects.toThrow("deleted"); expect(f.log.backupFinish).not.toHaveBeenCalled();
  });
  it("does not retry UNKNOWN PAGE or issue an automatic abort", async () => {
    const f = fixture(); f.log.backupPage.mockRejectedValue(new Error("transport UNKNOWN"));
    await expect(captureLabNativeCut(f.context)).rejects.toThrow("UNKNOWN"); expect(f.log.backupPage).toHaveBeenCalledTimes(1); expect(f.log.backupFinish).not.toHaveBeenCalled();
  });
  it("refuses successful FINISH whose observed cut does not match", async () => {
    const f = fixture(), original = f.log.backupFinish.getMockImplementation()!;
    f.log.backupFinish.mockImplementation(async () => ({...await original(), head: 999}));
    await expect(captureLabNativeCut(f.context)).rejects.toThrow("refused"); expect(f.log.backupFinish).toHaveBeenCalledTimes(1);
  });
  it("refuses corrupt copied objects before the FIRST FINISH", async () => {
    const f = fixture(), original = f.log.nativeObjectRange.getMockImplementation()!;
    f.log.nativeObjectRange.mockImplementation(async (...argv) => {const value = await original(...argv); return {...value, bytes: Buffer.alloc(value.bytes.length)};});
    await expect(captureLabNativeCut(f.context)).rejects.toThrow("refused"); expect(f.log.backupFinish).not.toHaveBeenCalled();
  });
  it("refuses a foreign original genesis despite consistent source framing", async () => {
    const f = fixture(); f.context.originalGenesis = Buffer.of(1);
    await expect(captureLabNativeCut(f.context)).rejects.toThrow("refused"); expect(f.log.backupFinish).not.toHaveBeenCalled();
  });
  it("refuses missing explicit section terminal rather than signing incomplete capture", async () => {
    const f = fixture(); f.pages.splice(f.pages.length - 1);
    await expect(captureLabNativeCut(f.context)).rejects.toThrow(); expect(f.log.backupFinish).not.toHaveBeenCalled();
  });
});

describe("fixed LAB admin input admission", () => {
  const argv = ["capture", "--collection", "11111111-1111-4111-8111-111111111111", "--operation-id", "22222222-2222-4222-8222-222222222222",
    "--expected-revision", "a".repeat(40), "--expected-source-origin", "https://log-lab.example.test", "--actor", "test-operator", "--reason", "isolated test"];
  const context = () => ({db: {} as DatabasePool, environment: "lab", publicUrl: "https://connect-lab.mdbase.dev", runtimeRevision: "a".repeat(40), nextControlPlane: vi.fn(() => null)});
  it.each(["production", "staging", "", undefined])("refuses environment %s BEFORE config/key/DB work", async environment => {
    const c = {...context(), environment}; await expect(runLabNativeBackupAdmin(argv, c)).rejects.toThrow("refused"); expect(c.nextControlPlane).not.toHaveBeenCalled();
  });
  it.each(["https://connect.mdbase.dev", "https://connect-lab.mdbase.dev/", "http://connect-lab.mdbase.dev"]) ("refuses CP origin %s", async publicUrl => {
    const c = {...context(), publicUrl}; await expect(runLabNativeBackupAdmin(argv, c)).rejects.toThrow("refused"); expect(c.nextControlPlane).not.toHaveBeenCalled();
  });
  it.each(["sign", "rpc", "restore", "resume", "abort"]) ("does not expose %s authority", async action => {
    const c = context(); await expect(runLabNativeBackupAdmin([action, ...argv.slice(1)], c)).rejects.toThrow("refused"); expect(c.nextControlPlane).not.toHaveBeenCalled();
  });
  it.each(["signing-bytes", "digest", "signer", "target-origin", "method", "trust"]) ("rejects caller flag %s BEFORE config loading", async flag => {
    const c = context(); await expect(runLabNativeBackupAdmin([...argv, `--${flag}`, "bad"], c)).rejects.toThrow("refused"); expect(c.nextControlPlane).not.toHaveBeenCalled();
  });
  it("refuses a mismatched qualified runtime revision", async () => {
    const c = {...context(), runtimeRevision: "b".repeat(40)}; await expect(runLabNativeBackupAdmin(argv, c)).rejects.toThrow("refused"); expect(c.nextControlPlane).not.toHaveBeenCalled();
  });
});
