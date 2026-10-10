import { describe, expect, it, vi } from "vitest";
import { TimersApi, type AppTimersPort } from "../src/timers.js";

const now = "2026-10-06T00:00:00.000Z";
const row = (id = "task:one", more = {}) => ({ id, criterion_id: "task.reminder", fire_at: now,
  generation: 1, status: "scheduled", created_at: now, updated_at: now, fired_at: null, ...more });
function fixture() {
  const p: AppTimersPort = {
    list: vi.fn(async ns => ({ namespace: ns, timers: [row()] })),
    put: vi.fn(async (_ns, id, body) => row(id, body)),
    cancel: vi.fn(async (ns, id) => ({ namespace: ns, id, cancelled: false })),
    reconcile: vi.fn(async (ns, body) => ({ namespace: ns, timers: body.timers.map((t: { id: string; fire_at: string }) => row(t.id, { ...t, criterion_id: body.criterion_id })), cancelled_ids: ["task:old"] })),
    registerWebPush: vi.fn(async () => ({ channelId: "channel", installationId: "installation", criteria: ["task.reminder"] })),
    unregisterWebPush: vi.fn(async () => {}),
    registerFcm: vi.fn(async () => ({ channelId: "channel", installationId: "installation", criteria: ["task.reminder"], transport: "fcm" as const })),
    unregisterFcm: vi.fn(async () => {}),
  };
  return { p, api: new TimersApi(p) };
}
const input = { namespace: "task-reminders", criterionId: "task.reminder", timer: { id: "task:one", fireAt: now } };

describe("backend-independent control timers", () => {
  it("lists typed content-free rows without a replica", async () => {
    const { p, api } = fixture();
    vi.mocked(p.list).mockResolvedValue({ namespace: input.namespace, timers: [row(undefined, { data: { private: "not exposed" }, extra: "not exposed" })] });
    expect(await api.list(input.namespace)).toEqual({ namespace: input.namespace, timers: [{ id: input.timer.id,
      criterionId: input.criterionId, fireAt: now, generation: 1, status: "scheduled", createdAt: now, updatedAt: now, firedAt: null }] });
  });
  it("puts exact opaque wire fields and does not re-arm fired", async () => {
    const { p, api } = fixture();
    vi.mocked(p.put).mockResolvedValue(row(undefined, { status: "fired", fired_at: now }));
    expect((await api.put(input)).status).toBe("fired");
    expect(p.put).toHaveBeenCalledWith(input.namespace, input.timer.id, { criterion_id: input.criterionId, fire_at: now }, { signal: expect.any(AbortSignal) });
  });
  it("snapshots a caller's reconcile inputs and maps cancelled_ids", async () => {
    const { p, api } = fixture();
    const timers = [{ ...input.timer }];
    const work = api.reconcile({ namespace: input.namespace, criterionId: input.criterionId, timers });
    timers[0]!.id = "changed";
    expect((await work).cancelledIds).toEqual(["task:old"]);
    expect(vi.mocked(p.reconcile).mock.calls[0]![1].timers[0]!.id).toBe("task:one");
  });
  it("cancels an exact generation without converting false to success", async () => {
    const { p, api } = fixture();
    expect((await api.cancel({ namespace: input.namespace, id: input.timer.id, generation: 4 })).cancelled).toBe(false);
    expect(p.cancel).toHaveBeenCalledWith(input.namespace, input.timer.id, 4, { signal: expect.any(AbortSignal) });
  });
  it("validates names, instants, duplicate IDs and content before dispatch", async () => {
    const { p, api } = fixture();
    expect(() => api.list("../other")).toThrow();
    expect(() => api.put({ ...input, timer: { ...input.timer, fireAt: "2026-10-06" } })).toThrow();
    expect(() => api.put({ ...input, timer: { ...input.timer, data: "body" } as typeof input.timer })).toThrow();
    expect(() => api.reconcile({ namespace: input.namespace, criterionId: input.criterionId, timers: [input.timer, input.timer] })).toThrow();
    expect(() => api.cancel({ namespace: input.namespace, id: input.timer.id, generation: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(p.put).not.toHaveBeenCalled();
    expect(p.reconcile).not.toHaveBeenCalled();
  });
  it("rejects a foreign namespace and malformed generation", async () => {
    const { p, api } = fixture();
    vi.mocked(p.list).mockResolvedValue({ namespace: "other", timers: [row()] });
    await expect(api.list(input.namespace)).rejects.toMatchObject({ reason: "invalid_timer_response" });
    vi.mocked(p.list).mockResolvedValue({ namespace: input.namespace, timers: [row(undefined, { generation: 0 })] });
    await expect(api.list(input.namespace)).rejects.toMatchObject({ reason: "invalid_timer_response" });
  });
  it("maps an actual Connect-port uncertain outcome to the SDK error without retry", async () => {
    const { p, api } = fixture();
    vi.mocked(p.put).mockRejectedValue({ problem: { operation_outcome: "unknown" }, code: "operation_failed" });
    await expect(api.put(input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(p.put).toHaveBeenCalledTimes(1);
  });
  it("closes an owned port exactly once", () => {
    const { p, api } = fixture(); p.close = vi.fn();
    api.close(); api.close(); expect(p.close).toHaveBeenCalledTimes(1);
  });
  it("marks a mismatched write response unknown, never retrying", async () => {
    const { p, api } = fixture();
    vi.mocked(p.put).mockResolvedValue(row("other"));
    await expect(api.put(input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(p.put).toHaveBeenCalledOnce();
  });
  it("rejects foreign or omitted reconciled members", async () => {
    const { p, api } = fixture();
    vi.mocked(p.reconcile).mockResolvedValue({ namespace: input.namespace, timers: [], cancelled_ids: [] });
    await expect(api.reconcile({ namespace: input.namespace, criterionId: input.criterionId, timers: [input.timer] })).rejects.toMatchObject({ code: "outcome_unknown" });
  });
  it("does not dispatch a pre-aborted request", async () => {
    const { p, api } = fixture();
    await expect(api.list(input.namespace, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" });
    expect(p.list).not.toHaveBeenCalled();
  });
  it("close aborts active work and suppresses late reads", async () => {
    const { p, api } = fixture();
    let finish!: (value: unknown) => void;
    vi.mocked(p.list).mockImplementation((_ns, { signal }) => {
      expect(signal?.aborted).toBe(false);
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = api.list(input.namespace);
    api.close();
    expect(vi.mocked(p.list).mock.calls[0]![1].signal?.aborted).toBe(true);
    finish({ namespace: input.namespace, timers: [row()] });
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
  it("close after write dispatch reports unknown, not cancellation", async () => {
    const { p, api } = fixture();
    let finish!: (value: unknown) => void;
    vi.mocked(p.put).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = api.put(input);
    api.close(); finish(row());
    await expect(pending).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(p.put).toHaveBeenCalledOnce();
  });
  it("uses only specific Web Push/FCM channel operations", async () => {
    const { p, api } = fixture();
    await api.registerFcm({ token: "synthetic-token", criteria: ["task.reminder"] });
    expect(p.registerFcm).toHaveBeenCalledWith({ token: "synthetic-token", criteria: ["task.reminder"], signal: expect.any(AbortSignal) });
    await api.unregisterFcm();
    expect(p.unregisterFcm).toHaveBeenCalledOnce();
    const worker = {} as ServiceWorkerRegistration;
    await api.registerWebPush({ serviceWorker: worker });
    await api.unregisterWebPush(worker);
    expect(p.unregisterWebPush).toHaveBeenCalledWith(worker, { signal: expect.any(AbortSignal) });
  });
});
