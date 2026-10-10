import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { decode, encode, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { AppWebPrivateBootstrapPersistence, APP_PRIVATE_BOOTSTRAP_CIPHER_MAX, type AppPrivateBootstrapProtectedStore } from "../src/app-host/private-persistence.js";
import type { AppCpPrivateSession, AppPrivateBootstrapMetadata } from "../src/app-host/private-bootstrap.js";
import type { AppPrivateEnrolOperationMarker } from "../src/app-host/wasm-runtime.js";
async function fixture(purpose: "create" | "enrol" = "create", displayName?: string) {
  let current = true, value: Uint8Array | null = null, throwAfter = false;
  const source: AppCpPrivateSession = { accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", connectorId: "66666666-6666-6666-6666-666666666666", deviceId: "44444444-4444-4444-4444-444444444444", installationId: "88888888-8888-8888-8888-888888888888", collection: "22222222-2222-2222-2222-222222222222", purpose, approvalMode: "password-ak1", cpOrigin: "https://cp.example", logOrigin: "https://log.example", rootPublicKey: new Uint8Array(32).fill(9), isCurrent: () => current, connectorBearer: async () => "unused" };
  const receipt = { connectorId: source.connectorId, deviceId: source.deviceId, installationId: source.installationId, signPublicKey: new Uint8Array(32).fill(1), kemPublicKey: new Uint8Array(32).fill(2), noisePublicKey: new Uint8Array(32).fill(3) };
  const marker: AppPrivateEnrolOperationMarker = { ...receipt, collection: source.collection, sasCommitment: new Uint8Array(32).fill(11), acknowledged: false };
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const store: AppPrivateBootstrapProtectedStore = {
    read: vi.fn(async () => value === null ? null : new Uint8Array(value)),
    compareAndSet: vi.fn(async (expected, encrypted) => {
      if (expected === null ? value !== null : value === null || !Buffer.from(expected).equals(Buffer.from(value))) return false;
      value = new Uint8Array(encrypted); if (throwAfter) throw new Error("uncertain committed IO"); return true;
    }),
  };
  const noise = { privateEnrolPending: vi.fn(async (_marker: AppPrivateEnrolOperationMarker, _options: { signal: AbortSignal }) => {}), privateEnrolAcknowledged: vi.fn(async (_marker: AppPrivateEnrolOperationMarker, _options: { signal: AbortSignal }) => {}) };
  const domain = Buffer.from("mdbase/v1/chain"), item = Uint8Array.of(1);
  const metadata: AppPrivateBootstrapMetadata = { collection: source.collection, deviceId: source.deviceId, logOrigin: source.logOrigin, rootPublicKey: new Uint8Array(source.rootPublicKey), genesisItem: item, expectedGenesis: `sha256:${createHash("sha256").update(Uint8Array.of(domain.length)).update(domain).update(item).digest("hex")}`, approval: purpose === "create" ? "creator" : "pending", ...(displayName === undefined ? {} : {displayName}) };
  const signal = new AbortController().signal;
  const open = (name = displayName) => new AppWebPrivateBootstrapPersistence(source, receipt, key, store, noise, {...(name === undefined ? {} : {displayName: name})});
  return { source, receipt, marker, key, store, noise, metadata, signal, open, get: () => value, replace: (next: Uint8Array) => { value = next; }, uncertain: () => { throwAfter = true; }, fence: () => { current = false; } };
}
describe("fixed public private-bootstrap custody (real AEAD; memory IO does not qualify platform persistence)", () => {
  it("private create preserves explicit cleartext label without changing keys/tuple or allowing changed-name retries", async () => {
    const f = await fixture("create", "Research"), p = f.open();
    await p.pendingCreate({...f.receipt, collection: f.source.collection, displayName: "Research"}, {signal: f.signal});
    const original = new Uint8Array(f.get()!);
    await expect(f.open("Other").pendingCreate({...f.receipt, collection: f.source.collection, displayName: "Other"}, {signal: f.signal})).rejects.toThrow();
    await expect(new AppWebPrivateBootstrapPersistence(f.source, f.receipt, f.key, f.store, f.noise).restoredCompletion({signal: f.signal})).rejects.toThrow();
    expect(f.get()).toEqual(original); expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
    await p.completed(f.metadata, {signal: f.signal});
    expect(await f.open().restoredCompletion({signal: f.signal})).toEqual(f.metadata);
    expect(f.noise.privateEnrolPending).not.toHaveBeenCalled();
  });
  it("reads legacy v1 omitted-name create outcome without rewriting or accepting a supplied default", async () => {
    const f = await fixture(); await f.open().pendingCreate({...f.receipt, collection: f.source.collection}, {signal: f.signal});
    const aad = encode(["mdbase/v1/app-private-bootstrap-platform", ...[f.source.accountId, f.source.connectorId, f.source.deviceId, f.source.installationId, f.source.collection].map(uuidToBytes), f.source.purpose, f.source.cpOrigin, f.source.logOrigin, f.source.rootPublicKey]);
    const outer = decode(f.get()!) as Map<number,CborValue>, iv = new Uint8Array(outer.get(1) as Uint8Array);
    const plain = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv, additionalData: new Uint8Array(aad)}, f.key, new Uint8Array(outer.get(2) as Uint8Array)));
    const record = decode(plain) as Map<number,CborValue>; record.set(0, 1); record.delete(4);
    const body = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: new Uint8Array(aad)}, f.key, new Uint8Array(encode(record))));
    f.replace(encode(new Map<number,CborValue>([[0, 1], [1, iv], [2, body]]))); plain.fill(0);
    const legacy = new Uint8Array(f.get()!);
    expect(await f.open().restoredCompletion({signal: f.signal})).toBeNull();
    await expect(f.open("New collection").restoredCompletion({signal: f.signal})).rejects.toThrow();
    expect(f.get()).toEqual(legacy); expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
  });
  it("private omitted label cannot become an explicit default and enrol never accepts an initial label", async () => {
    const f = await fixture(); await f.open().pendingCreate({...f.receipt, collection: f.source.collection}, {signal: f.signal});
    await expect(f.open("New collection").restoredCompletion({signal: f.signal})).rejects.toThrow();
    const enrol = await fixture("enrol"); expect(() => enrol.open("Research")).toThrow();
  });
  it("protects immutable create tuple before POST and completion without tokens/secrets", async () => {
    const f = await fixture(), p = f.open();
    expect(await p.restoredCompletion({ signal: f.signal })).toBeNull();
    await p.pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal });
    await p.pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal });
    expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
    await p.completed(f.metadata, { signal: f.signal });
    const restored = await f.open().restoredCompletion({ signal: f.signal });
    expect(restored).toEqual(f.metadata); expect(restored!.genesisItem).not.toBe(f.metadata.genesisItem);
    restored!.genesisItem.fill(0); expect(await f.open().restoredCompletion({ signal: f.signal })).toEqual(f.metadata);
    expect(Buffer.from(f.get()!).includes(Buffer.from(f.receipt.signPublicKey))).toBe(false);
    expect(f.noise.privateEnrolPending).not.toHaveBeenCalled();
  });
  it("lost applied completion preserves known create outcome for reopen, not another write", async () => {
    const f = await fixture(), p = f.open(); await p.pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal }); f.uncertain();
    await expect(p.completed(f.metadata, { signal: f.signal })).rejects.toThrow(/preserve storage/);
    expect(await f.open().restoredCompletion({ signal: f.signal })).toEqual(f.metadata);
    await f.open().completed(f.metadata, { signal: f.signal }); expect(f.store.compareAndSet).toHaveBeenCalledTimes(2);
  });
  it("exact enrol commit protected before POST; completion before Noise ACK and ACK-loss repair", async () => {
    const f = await fixture("enrol"), p = f.open(); await p.privateEnrolPending(f.marker, { signal: f.signal });
    await expect(p.privateEnrolAcknowledged(f.marker, { signal: f.signal })).rejects.toThrow(); expect(f.noise.privateEnrolAcknowledged).not.toHaveBeenCalled();
    await p.completed(f.metadata, { signal: f.signal });
    f.noise.privateEnrolAcknowledged.mockImplementationOnce(async () => { throw new Error("ACK committed then lost"); });
    await expect(p.privateEnrolAcknowledged(f.marker, { signal: f.signal })).rejects.toThrow();
    expect(await f.open().restoredCompletion({ signal: f.signal })).toEqual(f.metadata);
    await f.open().privateEnrolAcknowledged(f.marker, { signal: f.signal }); expect(f.noise.privateEnrolAcknowledged).toHaveBeenCalledTimes(2);
    const foreign = { ...f.marker, sasCommitment: new Uint8Array(32).fill(12) };
    await expect(p.privateEnrolPending(foreign, { signal: f.signal })).rejects.toThrow(); expect(f.noise.privateEnrolPending).toHaveBeenCalledTimes(1);
  });
  it("cannot complete without pending or overwrite another genesis", async () => {
    const f = await fixture(), p = f.open(); await expect(p.completed(f.metadata, { signal: f.signal })).rejects.toThrow();
    await p.pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal }); await p.completed(f.metadata, { signal: f.signal });
    await expect(p.completed({ ...f.metadata, expectedGenesis: `sha256:${"11".repeat(32)}` }, { signal: f.signal })).rejects.toThrow();
    expect(await p.restoredCompletion({ signal: f.signal })).toEqual(f.metadata);
  });
  it("copies callback inputs before await", async () => {
    const f = await fixture(), p = f.open(); await p.pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal });
    const expected = { ...f.metadata, genesisItem: new Uint8Array(f.metadata.genesisItem) };
    const promise = p.completed(f.metadata, { signal: f.signal }); f.metadata.genesisItem.fill(0); await promise;
    expect(await p.restoredCompletion({ signal: f.signal })).toEqual(expected);
  });
  it.each(["accountId", "collection", "purpose", "cpOrigin", "root"])("foreign %s ciphertext cannot rebind on reopen", async field => {
    const f = await fixture(); await f.open().pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal });
    const foreign = { ...f.source, ...(field === "root" ? { rootPublicKey: new Uint8Array(32).fill(8) } : { [field]: field === "purpose" ? "enrol" : field === "cpOrigin" ? "https://foreign.example" : "33333333-3333-3333-3333-333333333333" }) } as AppCpPrivateSession;
    await expect(new AppWebPrivateBootstrapPersistence(foreign, f.receipt, f.key, f.store, f.noise).restoredCompletion({ signal: f.signal })).rejects.toThrow();
  });
  it("corrupt/oversized custody refuses, never replaces/deletes", async () => {
    const f = await fixture(); f.replace(new Uint8Array(APP_PRIVATE_BOOTSTRAP_CIPHER_MAX + 1));
    await expect(f.open().restoredCompletion({ signal: f.signal })).rejects.toThrow(); expect(f.store.compareAndSet).not.toHaveBeenCalled();
    f.replace(Uint8Array.of(1)); await expect(f.open().pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal })).rejects.toThrow(); expect(f.store.compareAndSet).not.toHaveBeenCalled();
  });
  it("every storage await rechecks original owner", async () => {
    const f = await fixture(); vi.mocked(f.store.read).mockImplementationOnce(async () => { f.fence(); return null; });
    await expect(f.open().pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal })).rejects.toThrow(); expect(f.store.compareAndSet).not.toHaveBeenCalled();
  });
  it("ACK pins are copied before storage awaits; extra caller fields never forward", async () => {
    const f = await fixture("enrol"), p = f.open(); await p.privateEnrolPending(f.marker, { signal: f.signal }); await p.completed(f.metadata, { signal: f.signal });
    const collection = f.source.collection; Object.assign(f.marker, { unexpected: "must-not-forward" });
    vi.mocked(f.store.read).mockImplementationOnce(async () => { f.marker.noisePublicKey.fill(0); Object.assign(f.marker, { collection: "33333333-3333-3333-3333-333333333333" }); return new Uint8Array(f.get()!); });
    await p.privateEnrolAcknowledged(f.marker, { signal: f.signal });
    const forwarded = vi.mocked(f.noise.privateEnrolAcknowledged).mock.calls[0]![0] as unknown as AppPrivateEnrolOperationMarker;
    expect(forwarded.collection).toBe(collection); expect(forwarded.noisePublicKey.every(v => v === 3)).toBe(true); expect(forwarded).not.toHaveProperty("unexpected");
  });
  it("loopback fixture HTTP is explicit and cannot enable arbitrary insecure origins", async () => {
    const f = await fixture(); Object.assign(f.source, { cpOrigin: "http://127.0.0.1:42000", logOrigin: "http://localhost:43000" });
    expect(() => f.open()).toThrow();
    const allowed = new AppWebPrivateBootstrapPersistence(f.source, f.receipt, f.key, f.store, f.noise, { allowLoopbackHttp: true });
    expect(await allowed.restoredCompletion({ signal: f.signal })).toBeNull();
    Object.assign(f.source, { cpOrigin: "http://foreign.example" });
    expect(() => new AppWebPrivateBootstrapPersistence(f.source, f.receipt, f.key, f.store, f.noise, { allowLoopbackHttp: true })).toThrow();
  });
  it("atomic CAS conflict preserves winning encrypted record", async () => {
    const f = await fixture(), p = f.open(); vi.mocked(f.store.compareAndSet).mockResolvedValueOnce(false);
    await expect(p.pendingCreate({ ...f.receipt, collection: f.source.collection }, { signal: f.signal })).rejects.toThrow(); expect(f.store.compareAndSet).toHaveBeenCalledTimes(1);
  });
});
