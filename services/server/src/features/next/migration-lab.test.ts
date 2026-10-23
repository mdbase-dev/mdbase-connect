import { describe, expect, it, vi } from "vitest";
import {
  decidePoll, decideRouteBack, labRun, labStatus, resumeLab, labWorkerClient, routeBack, PAUSE_REASON, STEP,
  type LabConnect, type LabWorker, type RouteBackPhase, type WorkerReply, type WorkerStatus
} from "./migration-lab.js";

const account = "10000000-0000-4000-8000-000000000001", collection = "20000000-0000-4000-8000-000000000002";
const hold = "30000000-0000-4000-8000-000000000003", run1 = "40000000-0000-4000-8000-000000000004";
const CLI = "pnpm --filter @mdbase/connect-server next:migration-lab";

function st(state: string, step: number | null, o: { reason?: string; seq?: number | null; fenced?: boolean; outstanding?: { sequence: number; kind: number }; migration?: string } = {}): WorkerStatus {
  return {
    run: { state, reason: o.reason ?? null, backup_hold: hold, migration_id: o.migration ?? run1 },
    native: { run_sequence: o.seq === undefined ? 1 : o.seq, outstanding: o.outstanding ?? null,
      checkpoint: step === null ? null : { step, fenced: o.fenced ?? (step >= STEP.fenced && step < STEP.rollingBack) } }
  };
}
const refusal = (code: string) => Object.assign(new Error(code), { code });

describe("lab-run decision table", () => {
  it.each<[string, WorkerStatus, boolean, ReturnType<typeof decidePoll>]>([
    ["running before the fence waits", st("running", 3), false, { action: "wait" }],
    ["waiting (not yet / retry) waits", st("waiting", 5), false, { action: "wait" }],
    ["drained imports the timers", st("running", STEP.drained), false, { action: "import_timers" }],
    ["imported timers keep waiting", st("running", 9), true, { action: "wait" }],
    ["done and routed proceeds", st("done", STEP.routed), true, { action: "routed" }],
    ["outstanding_unknown stops", st("stopped", 4, { reason: "outstanding_unknown:AppendBase" }), false, { action: "stop", reason: "outstanding_unknown:AppendBase", routeBack: false }],
    ["effect_unknown stops", st("stopped", 6, { reason: "effect_unknown:Fence" }), false, { action: "stop", reason: "effect_unknown:Fence", routeBack: false }],
    ["settlement refusal stops", st("stopped", 8, { reason: "settlement_refused:ReadPage" }), false, { action: "stop", reason: "settlement_refused:ReadPage", routeBack: false }],
    ["connect refusal stops", st("stopped", 9, { reason: "connect_refused:migration_members_over_cap" }), false, { action: "stop", reason: "connect_refused:migration_members_over_cap", routeBack: false }],
    ["rollback_needs_operator stops for route-back", st("stopped", STEP.rollingBack, { reason: "rollback_needs_operator" }), false, { action: "stop", reason: "rollback_needs_operator", routeBack: true }],
    ["a rolling-back run stops for route-back", st("running", STEP.rollingBack), false, { action: "stop", reason: "rolling_back", routeBack: true }],
    ["done but rolled back stops for route-back", st("done", STEP.rolledBack), false, { action: "stop", reason: "run_done_at_step:21", routeBack: true }],
    ["a failed run stops", st("running", STEP.failed), false, { action: "stop", reason: "run_step:22", routeBack: false }],
    ["unreadable native state stops", { run: st("running", 1).run, native: { error: "migration_state_unreadable" } }, false, { action: "stop", reason: "native_state:migration_state_unreadable", routeBack: false }],
    ["no run stops", { ...st("running", 1), run: null }, false, { action: "stop", reason: "worker_run_missing", routeBack: false }],
    ["an unknown run state stops", st("paused", 1), false, { action: "stop", reason: "worker_state_unknown:paused", routeBack: false }]
  ])("%s", (_name, status, imported, expected) => {
    expect(decidePoll(status, imported)).toEqual(expected);
  });
});

describe("route-back decision table", () => {
  it.each<[string, WorkerStatus, RouteBackPhase, ReturnType<typeof decideRouteBack>]>([
    ["a stopped pre-cutover run rolls back on its sequence", st("stopped", 8, { seq: 1 }), "start", { action: "rollback", sequence: 1 }],
    ["a lost Unrevoke reply resolves from the receipt", st("stopped", STEP.rollingBack, { outstanding: { sequence: 9, kind: 20 } }), "rolling_back", { action: "resolve", sequence: 9 }],
    ["a lost Unfence reply resolves from the receipt", st("stopped", STEP.rollingBack, { outstanding: { sequence: 10, kind: 21 } }), "start", { action: "resolve", sequence: 10 }],
    ["any other outstanding action stops", st("stopped", 4, { outstanding: { sequence: 3, kind: 6 } }), "start", { action: "stop", reason: "outstanding_unknown:6" }],
    ["rolled back cleans timers then restarts", st("done", STEP.rolledBack, { seq: 2 }), "rolling_back", { action: "cleanup_restart", sequence: 2, migrationId: run1 }],
    ["rollback_needs_operator stops", st("stopped", STEP.rollingBack, { reason: "rollback_needs_operator" }), "rolling_back", { action: "stop", reason: "rollback_needs_operator" }],
    ["after cutover intent it stops", st("stopped", STEP.cutoverIntent), "start", { action: "stop", reason: "migration_post_cutover" }],
    ["a routed run stops", st("done", STEP.routed), "start", { action: "stop", reason: "migration_post_cutover" }],
    ["without a run sequence it stops", st("stopped", 5, { seq: null }), "start", { action: "stop", reason: "run_sequence_unavailable" }],
    ["a running first run cannot roll back", st("running", 5), "start", { action: "stop", reason: "migration_run_active" }],
    ["rolling back waits", st("running", STEP.rollingBack), "start", { action: "wait" }],
    ["a requested rollback waits", st("running", 5), "rolling_back", { action: "wait" }],
    ["the restarted run waits for its fence", st("running", 2, { seq: 2 }), "restarted", { action: "wait" }],
    ["the restarted run re-fenced is done", st("running", STEP.drained, { seq: 2 }), "restarted", { action: "done" }],
    ["a rerun after restart is done once fenced", st("waiting", 8, { seq: 2 }), "start", { action: "done" }],
    ["the restarted run stopping stops", st("stopped", 3, { seq: 2, reason: "source_refused:x" }), "restarted", { action: "stop", reason: "source_refused:x" }],
    ["unreadable native state stops", { run: st("stopped", 1).run, native: { error: "migration_state_unreadable" } }, "start", { action: "stop", reason: "native_state:migration_state_unreadable" }]
  ])("%s", (_name, status, phase, expected) => {
    expect(decideRouteBack(status, phase)).toEqual(expected);
  });
});

/** A Worker that answers status from a script (sticking on the last entry) and records calls. */
function fakeWorker(script: WorkerReply[], operator: Partial<Record<"rollback" | "restart" | "resolve" | "resume", (seq: number) => WorkerReply>> = {}) {
  const calls: string[] = [];
  let index = 0;
  const next = () => script[Math.min(index++, script.length - 1)]!;
  const ok = (status: WorkerStatus): WorkerReply => ({ kind: "ok", status });
  const worker: LabWorker = {
    async run() { calls.push("run"); return ok(st("running", 0)); },
    async status() { calls.push("status"); return next(); },
    async rollback(_c, seq) { calls.push(`rollback:${seq}`); return operator.rollback?.(seq) ?? ok(st("running", STEP.rollingBack)); },
    async restart(_c, seq) { calls.push(`restart:${seq}`); return operator.restart?.(seq) ?? ok(st("running", 0, { seq: seq + 1 })); },
    async resume(_c, seq) { calls.push(`resume:${seq}`); return operator.resume?.(seq) ?? ok(st("running", STEP.verified)); },
    async resolve(_c, seq) { calls.push(`resolve:${seq}`); return operator.resolve?.(seq) ?? ok(st("running", STEP.rollingBack)); }
  };
  return { worker, calls };
}
const ok = (status: WorkerStatus): WorkerReply => ({ kind: "ok", status });

function fakeConnect(overrides: Partial<Record<keyof LabConnect, () => Promise<unknown>>> = {}) {
  const calls: string[] = [];
  const step = (name: keyof LabConnect, value: unknown = undefined) => async (..._args: unknown[]) => {
    calls.push(name);
    return overrides[name] ? overrides[name]!() : value;
  };
  const connect = {
    preflight: step("preflight", { collection, backend: "legacy" }), prepareTarget: async () => undefined,
    importTimers: step("importTimers", {}),
    cutover: step("cutover"), flip: step("flip"), completion: step("completion"),
    cleanupTimers: step("cleanupTimers", { deleted: 2 })
  } as unknown as LabConnect;
  return { connect, calls };
}
const deps = (worker: LabWorker, connect: LabConnect) => ({ worker, connect, sleep: async () => undefined });
const happy = [ok(st("running", 3)), ok(st("running", STEP.drained)), ok(st("running", 9)), ok(st("done", STEP.routed))];

describe("lab-run custody prerequisite", () => {
  it("provisions the canonical SHADOW target before Worker ready can read hosted custody", async () => {
    const w = fakeWorker(happy), c = fakeConnect(), order: string[] = [];
    Object.assign(c.connect, { prepareTarget: async (id: string) => { expect(id).toBe(collection); order.push("target"); } });
    w.worker.run = async () => {
      order.push("worker");
      return order[0] === "target" ? ok(st("running", 0))
        : { kind: "refused", code: "migration_run_ready_failed" };
    };
    expect(await labRun(account, hold, deps(w.worker, c.connect))).toHaveProperty("done");
    expect(order).toEqual(["target", "worker"]);
  });
  it("does not start the Worker when target provisioning is refused or unavailable", async () => {
    const w = fakeWorker(happy), c = fakeConnect();
    Object.assign(c.connect, { prepareTarget: async () => { throw refusal("migration_target_unavailable"); } });
    expect(await labRun(account, hold, deps(w.worker, c.connect))).toMatchObject({ stopped: {
      step: "prepare_target", reason: "migration_target_unavailable"
    } });
    expect(w.calls).toEqual([]);
  });
});

describe("lab-run", () => {
  it("runs preflight, Worker run, timers at the drain, cutover, flip and the completion read-back in order", async () => {
    const w = fakeWorker(happy), c = fakeConnect();
    expect(await labRun(account, hold, deps(w.worker, c.connect))).toEqual({ done: expect.objectContaining({ lab_complete: true }) });
    expect(c.calls).toEqual(["preflight", "importTimers", "cutover", "flip", "completion"]);
    expect(w.calls.slice(0, 2)).toEqual(["run", "status"]);
  });

  it("prints one timeline line per Worker status change, ignoring repeats", async () => {
    const withLast = (status: WorkerStatus, kind: number) => ({ ...status, run: { ...status.run!, last: { sequence: kind + 1, kind } } });
    const w = fakeWorker([ok(withLast(st("waiting", 3, { reason: "draining" }), 12)), ok(withLast(st("waiting", 3, { reason: "draining" }), 12)),
      ok(withLast(st("running", STEP.drained), 12)), ok(st("running", 9)), ok(st("running", 9)), ok(st("done", STEP.routed))]);
    const events: Record<string, unknown>[] = [];
    let t = 1_000;
    const result = await labRun(account, hold, { ...deps(w.worker, fakeConnect().connect), now: () => (t += 250), log: event => events.push(event) });
    expect(result).toHaveProperty("done");
    const timeline = events.filter(e => e.step === "worker_timeline");
    expect(timeline.map(({ t_ms: _t, ...rest }) => rest)).toEqual([
      { step: "worker_timeline", state: "waiting", reason: "draining", checkpoint_step: 3, last_kind: 12 },
      { step: "worker_timeline", state: "running", reason: null, checkpoint_step: STEP.drained, last_kind: 12 },
      { step: "worker_timeline", state: "running", reason: null, checkpoint_step: 9, last_kind: null },
      { step: "worker_timeline", state: "done", reason: null, checkpoint_step: STEP.routed, last_kind: null }
    ]);
    const times = timeline.map(e => e.t_ms as number);
    expect(times.every((v, i) => v > 0 && (i === 0 || v > times[i - 1]!))).toBe(true);
  });

  it("retries timer_source_changed and re-imports on the flip's timers_source_changed", async () => {
    let imports = 0, flips = 0;
    const c = fakeConnect({
      importTimers: async () => { if (++imports <= 2) throw refusal("timer_source_changed"); return {}; },
      flip: async () => { if (++flips === 1) throw refusal("timers_source_changed"); }
    });
    expect("done" in await labRun(account, hold, deps(fakeWorker(happy).worker, c.connect))).toBe(true);
    expect(c.calls.filter(call => call === "importTimers")).toHaveLength(4);
    expect(c.calls.filter(call => call === "flip")).toHaveLength(2);
  });

  it.each<[keyof LabConnect, string, string]>([
    ["preflight", "start_profile_invalid", "preflight"],
    ["importTimers", "timer_grant_unbound", "import_timers"],
    ["importTimers", "timer_import_mismatch", "import_timers"],
    ["cutover", "cutover_not_recorded", "cutover"],
    ["cutover", "legacy_retention_pending", "cutover"],
    ["flip", "starter_reservation_changed", "flip"],
    ["flip", "next_timers_disabled", "flip"],
    ["completion", "lab_completion_missing", "verify_completion"]
  ])("a %s refusal %s is an operator stop at %s", async (method, code, step) => {
    const c = fakeConnect({ [method]: async () => { throw refusal(code); } });
    expect(await labRun(account, hold, deps(fakeWorker(happy).worker, c.connect))).toEqual({ stopped: {
      step, reason: code, inspect: `${CLI} status ${account}`, resume: `${CLI} lab-run ${account} ${hold}` } });
  });

  it("stops on persistent timer_source_changed and never prints an error message", async () => {
    const c = fakeConnect({ importTimers: async () => { throw Object.assign(new Error("postgres://user:secret@host"), { code: "timer_source_changed" }); } });
    const outcome = await labRun(account, hold, deps(fakeWorker(happy).worker, c.connect));
    expect(outcome).toMatchObject({ stopped: { step: "import_timers", reason: "timer_source_changed" } });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    const thrown = fakeConnect({ cutover: async () => { throw new Error("password=secret"); } });
    expect(await labRun(account, hold, deps(fakeWorker(happy).worker, thrown.connect))).toMatchObject({ stopped: { step: "cutover", reason: "unexpected_error" } });
  });

  it("names route-back as the resume for a Worker stop in rollback", async () => {
    const w = fakeWorker([ok(st("stopped", STEP.rollingBack, { reason: "rollback_needs_operator" }))]);
    expect(await labRun(account, hold, deps(w.worker, fakeConnect().connect))).toEqual({ stopped: {
      step: "worker_status", reason: "rollback_needs_operator", inspect: `${CLI} status ${account}`, resume: `${CLI} route-back ${account}` } });
  });

  it("resolves a lost run reply by reading the run back, and stops on a refused or different run", async () => {
    const lost = fakeWorker(happy);
    lost.worker.run = async () => ({ kind: "unknown", reason: "worker_unreachable" });
    expect("done" in await labRun(account, hold, deps(lost.worker, fakeConnect().connect))).toBe(true);
    const refused = fakeWorker(happy);
    refused.worker.run = async () => ({ kind: "refused", code: "migration_run_exists" });
    expect(await labRun(account, hold, deps(refused.worker, fakeConnect().connect))).toMatchObject({ stopped: { step: "worker_run", reason: "migration_run_exists" } });
    const unreachable = fakeWorker([{ kind: "unknown", reason: "worker_unreachable" }]);
    unreachable.worker.run = async () => ({ kind: "unknown", reason: "worker_unreachable" });
    expect(await labRun(account, hold, deps(unreachable.worker, fakeConnect().connect))).toMatchObject({ stopped: { step: "worker_run", reason: "worker_unreachable" } });
  });

  it.each(["http", "transport", "typed", "invalid", "unsafe", "unsafe400", "unsafe503"] as const)("preserves the initial %s run reply before resolving an absent run", async scenario => {
    const missing = { run: null, native: { checkpoint: null, outstanding: null } };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.collection).toBe(collection);
      if (fetchImpl.mock.calls.length === 1) {
        if (scenario === "transport") throw new TypeError("postgres://private:secret@host");
        if (scenario === "typed") return Response.json({ error: "migration_run_ready_failed", error_class: "type_error", message: "private secret" }, { status: 500 });
        if (scenario === "invalid") return Response.json({ run: "private secret" });
        if (scenario.startsWith("unsafe")) return Response.json({ error: "private_owner_secret", error_class: "private_role", message: "postgres://secret" },
          { status: scenario === "unsafe400" ? 400 : scenario === "unsafe503" ? 503 : 500 });
        return new Response("private secret", { status: 500 });
      }
      return Response.json(missing);
    });
    const worker = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40) }, fetchImpl as unknown as typeof fetch);
    const events: Record<string, unknown>[] = [];
    const result = await labRun(account, hold, { ...deps(worker, fakeConnect().connect), log: event => events.push(event) });
    const diagnostic = {
      http_status: scenario === "transport" ? null : scenario === "invalid" ? 200 : scenario === "unsafe400" ? 400 : scenario === "unsafe503" ? 503 : 500,
      worker_error_code: scenario === "typed" ? "migration_run_ready_failed" : null,
      worker_error_class: scenario === "typed" ? "type_error" : null,
      worker_error_stage: scenario === "typed" ? "unknown" : null,
      worker_error_name: scenario === "typed" ? "other" : null,
      worker_error_detail_code: scenario === "typed" ? "unknown" : null,
      transport_error_class: scenario === "transport" ? "network" : null,
      response_class: scenario === "transport" ? null : scenario === "http" ? "non_json" : scenario === "invalid" ? "invalid_status" : "json"
    };
    expect(result).toMatchObject({ stopped: { step: "worker_run", reason: "worker_run_missing", worker_run_reply: diagnostic } });
    expect(events).toContainEqual({ step: "worker_run_reply", kind: "unknown", ...diagnostic });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "https://worker.example/internal/v1/migration/run", "https://worker.example/internal/v1/migration/status"
    ]);
    expect(JSON.stringify({ result, events })).not.toContain("secret");
    expect(JSON.stringify({ result, events })).not.toContain("postgres");
  });

  it("an already flipped account only reads back the completion", async () => {
    const w = fakeWorker(happy), c = fakeConnect({ preflight: async () => ({ collection, backend: "next" }) });
    expect("done" in await labRun(account, hold, deps(w.worker, c.connect))).toBe(true);
    expect(c.calls).toEqual(["preflight", "completion"]);
    expect(w.calls).toEqual([]);
  });
});

describe("pre-cutover pause and explicit resume", () => {
  const paused = (): WorkerStatus => {
    const status = st("stopped", STEP.verified, { reason: PAUSE_REASON });
    status.run!.stop_before_flip = true; status.run!.resumed_run_sequence = null;
    return status;
  };
  const resumed = (): WorkerStatus => {
    const status = st("running", STEP.verified);
    status.run!.stop_before_flip = true; status.run!.resumed_run_sequence = 1;
    return status;
  };
  it("stops after H1 and timer import without cutover or flip; names explicit resume", async () => {
    const w = fakeWorker([ok(paused())]), c = fakeConnect();
    w.worker.run = vi.fn(async () => ok(paused()));
    expect(await labRun(account, hold, deps(w.worker, c.connect), true)).toMatchObject({ stopped: {
      reason: PAUSE_REASON, resume: `${CLI} resume ${account}`
    } });
    expect(w.worker.run).toHaveBeenCalledWith(collection, hold, true);
    expect(c.calls).toEqual(["preflight", "importTimers"]);
  });
  it("refuses a Worker which does not acknowledge requested pause mode", async () => {
    const c = fakeConnect();
    expect(await labRun(account, hold, deps(fakeWorker(happy).worker, c.connect), true)).toMatchObject({
      stopped: { reason: "migration_pause_mode_conflict" }
    });
    expect(c.calls).toEqual(["preflight"]);
  });
  it("dispatches resume once on the observed run sequence and then finishes with the original mode", async () => {
    const w = fakeWorker([ok(paused()), ok(st("done", STEP.routed))], { resume: () => ok(resumed()) }), c = fakeConnect();
    w.worker.run = vi.fn(async () => ok(resumed()));
    c.connect.preflight = vi.fn(async () => ({ collection, backend: "legacy" as const }));
    expect(await resumeLab(account, deps(w.worker, c.connect))).toMatchObject({ done: { lab_complete: true } });
    expect(c.connect.preflight).toHaveBeenCalledTimes(1);
    expect(w.calls.filter(call => call.startsWith("resume:"))).toEqual(["resume:1"]);
    expect(w.worker.run).toHaveBeenCalledWith(collection, hold, true);
  });
  it("lost resume output stops, with no retry, adoption or account flip", async () => {
    const w = fakeWorker([ok(paused())], { resume: () => ({ kind: "unknown", reason: "worker_unreachable" }) }), c = fakeConnect();
    expect(await resumeLab(account, deps(w.worker, c.connect))).toMatchObject({ stopped: {
      reason: "operator_outcome_unknown:worker_unreachable"
    } });
    expect(w.calls).toEqual(["status", "resume:1"]);
    expect(c.calls).toEqual(["preflight"]);
  });
  it.each(["checkpoint", "outstanding", "reason", "sequence", "mode", "consumed"])(
    "refuses resume for drifted %s", async field => {
      const status = paused();
      if ("error" in status.native) throw new Error("test invariant");
      if (field === "checkpoint") status.native.checkpoint!.step = STEP.cutoverIntent;
      if (field === "outstanding") status.native.outstanding = { sequence: 8, kind: 6 };
      if (field === "reason") status.run!.reason = "effect_unknown:Fence";
      if (field === "sequence") status.native.run_sequence = null;
      if (field === "mode") delete status.run!.stop_before_flip;
      if (field === "consumed") status.run!.resumed_run_sequence = 1;
      const w = fakeWorker([ok(status)]), c = fakeConnect();
      expect(await resumeLab(account, deps(w.worker, c.connect))).toHaveProperty("stopped");
      expect(w.calls).toEqual(["status"]);
      expect(c.calls).toEqual(["preflight"]);
    }
  );
});

describe("route-back", () => {
  it("rolls back, resolves a lost rollback reply from the receipt, cleans timers, restarts and waits for the re-fence", async () => {
    const w = fakeWorker([
      ok(st("stopped", 8, { reason: "operator_requested" })),
      ok(st("running", STEP.rollingBack)),
      ok(st("stopped", STEP.rollingBack, { reason: "effect_unknown:Unrevoke", outstanding: { sequence: 12, kind: 20 } })),
      ok(st("running", STEP.rollingBack)),
      ok(st("done", STEP.rolledBack)),
      ok(st("running", 1, { seq: 2, migration: undefined })),
      ok(st("running", STEP.drained, { seq: 2 }))
    ]);
    const c = fakeConnect();
    const outcome = await routeBack(account, deps(w.worker, c.connect));
    expect(outcome).toEqual({ done: { account_id: account, collection_id: collection, refenced: true, run_sequence: 2,
      next: `${CLI} lab-run ${account} ${hold}` } });
    expect(w.calls.filter(call => call !== "status")).toEqual(["rollback:1", "resolve:12", "restart:1"]);
    expect(c.calls).toEqual(["preflight", "cleanupTimers"]);
  });

  it.each(["timer_cleanup_drifted", "migration_rollback_not_settled", "migration_rollback_binding_conflict"])(
    "stops on %s before any restart and resumes on a rerun", async code => {
      const script = [ok(st("done", STEP.rolledBack)), ok(st("running", STEP.drained, { seq: 2 }))];
      let fail = true;
      const c = fakeConnect({ cleanupTimers: async () => { if (fail) throw refusal(code); return { deleted: 0 }; } });
      const first = fakeWorker(script);
      expect(await routeBack(account, deps(first.worker, c.connect))).toEqual({ stopped: {
        step: "timer_cleanup", reason: code, inspect: `${CLI} status ${account}`, resume: `${CLI} route-back ${account}` } });
      expect(first.calls).toEqual(["status"]);
      fail = false;
      const second = fakeWorker(script);
      expect("done" in await routeBack(account, deps(second.worker, c.connect))).toBe(true);
      expect(second.calls.filter(call => call !== "status")).toEqual(["restart:1"]);
    });

  it("stops on a refused or lost operator reply and on a rollback that does not settle", async () => {
    const refused = fakeWorker([ok(st("stopped", 8))], { rollback: () => ({ kind: "refused", code: "migration_operator_outstanding_unknown" }) });
    expect(await routeBack(account, deps(refused.worker, fakeConnect().connect)))
      .toMatchObject({ stopped: { step: "rollback", reason: "operator_refused:migration_operator_outstanding_unknown" } });
    const lost = fakeWorker([ok(st("done", STEP.rolledBack))], { restart: () => ({ kind: "unknown", reason: "worker_http_502" }) });
    expect(await routeBack(account, deps(lost.worker, fakeConnect().connect)))
      .toMatchObject({ stopped: { step: "restart", reason: "operator_outcome_unknown:worker_http_502" } });
    const stuck = fakeWorker([ok(st("stopped", STEP.rollingBack, { outstanding: { sequence: 4, kind: 21 } }))]);
    expect(await routeBack(account, deps(stuck.worker, fakeConnect().connect)))
      .toMatchObject({ stopped: { step: "resolve_receipt:4", reason: "resolve_receipt:4_did_not_settle" } });
  });
});

describe("Worker ready-stage wire v1", () => {
  async function reconcile(fields: Record<string, unknown>, code = "migration_run_ready_failed") {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: code, error_class: "error", ...fields }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ run: null, native: { checkpoint: null, outstanding: null } }));
    const worker = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40) }, fetchImpl as typeof fetch);
    const events: Record<string, unknown>[] = [];
    const connect = fakeConnect();
    const result = await labRun(account, hold, { ...deps(worker, connect.connect), log: event => events.push(event) });
    expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([
      "https://worker.example/internal/v1/migration/run", "https://worker.example/internal/v1/migration/status"
    ]);
    expect(connect.calls).toEqual(["preflight"]);
    expect(result).toMatchObject({ stopped: { step: "worker_run", reason: "worker_run_missing" } });
    return { result, events };
  }

  it.each([
    ["physical_collection_guard", "Error", "physical_collection_mismatch"],
    ["custody_open_sealer", "AbortError", "kms_aborted"],
    ["engine_cpp_open", "TypeError", "cpp_owned_control_not_established"],
    ["sync", "RangeError", "unknown"]
  ])("preserves %s before absent-run reconciliation without retry", async (stage, name, code) => {
    const { result, events } = await reconcile({ stage, error_name: name, error_code: code, message: "private secret" });
    const diagnostic = { worker_error_stage: stage, worker_error_name: name, worker_error_detail_code: code };
    expect(result).toMatchObject({ stopped: { worker_run_reply: diagnostic } });
    expect(events).toContainEqual(expect.objectContaining({ step: "worker_run_reply", kind: "unknown", ...diagnostic }));
    expect(JSON.stringify({ result, events })).not.toContain("secret");
  });

  it.each([undefined, null, 17, {}, [], "private_owner_secret", "postgres://private:secret@host", "t".repeat(40)])
    ("maps missing or unsafe detail %j to finite fallbacks", async unsafe => {
      const { result, events } = await reconcile({ stage: unsafe, error_name: unsafe, error_code: unsafe,
        message: "private_owner_secret", cause: "postgres://private:secret@host", stack: "private_owner_secret" });
      expect(result).toMatchObject({ stopped: { worker_run_reply: {
        worker_error_stage: "unknown", worker_error_name: "other", worker_error_detail_code: "unknown"
      } } });
      const output = JSON.stringify({ result, events });
      expect(output).not.toContain("secret");
      expect(output).not.toContain("postgres");
      expect(output).not.toContain("t".repeat(40));
    });

  it("does not attribute an unrelated reply to readiness even with valid detail values", async () => {
    const { result, events } = await reconcile({ stage: "engine_open", error_name: "Error", error_code: "kms_refused" }, "invalid_request");
    const diagnostic = { worker_error_stage: null, worker_error_name: null, worker_error_detail_code: null };
    expect(result).toMatchObject({ stopped: { worker_run_reply: diagnostic } });
    expect(events).toContainEqual(expect.objectContaining({ step: "worker_run_reply", ...diagnostic }));
  });
});

describe("LAB raw Worker run errors", () => {
  const raw = { message: "synthetic open failed", stack: "Error: synthetic open failed\n    at syntheticReady" };

  it.each(["lab", "staging", "production", "LAB", undefined])("captures only in the literal LAB environment (%s)", async environment => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "migration_run_ready_failed", raw_error: { ...raw, cause: "not captured" } }, { status: 500 }));
    const client = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40), environment }, fetchImpl as typeof fetch);
    const reply = await client.run(collection, hold);
    expect(reply.kind).toBe("unknown");
    expect(reply.diagnostic?.raw_error).toEqual(environment === "lab" ? raw : undefined);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["migration_run_ready_failed", "migration_run_failed"])("retains %s raw data through absent-run reconciliation without a retry", async error => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ error, raw_error: raw }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ run: null, native: { checkpoint: null, outstanding: null } }));
    const client = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40), environment: "lab" }, fetchImpl as typeof fetch);
    const events: Record<string, unknown>[] = [];
    const result = await labRun(account, hold, { ...deps(client, fakeConnect().connect), log: event => events.push(event) });
    expect(result).toMatchObject({ stopped: { reason: "worker_run_missing", worker_run_reply: { raw_error: raw } } });
    expect(events).toContainEqual(expect.objectContaining({ step: "worker_run_reply", kind: "unknown", raw_error: raw }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves bounded private custody call details but drops unrecognized or over-bound sub-causes", async () => {
    const valid = { call: "kms_unwrap", name: "Error", message: "synthetic provider failure" };
    for (const sub_cause of [valid, { ...valid, call: "arbitrary" }, { ...valid, message: "🦉".repeat(1025) }]) {
      const fetchImpl = vi.fn(async () => Response.json({ error: "migration_run_ready_failed", raw_error: { ...raw, sub_cause } }, { status: 500 }));
      const client = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40), environment: "lab" }, fetchImpl as typeof fetch);
      const reply = await client.run(collection, hold);
      expect(reply.diagnostic?.raw_error?.sub_cause).toEqual(sub_cause === valid ? valid : undefined);
    }
  });

  it("does not capture raw status, transport, unrelated, successful, or malformed errors", async () => {
    for (const [error, status, rawError] of [["invalid_request", 500, raw], ["migration_run_failed", 200, raw],
      ["migration_run_failed", 500, { message: {}, stack: raw.stack }]] as const) {
      const fetchImpl = vi.fn(async () => Response.json({ error, raw_error: rawError }, { status }));
      const client = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40), environment: "lab" }, fetchImpl as typeof fetch);
      expect((await client.run(collection, hold)).diagnostic?.raw_error).toBeUndefined();
      expect((await client.status(collection)).diagnostic).toBeUndefined();
    }
    const client = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40), environment: "lab" }, vi.fn(async () => { throw new Error("not captured"); }) as typeof fetch);
    expect((await client.run(collection, hold)).diagnostic?.raw_error).toBeUndefined();
  });
});

describe("Worker client", () => {
  it.each([["invalid_request", 400], ["migration_unconfigured", 503], ["migration_run_exists", 409], ["migration_pause_mode_conflict", 409]] as const)
    ("preserves the known run refusal %s at HTTP %s", async (code, status) => {
      const fetchImpl = vi.fn(async () => Response.json({ error: code }, { status }));
      const client = labWorkerClient({ url: "https://worker.example", token: "t".repeat(40) }, fetchImpl as unknown as typeof fetch);
      expect(await client.run(collection, hold)).toMatchObject({ kind: "refused", code, diagnostic: { http_status: status, worker_error_code: code } });
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

  it("is https-only and maps replies to ok, refused or unknown without echoing the token", async () => {
    const token = "t".repeat(40);
    expect(() => labWorkerClient({ url: "http://worker.example", token })).toThrow(/https/);
    const replies: Array<() => Response> = [
      () => Response.json(st("running", 1)),
      () => Response.json({ error: "migration_run_exists" }, { status: 409 }),
      () => new Response("bad gateway", { status: 502 }),
      () => Response.json({ run: "nope" })
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const next = replies.shift();
      if (!next) throw new Error("offline");
      return next();
    });
    const client = labWorkerClient({ url: "https://worker.example/", token }, fetchImpl as unknown as typeof fetch);
    expect((await client.status(collection)).kind).toBe("ok");
    expect(await client.run(collection, hold)).toMatchObject({ kind: "refused", code: "migration_run_exists", diagnostic: { http_status: 409, worker_error_code: "migration_run_exists" } });
    expect(await client.restart(collection, 1)).toEqual({ kind: "unknown", reason: "worker_http_502" });
    expect(await client.status(collection)).toEqual({ kind: "unknown", reason: "worker_reply_invalid" });
    expect(await client.resolve(collection, 3)).toEqual({ kind: "unknown", reason: "worker_unreachable" });
    expect(fetchImpl.mock.calls[2]![0]).toBe("https://worker.example/internal/v1/migration/operator");
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]!.body))).toEqual({ collection, operation: "restart", expected_run_sequence: 1 });
  });
});

describe("CLI", () => {
  /** Runs the CLI module once under a deployment environment; returns its single stderr line. */
  async function cliUnder(environment: string | undefined) {
    vi.resetModules();
    const createDatabase = vi.fn(), openDatabase = vi.fn();
    vi.doMock("../../db.js", () => ({ createDatabase, openDatabase }));
    const keys = ["MDBASE_CONNECT_ENVIRONMENT", "PUBLIC_URL", "DATABASE_URL", "MDBASE_LEGACY_PROVIDER_DATABASE_URL"] as const;
    const saved = { argv: process.argv, exitCode: process.exitCode, env: keys.map(key => process.env[key]) };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const key of keys) delete process.env[key];
      if (environment !== undefined) process.env.MDBASE_CONNECT_ENVIRONMENT = environment;
      process.env.PUBLIC_URL = environment === "production" ? "https://connect.mdbase.dev"
        : environment === "staging" ? "https://connect-staging.mdbase.dev" : "https://connect-lab.mdbase.dev";
      process.argv = ["node", "next-migration-lab", "lab-run", account, hold];
      await import("./migration-lab-cli.js");
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      expect(createDatabase).not.toHaveBeenCalled();
      expect(openDatabase).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      return String(error.mock.calls[0]![0]);
    } finally {
      process.argv = saved.argv;
      process.exitCode = saved.exitCode;
      keys.forEach((key, index) => { const value = saved.env[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
      error.mockRestore();
      vi.doUnmock("../../db.js");
    }
  }
  it.each([undefined, "", "LAB", " lab", "lab ", "Staging", "staging ", "Production", "prod", "production ", "local"])("refuses environment %j before opening anything", async environment => {
    expect(await cliUnder(environment)).toContain("MDBASE_CONNECT_ENVIRONMENT=lab, staging or production");
  });
  it.each(["lab", "staging", "production"])("admits the %s deployment past the environment gate (then requires its configuration)", async environment => {
    const message = await cliUnder(environment);
    expect(message).not.toContain("MDBASE_CONNECT_ENVIRONMENT");
    expect(message).toContain("DATABASE_URL");
  });
});


describe("managed two-phase orchestration", () => {
  const second = "20000000-0000-4000-8000-000000000003";
  const noRun = (): WorkerStatus => ({ run: null, native: { run_sequence: null, checkpoint: null, outstanding: null } });
  /** Pause-mode Worker runs: the first read is drained, then the run stops at the
   * verified pause until resumed; a resumed run is routed. Operator calls follow
   * the Worker's preconditions; nothing heals by itself. */
  function managed(ids = [collection, second], o: { scoped?: boolean; operatorStop?: boolean } = {}) {
    const c = fakeConnect(), order: string[] = [];
    const members = new Map<string, { reads: number; resumed: boolean; rolledBack: boolean; restarted: boolean; stopAt?: WorkerStatus }>();
    const pre = { job: "managed" as const, collections: ids, cut_over_collections: [] as string[], backend: "legacy" as const,
      intents: [] as string[], quiet_intents: [] as string[], archive_scoped: o.scoped ?? true, phase_latch: null as "cutover" | "route_back" | null,
      run: { binding: "two-phase-v1", collections: ids, backup_hold: hold, operator_stop_before_flip: o.operatorStop ?? false, started_us: "1" } };
    const pauseMode = (s: WorkerStatus, resumed: number | null = null) => { s.run!.stop_before_flip = true; s.run!.resumed_run_sequence = resumed; return s; };
    const view = (id: string): WorkerStatus => {
      const m = members.get(id);
      if (!m) return noRun();
      if (m.restarted) return pauseMode(st("running", STEP.drained, { seq: 2 }));
      if (m.rolledBack) return pauseMode(st("done", STEP.rolledBack));
      if (m.stopAt) return m.stopAt;
      if (m.resumed) return pauseMode(st("done", STEP.routed), 1);
      return m.reads++ === 0 ? pauseMode(st("running", STEP.drained)) : pauseMode(st("stopped", STEP.verified, { reason: PAUSE_REASON }));
    };
    const w = fakeWorker(happy);
    Object.assign(w.worker, {
      run: vi.fn(async (id: string, _hold: string, pause: boolean) => {
        expect(pause).toBe(true); order.push(`run:${id}`);
        members.set(id, { reads: 0, resumed: false, rolledBack: false, restarted: false }); return ok(view(id));
      }),
      status: vi.fn(async (id: string) => ok(view(id))),
      resume: vi.fn(async (id: string, sequence: number) => {
        const m = members.get(id)!;
        if (m.resumed) return { kind: "refused", code: "migration_operator_conflict" };
        m.resumed = true; order.push(`resume:${id}`); return ok(pauseMode(st("running", 9), sequence));
      }),
      rollback: vi.fn(async (id: string) => { members.get(id)!.rolledBack = true; order.push(`rollback:${id}`); return ok(pauseMode(st("running", STEP.rollingBack))); }),
      restart: vi.fn(async (id: string) => { members.get(id)!.restarted = true; order.push(`restart:${id}`); return ok(pauseMode(st("running", 0, { seq: 2 }))); })
    });
    Object.assign(c.connect, {
      preflight: vi.fn(async () => pre), bindRun: vi.fn(async () => undefined), claimWorkerRun: vi.fn(async () => true),
      // The account's one-way latch: the other phase refuses, the same phase is idempotent.
      latchPhase: vi.fn(async (_account: string, phase: "cutover" | "route_back") => {
        if (pre.phase_latch && pre.phase_latch !== phase) throw refusal(`managed_${pre.phase_latch}_started`);
        order.push(`latch:${phase}`); pre.phase_latch = phase;
      }),
      prepareTarget: vi.fn(async () => undefined), cleanupTimers: vi.fn(async () => ({ deleted: 0 })),
      unfence: vi.fn(async (_account: string, id: string) => { order.push(`unfence:${id}`); }),
      cutover: vi.fn(async (id: string) => { order.push(`cutover:${id}`); if (!pre.cut_over_collections.includes(id)) pre.cut_over_collections.push(id); }),
      flip: vi.fn(async () => { order.push("flip"); }), completion: vi.fn(async () => undefined)
    });
    return { pre, members, order, ...deps(w.worker, c.connect) };
  }
  const stopAt = (d: ReturnType<typeof managed>, id: string, status: WorkerStatus) => {
    const run = vi.mocked(d.worker.run), original = run.getMockImplementation()!;
    run.mockImplementation(async (c, h, p) => {
      const reply = await original(c, h, p);
      if (c === id) { status.run!.stop_before_flip = true; status.run!.resumed_run_sequence = null; d.members.get(id)!.stopAt = status; }
      return reply;
    });
  };

  it("brings every member to the verified pause before the first cutover, then flips once", async () => {
    const d = managed();
    expect(await labRun(account, hold, d)).toEqual({ done: { account_id: account, collection_ids: d.pre.collections, backend: "next", migration_complete: true } });
    expect(d.order).toEqual([`run:${collection}`, `run:${second}`, "latch:cutover", `resume:${collection}`, `cutover:${collection}`, `resume:${second}`, `cutover:${second}`, "flip"]);
    expect(d.connect.bindRun).toHaveBeenCalledExactlyOnceWith(account, [collection, second], hold, false);
    expect(d.connect.flip).toHaveBeenCalledExactlyOnceWith(account, [collection, second]);
    expect(d.connect.completion).toHaveBeenCalledExactlyOnceWith(account, [collection, second]);
  });
  it.each([{ ids: [second, collection] }, { ids: [collection, collection] }, { ids: [] }])("rejects a noncanonical array before dispatch: $ids", async ({ ids }) => {
    const d = managed(ids);
    expect(await labRun(account, hold, d)).toHaveProperty("stopped.reason", "managed_inventory_invalid");
    expect(d.connect.bindRun).not.toHaveBeenCalled(); expect(d.worker.run).not.toHaveBeenCalled();
  });
  it("an intent with no visible run is UNKNOWN: it stops before target creation, reservation or dispatch", async () => {
    const d = managed(); d.pre.intents.push(collection);
    expect(await labRun(account, hold, d)).toMatchObject({ stopped: { step: "worker_run", reason: "worker_run_outcome_unknown",
      collection_id: collection, phase: "prepare" } });
    expect(d.connect.prepareTarget).not.toHaveBeenCalled(); expect(d.connect.claimWorkerRun).not.toHaveBeenCalled();
    expect(d.worker.run).not.toHaveBeenCalled(); expect(d.connect.flip).not.toHaveBeenCalled();
  });
  it("a reservation that finds an existing intent stops without dispatch", async () => {
    const d = managed(); d.connect.claimWorkerRun = vi.fn(async () => false);
    expect(await labRun(account, hold, d)).toMatchObject({ stopped: { step: "worker_run", reason: "worker_run_outcome_unknown", collection_id: collection } });
    expect(d.worker.run).not.toHaveBeenCalled(); expect(d.connect.flip).not.toHaveBeenCalled();
  });
  it("retries a changing second-member import and refreshes the entire set on a changing flip source", async () => {
    const d = managed(), imports: string[] = []; let changedImport = false, changedFlip = false;
    d.connect.importTimers = async id => {
      imports.push(id);
      if (id === second && !changedImport) { changedImport = true; throw refusal("timer_source_changed"); }
    };
    d.connect.flip = vi.fn(async () => { if (!changedFlip) { changedFlip = true; throw refusal("timers_source_changed"); } });
    expect(await labRun(account, hold, d)).toHaveProperty("done.migration_complete", true);
    // Phase 1 (both at the pause), phase 2 (before each cutover), then the whole set for the flip retry.
    expect(imports).toEqual([collection, second, second, collection, second, collection, second]); expect(d.connect.flip).toHaveBeenCalledTimes(2);
  });
  it.each([["settlement_unknown", "lab-run"], ["rollback_needs_operator", "route-back"]])(
    "a second member stopping before the barrier (%s) leaves the first paused and never cut over", async (reason, next) => {
      const d = managed(); stopAt(d, second, st("stopped", STEP.drained, { reason }));
      expect(await labRun(account, hold, d)).toMatchObject({ stopped: { step: "worker_status", reason, collection_id: second, phase: "prepare",
        resume: next === "lab-run" ? `${CLI} lab-run ${account} ${hold}` : `${CLI} route-back ${account}` } });
      expect(d.order).toEqual([`run:${collection}`, `run:${second}`]);
      expect(d.connect.cutover).not.toHaveBeenCalled(); expect(d.connect.flip).not.toHaveBeenCalled();
    });
  it("stop-before-flip returns at the shared barrier; resume crosses it once for the whole set", async () => {
    const d = managed(undefined, { operatorStop: true });
    expect(await labRun(account, hold, d, true)).toMatchObject({ stopped: { step: "worker_status", reason: PAUSE_REASON, phase: "prepare",
      collection_ids: [collection, second], resume: `${CLI} resume ${account}` } });
    expect(d.order).toEqual([`run:${collection}`, `run:${second}`]);
    // A rerun of the pause pass is idempotent: no dispatch, still at the barrier.
    expect(await labRun(account, hold, d, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    expect(await resumeLab(account, d)).toHaveProperty("done.migration_complete", true);
    expect(d.order.slice(2)).toEqual(["latch:cutover", `resume:${collection}`, `cutover:${collection}`, `resume:${second}`, `cutover:${second}`, "flip"]);
    expect(d.worker.run).toHaveBeenCalledTimes(2);
  });
  it("resume refuses an incomplete pause pass without dispatching or resuming anything", async () => {
    const d = managed(undefined, { operatorStop: true });
    d.connect.prepareTarget = vi.fn(async (id: string) => { if (id === second && d.order.length < 2) throw refusal("migration_target_unavailable"); });
    expect(await labRun(account, hold, d, true)).toMatchObject({ stopped: { step: "prepare_target", collection_id: second } });
    expect(await resumeLab(account, d)).toMatchObject({ stopped: { step: "resume", reason: "managed_pause_incomplete", collection_id: second,
      resume: `${CLI} lab-run ${account} ${hold} --stop-before-flip` } });
    expect(d.order).toEqual([`run:${collection}`]);
    d.order.push("retry");
    expect(await labRun(account, hold, d, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    expect(await resumeLab(account, d)).toHaveProperty("done.migration_complete", true);
    expect(d.worker.run).toHaveBeenCalledTimes(2); expect(d.worker.resume).toHaveBeenCalledTimes(2);
  });
  it("after the first cutover every rerun is forward only: route-back refuses and lab-run completes without a new dispatch", async () => {
    const d = managed(), cutover = vi.mocked(d.connect.cutover), original = cutover.getMockImplementation()!; let lost = true;
    cutover.mockImplementation(async (id: string) => {
      if (id === second && lost) { lost = false; throw refusal("migration_source_unavailable"); }
      return original(id);
    });
    expect(await labRun(account, hold, d)).toMatchObject({ stopped: { step: "cutover", reason: "migration_source_unavailable",
      collection_id: second, phase: "cutover", resume: `${CLI} resume ${account}` } });
    expect(await routeBack(account, d)).toMatchObject({ stopped: { step: "preflight", reason: "managed_cutover_started", resume: `${CLI} resume ${account}` } });
    expect(d.worker.rollback).not.toHaveBeenCalled();
    expect(await labRun(account, hold, d)).toHaveProperty("done.migration_complete", true);
    expect(d.worker.run).toHaveBeenCalledTimes(2); expect(d.worker.resume).toHaveBeenCalledTimes(2); expect(d.connect.flip).toHaveBeenCalledTimes(1);
  });
  it("a lost resume reply stops; the rerun re-reads the still-current pause before the one sequence-bound resume", async () => {
    const d = managed(), resume = vi.mocked(d.worker.resume), original = resume.getMockImplementation()!; let lost = true;
    resume.mockImplementation(async (id: string, sequence: number) => {
      if (id === second && lost) { lost = false; return { kind: "unknown", reason: "worker_unreachable" }; }
      return original(id, sequence);
    });
    expect(await labRun(account, hold, d)).toMatchObject({ stopped: { step: "resume", reason: "operator_outcome_unknown:worker_unreachable",
      collection_id: second, phase: "cutover" } });
    expect(await resumeLab(account, d)).toHaveProperty("done.migration_complete", true);
    expect(d.worker.run).toHaveBeenCalledTimes(2); expect(d.connect.flip).toHaveBeenCalledTimes(1);
  });
  it("status inspects every member, including an unavailable second member and its intent", async () => {
    const d = managed(); d.pre.intents.push(second);
    d.worker.status = vi.fn(async (id: string): Promise<WorkerReply> => id === second ? { kind: "unknown", reason: "worker_unreachable" } : ok(st("done", STEP.routed)));
    const result = await labStatus(account, d);
    expect(result.collections).toEqual([
      expect.objectContaining({ collection_id: collection, intent: false, worker: st("done", STEP.routed) }),
      expect.objectContaining({ collection_id: second, intent: true, worker: { kind: "unknown", reason: "worker_unreachable" } })
    ]);
    expect(d.connect.preflight).toHaveBeenCalledWith(account, { inspect: true });
  });
  it("scoped route-back rolls every dispatched member back to verified legacy and never restarts", async () => {
    const d = managed(undefined, { operatorStop: true });
    expect(await labRun(account, hold, d, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    expect(await routeBack(account, d)).toEqual({ done: { account_id: account, collection_ids: [collection, second], not_dispatched: [],
      disposition: "legacy_post_bulk_follow_up", collections: [collection, second].map(collection_id => ({
        account_id: account, collection_id, rolled_back: true, legacy_verified: true, run_sequence: 1 })) } });
    expect(d.worker.restart).not.toHaveBeenCalled(); expect(d.connect.cleanupTimers).toHaveBeenCalledTimes(2);
    // Idempotent: a rerun only re-confirms the settled rollback.
    expect(await routeBack(account, d)).toHaveProperty("done.disposition", "legacy_post_bulk_follow_up");
    expect(d.worker.rollback).toHaveBeenCalledTimes(2); expect(d.connect.flip).not.toHaveBeenCalled();
  });
  it("an unscoped managed route-back is terminal too: no restart re-fences a source no lab-run could continue", async () => {
    const d = managed(undefined, { scoped: false, operatorStop: true });
    await labRun(account, hold, d, true);
    expect(await routeBack(account, d)).toMatchObject({ done: { disposition: "legacy_post_bulk_follow_up",
      collections: [expect.objectContaining({ collection_id: collection, rolled_back: true }), expect.objectContaining({ collection_id: second, rolled_back: true })] } });
    expect(d.worker.restart).not.toHaveBeenCalled();
    expect(await labRun(account, hold, d, true)).toMatchObject({ stopped: { reason: "managed_route_back_started", resume: `${CLI} route-back ${account}` } });
  });
  it("route-back unfences a never-dispatched member after the latch and the fresh re-inspection", async () => {
    const d = managed(); stopAt(d, collection, st("stopped", STEP.drained, { reason: "settlement_unknown" }));
    expect(await labRun(account, hold, d)).toMatchObject({ stopped: { collection_id: collection } });
    expect(await routeBack(account, d)).toMatchObject({ done: { not_dispatched: [second], disposition: "legacy_post_bulk_follow_up",
      collections: [expect.objectContaining({ collection_id: collection, rolled_back: true }), { collection_id: second, not_dispatched: true, legacy_verified: true }] } });
    expect(d.order).toEqual([`run:${collection}`, "latch:route_back", `rollback:${collection}`, `unfence:${second}`]);
  });
  it("a runless intent past the quiet period counts as never dispatched; a failed unfence names route-back", async () => {
    const d = managed(); stopAt(d, collection, st("stopped", STEP.drained, { reason: "settlement_unknown" }));
    await labRun(account, hold, d); d.pre.intents.push(second); d.pre.quiet_intents.push(second);
    vi.mocked(d.connect.unfence!).mockRejectedValueOnce(refusal("migration_run_not_current"));
    expect(await routeBack(account, d)).toMatchObject({ stopped: { step: "unfence", reason: "migration_run_not_current", collection_id: second,
      resume: `${CLI} route-back ${account}` } });
    expect(await routeBack(account, d)).toMatchObject({ done: { not_dispatched: [second],
      collections: [expect.objectContaining({ collection_id: collection, rolled_back: true }), { collection_id: second, not_dispatched: true, legacy_verified: true }] } });
    expect(d.order.filter(e => e.startsWith("latch:"))).toEqual(["latch:route_back"]);
  });
  it("route-back refuses the whole set before any mutation while a member's dispatch is UNKNOWN", async () => {
    const d = managed(); stopAt(d, collection, st("stopped", STEP.drained, { reason: "settlement_unknown" }));
    await labRun(account, hold, d); d.pre.intents.push(second);
    expect(await routeBack(account, d)).toMatchObject({ stopped: { reason: "worker_run_outcome_unknown", collection_id: second } });
    expect(d.worker.rollback).not.toHaveBeenCalled(); expect(d.connect.cleanupTimers).not.toHaveBeenCalled();
  });
  it("an unscoped route-back with nothing dispatched mutates nothing and names the rerun", async () => {
    const d = managed(undefined, { scoped: false });
    expect(await routeBack(account, d)).toEqual({ stopped: { step: "worker_status", reason: "managed_nothing_dispatched",
      inspect: `${CLI} status ${account}`, resume: `${CLI} lab-run ${account} ${hold}`, collection_ids: [collection, second] } });
    expect(d.connect.latchPhase).not.toHaveBeenCalled(); expect(d.connect.unfence).not.toHaveBeenCalled();
  });
  it("a scoped route-back with nothing dispatched still unfences every prearchive-fenced member", async () => {
    const d = managed();
    expect(await routeBack(account, d)).toMatchObject({ done: { not_dispatched: [collection, second], disposition: "legacy_post_bulk_follow_up" } });
    expect(d.order).toEqual(["latch:route_back", `unfence:${collection}`, `unfence:${second}`]);
  });
  it("resume imports EVERY member's timers before the cutover latch or any resume", async () => {
    const d = managed(undefined, { operatorStop: true }); let failing = true;
    d.connect.importTimers = vi.fn(async (id: string) => { d.order.push(`import:${id}`); if (id === second && failing) throw refusal("timer_import_mismatch"); return {}; });
    // Both Workers still reach their pause; only the CP import of the last member failed.
    expect(await labRun(account, hold, d, true)).toMatchObject({ stopped: { step: "import_timers", reason: "timer_import_mismatch", collection_id: second } });
    expect(await resumeLab(account, d)).toMatchObject({ stopped: { step: "import_timers", reason: "timer_import_mismatch", collection_id: second, phase: "prepare" } });
    expect(d.connect.latchPhase).not.toHaveBeenCalled(); expect(d.worker.resume).not.toHaveBeenCalled(); expect(d.connect.cutover).not.toHaveBeenCalled();
    failing = false; d.order.length = 0;
    expect(await resumeLab(account, d)).toHaveProperty("done.migration_complete", true);
    expect(d.order.slice(0, 3)).toEqual([`import:${collection}`, `import:${second}`, "latch:cutover"]);
    expect(d.worker.run).toHaveBeenCalledTimes(2); expect(d.connect.flip).toHaveBeenCalledTimes(1);
  });
  it("route-back inspects the second member before mutating an eligible first member", async () => {
    const d = managed(), paused = st("stopped", STEP.verified, { reason: PAUSE_REASON });
    paused.run!.stop_before_flip = true; paused.run!.resumed_run_sequence = null;
    d.worker.status = vi.fn(async id => id === second ? ok(st("done", STEP.routed)) : ok(paused));
    expect(await routeBack(account, d)).toMatchObject({ stopped: { reason: "migration_post_cutover", collection_id: second } });
    expect(d.worker.status).toHaveBeenCalledTimes(2); expect(d.connect.cleanupTimers).not.toHaveBeenCalled();
    expect(d.worker.rollback).not.toHaveBeenCalled();
  });
  it("a first resume whose arrival is unknown makes the account forward only: route-back reads and mutates nothing", async () => {
    const d = managed(), resume = vi.mocked(d.worker.resume), original = resume.getMockImplementation()!; let delayed = true;
    resume.mockImplementation(async (id: string, sequence: number) => {
      if (delayed) { delayed = false; return { kind: "unknown", reason: "worker_unreachable" }; } // Not (yet) arrived.
      return original(id, sequence);
    });
    expect(await labRun(account, hold, d)).toMatchObject({ stopped: { step: "resume", collection_id: collection, phase: "cutover",
      resume: `${CLI} resume ${account}` } });
    const reads = vi.mocked(d.worker.status).mock.calls.length;
    expect(await routeBack(account, d)).toEqual({ stopped: { step: "preflight", reason: "managed_cutover_started", inspect: `${CLI} status ${account}`,
      resume: `${CLI} resume ${account}`, collection_ids: [collection, second] } });
    expect(d.worker.status).toHaveBeenCalledTimes(reads); expect(d.worker.rollback).not.toHaveBeenCalled();
    expect(await resumeLab(account, d)).toHaveProperty("done.migration_complete", true);
    expect(d.order.filter(e => e.startsWith("latch:"))).toEqual(["latch:cutover"]);
  });
  it("a member resumed out of band (no latch) still makes route-back refuse before the latch or any rollback", async () => {
    const d = managed(), resumed = st("running", STEP.verified), paused = st("stopped", STEP.verified, { reason: PAUSE_REASON });
    Object.assign(resumed.run!, { stop_before_flip: true, resumed_run_sequence: 1 }); Object.assign(paused.run!, { stop_before_flip: true, resumed_run_sequence: null });
    d.worker.status = vi.fn(async id => ok(id === second ? resumed : paused));
    expect(await routeBack(account, d)).toMatchObject({ stopped: { reason: "managed_cutover_started", collection_id: second } });
    expect(d.connect.latchPhase).not.toHaveBeenCalled(); expect(d.worker.rollback).not.toHaveBeenCalled();
  });
  it("route-back that loses the latch to phase 2 after its inspection refuses before any rollback", async () => {
    const d = managed(undefined, { operatorStop: true }), latch = vi.mocked(d.connect.latchPhase!);
    expect(await labRun(account, hold, d, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    latch.mockImplementationOnce(async () => { d.pre.phase_latch = "cutover"; throw refusal("managed_cutover_started"); });
    expect(await routeBack(account, d)).toMatchObject({ stopped: { step: "preflight", reason: "managed_cutover_started", resume: `${CLI} resume ${account}` } });
    expect(d.worker.rollback).not.toHaveBeenCalled(); expect(d.connect.cleanupTimers).not.toHaveBeenCalled();
  });
  it("phase 2 that loses the latch to route-back sends no resume; lab-run and resume then name route-back", async () => {
    const d = managed(undefined, { operatorStop: true }), latch = vi.mocked(d.connect.latchPhase!);
    expect(await labRun(account, hold, d, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    latch.mockImplementationOnce(async () => { d.pre.phase_latch = "route_back"; throw refusal("managed_route_back_started"); });
    expect(await resumeLab(account, d)).toMatchObject({ stopped: { step: "cutover_latch", reason: "managed_route_back_started", phase: "prepare",
      resume: `${CLI} route-back ${account}` } });
    for (const again of [() => labRun(account, hold, d), () => resumeLab(account, d)])
      expect(await again()).toMatchObject({ stopped: { step: "preflight", reason: "managed_route_back_started", resume: `${CLI} route-back ${account}` } });
    expect(d.worker.resume).not.toHaveBeenCalled(); expect(d.connect.bindRun).toHaveBeenCalledTimes(2);
    expect(await routeBack(account, d)).toHaveProperty("done.disposition", "legacy_post_bulk_follow_up");
  });
  it("route-back re-inspects under its latch: a member dispatched meanwhile is rolled back too", async () => {
    const d = managed(); stopAt(d, collection, st("stopped", STEP.drained, { reason: "settlement_unknown" }));
    expect(await labRun(account, hold, d)).toMatchObject({ stopped: { collection_id: collection } });
    const latch = vi.mocked(d.connect.latchPhase!), original = latch.getMockImplementation()!;
    latch.mockImplementationOnce(async (a, phase) => { // A concurrent phase 1 dispatched the second member first.
      await d.worker.run(second, hold, true); await d.worker.status(second); return original(a, phase);
    });
    expect(await routeBack(account, d)).toMatchObject({ done: { not_dispatched: [], collections: [
      expect.objectContaining({ collection_id: collection, rolled_back: true }), expect.objectContaining({ collection_id: second, rolled_back: true })] } });
  });
});
