import { describe, expect, it, vi } from "vitest";
import { verifyAppHandover, type AppHandoverOptions } from "../src/app-host/handover.js";
const C = "22222222-2222-2222-2222-222222222222", D = "44444444-4444-4444-4444-444444444444";
const head = { seq: 5, chain: `sha256:${"01".repeat(32)}`, policyGeneration: `sha256:${"02".repeat(32)}`, catalogGeneration: `sha256:${"03".repeat(32)}` };
function fixture() {
  let current = true;
  const hosted = { collection: C, status: { confirmedHead: { ...head } }, headWitness: new Uint8Array([1, 2, 3]) }, local = { collection: C };
  const runtime = { observations: vi.fn(() => ({ requiresReopen: false, keyringRebuilding: false, keyringRebuildFailed: false, status: { mode: "synced", confirmedHead: { ...head, seq: 9, policyGeneration: "sha256:newer" } } })), verifyHandover: vi.fn(() => ({ ...head })) };
  const localClient = { hello: local, appliedPrefix: vi.fn(async () => ({ seq: 5, appliedThrough: 9, chain: head.chain })) }, hostedClient = { hello: hosted, authenticatedDevice: D };
  const source = { collection: C, deviceId: D, isCurrent: () => current };
  const options = { runtime, localPort: {}, localClient, hostedClient, source, isCurrent: () => current } as unknown as AppHandoverOptions;
  const controller = new AbortController();
  return { options, runtime, localClient, hostedClient, source, controller, stale: () => { current = false; } };
}
describe("verified app handover candidate", () => {
  it("requires native verified policy and exact retained historical prefix when local is ahead", async () => {
    const f = fixture(), evidence = await verifyAppHandover(f.options, f.controller.signal);
    expect(evidence?.head).toEqual(head); expect(evidence?.appliedThrough).toBe(9); expect(evidence?.isCurrent()).toBe(true); expect(Object.isFrozen(evidence?.head)).toBe(true);
    expect(f.localClient.appliedPrefix).toHaveBeenCalledWith(5, f.controller.signal); evidence?.dispose(); expect(evidence?.isCurrent()).toBe(false);
  });
  it("copies aliased Buffer/subclass witnesses independently; failures and evidence disposal never wipe caller bytes", async () => {
    const f = fixture(), borrowed = Buffer.from([1, 2, 3]); f.hostedClient.hello.headWitness = borrowed;
    const evidence = await verifyAppHandover(f.options, f.controller.signal); expect(evidence).not.toBeNull(); evidence?.dispose(); expect([...borrowed]).toEqual([1, 2, 3]);
    f.runtime.verifyHandover.mockReturnValue(null as never); expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull(); expect([...borrowed]).toEqual([1, 2, 3]);
  });
  it("absent/foreign transport-authenticated device never trusts witness/hello self-claims", async () => {
    const f = fixture(); Object.assign(f.hostedClient, { authenticatedDevice: undefined }); expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull(); expect(f.runtime.verifyHandover).not.toHaveBeenCalled();
    Object.assign(f.hostedClient, { authenticatedDevice: C }); expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull(); expect(f.localClient.appliedPrefix).not.toHaveBeenCalled();
  });
  it("missing native signature/policy authority never falls back to decoded witness or roots", async () => {
    const f = fixture(); f.runtime.verifyHandover.mockReturnValue(null as never);
    expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull(); expect(f.localClient.appliedPrefix).not.toHaveBeenCalled();
  });
  it.each(["keyringRebuilding", "keyringRebuildFailed", "requiresReopen"] as const)("%s never qualifies even if pending is zero", async flag => {
    const f = fixture(), initial = f.runtime.observations(); f.runtime.observations.mockReturnValue({ ...initial, [flag]: true });
    expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull(); expect(f.localClient.appliedPrefix).not.toHaveBeenCalled();
  });
  it.each([{ seq: 5, appliedThrough: 4, chain: head.chain }, { seq: 4, appliedThrough: 9, chain: head.chain }, { seq: 5, appliedThrough: 9, chain: "sha256:wrong" }])("bad/behind historical prefix stays hosted", async prefix => {
    const f = fixture(); f.localClient.appliedPrefix.mockResolvedValue(prefix); expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull();
  });
  it("fences stale account/collection/owner across await and wipes copied witness", async () => {
    const f = fixture(); let copied!: Uint8Array; f.runtime.verifyHandover.mockImplementation((_p?: unknown, _s?: unknown, b?: Uint8Array) => { copied = b!; return { ...head }; });
    f.localClient.appliedPrefix.mockImplementation(async () => { f.stale(); return { seq: 5, appliedThrough: 9, chain: head.chain }; });
    expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull(); expect(copied.every(b => b === 0)).toBe(true);
  });
  it("reconnected hosted session across await never qualifies captured old candidate", async () => {
    const f = fixture(); f.localClient.appliedPrefix.mockImplementation(async () => { f.hostedClient.hello = { ...f.hostedClient.hello }; return { seq: 5, appliedThrough: 9, chain: head.chain }; });
    expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull();
  });
  it("signature/chain/current native readiness are revalidated after promotion; no online condition", async () => {
    const f = fixture(), evidence = await verifyAppHandover(f.options, f.controller.signal); expect(evidence?.isCurrent()).toBe(true);
    // Hosted connectivity is not a dependency after the captured proof is verified.
    Object.defineProperty(f.hostedClient, "hello", { get: () => { throw Error("offline"); } }); expect(evidence?.isCurrent()).toBe(true);
    f.runtime.verifyHandover.mockReturnValue(null as never); expect(evidence?.isCurrent()).toBe(false); evidence?.dispose();
  });
  it("aborted candidate and changed local session remain unavailable", async () => {
    const f = fixture(); f.controller.abort(); expect(await verifyAppHandover(f.options, f.controller.signal)).toBeNull(); expect(f.localClient.appliedPrefix).not.toHaveBeenCalled();
    const g = fixture(), evidence = await verifyAppHandover(g.options, g.controller.signal); g.localClient.hello = { ...g.localClient.hello }; expect(evidence?.isCurrent()).toBe(false); evidence?.dispose();
  });
});
