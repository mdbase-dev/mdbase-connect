import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../../database-types.js";
import { nativeDevices, nativeGrantStanding } from "../next/native-grant-target.js";
import { createNativeApprovalDelivery } from "./native-approval-delivery.js";

vi.mock("../next/native-grant-target.js", () => ({nativeDevices:vi.fn(),nativeGrantStanding:vi.fn()}));
const collection="11111111-1111-4111-a111-111111111111", account="22222222-2222-4222-a222-222222222222";
const grant="33333333-3333-4333-a333-333333333333";
function fixture() {
  const db={query:vi.fn(async()=>({rows:[{collection,account}]}))} as unknown as DatabaseQueryable;
  const relay={pushPolicy:vi.fn(async()=>{})}, onDeferred=vi.fn();
  return {db,relay,onDeferred};
}
beforeEach(()=>{
  vi.resetAllMocks();
  vi.mocked(nativeGrantStanding).mockResolvedValue("current");
  vi.mocked(nativeDevices).mockResolvedValue([{device_id:grant,kind:"desktop",noise_pk:Buffer.alloc(32),connector_id:"original-computer",relay_generation:"1",last_active_ms:null,update_required:false}]);
});
afterEach(()=>vi.useRealTimers());

describe("committed Native log publication barrier",()=>{
  it("publishes original policy before selecting and pushing the current enrolled audience",async()=>{
    const f=fixture();let release!:()=>void;
    const original=new Promise<void>(resolve=>{release=resolve;});
    const publication={publishCommitted:vi.fn(()=>original)};
    const pending=createNativeApprovalDelivery(f.db,f.relay,f.onDeferred,publication).grant(grant);
    await vi.waitFor(()=>expect(publication.publishCommitted).toHaveBeenCalledWith(collection));
    expect(nativeDevices).not.toHaveBeenCalled();expect(f.relay.pushPolicy).not.toHaveBeenCalled();
    release();await pending;
    expect(f.relay.pushPolicy).toHaveBeenCalledExactlyOnceWith("original-computer");
    expect(f.onDeferred).not.toHaveBeenCalled();
  });
  it("bounds only the courtesy wait, preserves the original owned publication and does not reissue it",async()=>{
    vi.useFakeTimers();const f=fixture();let release!:()=>void;
    const original=new Promise<void>(resolve=>{release=resolve;});
    const publication={publishCommitted:vi.fn(()=>original)};
    const pending=createNativeApprovalDelivery(f.db,f.relay,f.onDeferred,publication).grant(grant);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(f.relay.pushPolicy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);await pending;
    expect(f.onDeferred).toHaveBeenCalledTimes(1);
    expect(f.relay.pushPolicy).toHaveBeenCalledTimes(1);
    expect(publication.publishCommitted).toHaveBeenCalledTimes(1);
    release();await original;
    expect(publication.publishCommitted).toHaveBeenCalledTimes(1);
  });
  it("keeps log publication failure nonfatal without changing the original grant or credentials",async()=>{
    const f=fixture();const publication={publishCommitted:vi.fn(async()=>{throw new Error("unavailable");})};
    await createNativeApprovalDelivery(f.db,f.relay,f.onDeferred,publication).grant(grant);
    expect(f.onDeferred).toHaveBeenCalledTimes(1);expect(f.relay.pushPolicy).toHaveBeenCalledTimes(1);
    expect(f.db.query).toHaveBeenCalledTimes(1);
    expect(f.db.query).toHaveBeenCalledWith(expect.stringContaining("g.revoked_at IS NULL"),[grant]);
  });
  it("does not publish or push a grant whose original collection/account standing changed",async()=>{
    const f=fixture();vi.mocked(nativeGrantStanding).mockResolvedValue("access_removed");
    const publication={publishCommitted:vi.fn(async()=>{})};
    await createNativeApprovalDelivery(f.db,f.relay,f.onDeferred,publication).grant(grant);
    expect(publication.publishCommitted).not.toHaveBeenCalled();expect(f.relay.pushPolicy).not.toHaveBeenCalled();
  });
});
