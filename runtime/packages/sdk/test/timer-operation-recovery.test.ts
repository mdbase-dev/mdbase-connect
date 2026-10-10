import { describe, expect, it, vi } from "vitest";
import { TimersApi, type AppTimersPort } from "../src/timers.js";
const id = "0192f3a4-6000-7abc-8def-0123456789ab", date = "2026-10-06T00:00:00.000Z";
const input = () => ({ namespace: "tasks", operationId: id, expectedRevision: 4, criterionId: "task.fire", timers: [{ id: "task:one", fireAt: date }] });
const row = () => ({ id: "task:one", criterion_id: "task.fire", fire_at: date, generation: 3, status: "fired", created_at: date, updated_at: date, fired_at: date });
const receipt = () => ({ protocol_version: 1, operation_id: id, namespace: "tasks", expected_revision: 4, committed_revision: 5,
  result: { namespace: "tasks", timers: [row()], cancelled_ids: ["task:old"] } });
function fixture() {
  const port = { reconcileWithReceipt: vi.fn(async () => receipt()), lookupOperation: vi.fn(async () => ({ outcome: "committed", receipt: receipt() })),
    list: vi.fn(async () => ({ namespace: "tasks", timers: [], intent_revision: 4 })) };
  return { port, api: new TimersApi(port as unknown as AppTimersPort) };
}
describe("original-operation timer recovery", () => {
  it("returns actual list revisions and leaves absent revisions unknown", async () => {
    const f = fixture(); expect((await f.api.list("tasks")).intentRevision).toBe(4);
    vi.mocked(f.port.list).mockResolvedValue({ namespace: "tasks", timers: [] } as never);
    expect((await f.api.list("tasks")).intentRevision).toBeUndefined();
    vi.mocked(f.port.list).mockResolvedValue({ namespace: "tasks", timers: [], intent_revision: Number.MAX_SAFE_INTEGER + 1 });
    await expect(f.api.list("tasks")).rejects.toMatchObject({ reason: "invalid_timer_response" });
  });
  it("dispatches the caller's original identity once and does not re-arm fired metadata", async () => {
    const f = fixture(), original = input(), pending = f.api.reconcileWithReceipt(original);
    original.operationId = "0192f3a4-6000-7abc-8def-0123456789ac"; original.expectedRevision = 9; original.timers[0]!.id = "other";
    const r = await pending; expect(r.operationId).toBe(id); expect(r.committedRevision).toBe(5); expect(r.result.timers[0]!.status).toBe("fired");
    expect(f.port.reconcileWithReceipt).toHaveBeenCalledOnce();
    expect(f.port.reconcileWithReceipt).toHaveBeenCalledWith("tasks", { criterion_id: "task.fire", timers: [{ id: "task:one", fire_at: date }],
      recovery: { protocol_version: 1, operation_id: id, expected_revision: 4 } }, { signal: expect.any(AbortSignal) });
  });
  it.each(["operation_id", "namespace", "expected_revision", "committed_revision", "protocol_version"])("mismatched receipt %s stays unknown", async field => {
    const f = fixture(); vi.mocked(f.port.reconcileWithReceipt).mockResolvedValue({ ...receipt(), [field]: "foreign" } as never);
    await expect(f.api.reconcileWithReceipt(input())).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.port.reconcileWithReceipt).toHaveBeenCalledOnce();
  });
  it("rejects foreign desired members and future/private receipt metadata", async () => {
    for (const bad of [ { ...receipt(), extra: true }, { ...receipt(), result: { ...receipt().result, namespace: "other" } },
      { ...receipt(), result: { ...receipt().result, timers: [{ ...row(), data: "not allowed" }] } },
      { ...receipt(), result: { ...receipt().result, timers: [{ ...row(), id: "other" }] } } ]) {
      const f = fixture(); vi.mocked(f.port.reconcileWithReceipt).mockResolvedValue(bad as never);
      await expect(f.api.reconcileWithReceipt(input())).rejects.toMatchObject({ code: "outcome_unknown" });
    }
  });
  it("reads the original committed receipt and an explicit missing-ID UNKNOWN", async () => {
    const f = fixture(); expect((await f.api.lookupOperation(input())).outcome).toBe("committed");
    vi.mocked(f.port.lookupOperation).mockResolvedValue({ outcome: "unknown", namespace: "tasks", operation_id: id } as never);
    expect(await f.api.lookupOperation(input())).toEqual({ outcome: "unknown", namespace: "tasks", operationId: id });
    expect(f.port.reconcileWithReceipt).not.toHaveBeenCalled();
  });
  it("never adopts a foreign or malformed lookup as original success", async () => {
    for (const bad of [{ outcome: "unknown" }, { outcome: "unknown", namespace: "other", operation_id: id },
      { outcome: "committed", receipt: { ...receipt(), expected_revision: 3 } }]) {
      const f = fixture(); vi.mocked(f.port.lookupOperation).mockResolvedValue(bad as never);
      await expect(f.api.lookupOperation(input())).rejects.toMatchObject({ code: "outcome_unknown" });
    }
  });
  it("rejects v4, unsafe/max revisions and duplicate input before dispatch", () => {
    const f = fixture();
    for (const bad of [{ ...input(), operationId: id.replace("7abc", "4abc") }, { ...input(), expectedRevision: Number.MAX_SAFE_INTEGER },
      { ...input(), expectedRevision: -1 }, { ...input(), timers: [input().timers[0]!, input().timers[0]!] }]) expect(() => f.api.reconcileWithReceipt(bad)).toThrow();
    expect(f.port.reconcileWithReceipt).not.toHaveBeenCalled();
    const old = new TimersApi({} as AppTimersPort); expect(() => old.lookupOperation(input())).toThrow("does not support");
  });
  it("close after dispatch suppresses late success without replacing the identity", async () => {
    const f = fixture(); let finish!: (v: ReturnType<typeof receipt>) => void;
    vi.mocked(f.port.reconcileWithReceipt).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.api.reconcileWithReceipt(input()); f.api.close(); finish(receipt());
    await expect(pending).rejects.toMatchObject({ code: "outcome_unknown" }); expect(f.port.reconcileWithReceipt).toHaveBeenCalledOnce();
  });
  it.each(["pre-aborted", "closed"])("%s lookup remains original UNKNOWN without calling the port", async phase => {
    const f = fixture();
    if (phase === "closed") f.api.close();
    const options = phase === "pre-aborted" ? { signal: AbortSignal.abort() } : {};
    await expect(f.api.lookupOperation(input(), options)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.port.lookupOperation).not.toHaveBeenCalled();
    expect(f.port.reconcileWithReceipt).not.toHaveBeenCalled();
  });
  it("clock-window original uncertainty is retained, never retried or reminted", async () => {
    const f = fixture(); vi.mocked(f.port.reconcileWithReceipt).mockRejectedValue({ problem: { operation_outcome: "unknown" } });
    await expect(f.api.reconcileWithReceipt(input())).rejects.toMatchObject({ code: "outcome_unknown" }); expect(f.port.reconcileWithReceipt).toHaveBeenCalledOnce();
  });
});
