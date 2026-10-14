import { describe, expect, it, vi } from "vitest";
import {
  decidePoll, decideRouteBack, labRun, resumeLab, labWorkerClient, routeBack, PAUSE_REASON, STEP,
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
    ["preflight", "lab_profile_missing", "preflight"],
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
  it.each([undefined, "LAB", " lab", "lab ", "staging", "production"])("refuses environment %j before opening anything", async environment => {
    vi.resetModules();
    const createDatabase = vi.fn(), openDatabase = vi.fn();
    vi.doMock("../../db.js", () => ({ createDatabase, openDatabase }));
    const saved = { argv: process.argv, exitCode: process.exitCode, environment: process.env.MDBASE_CONNECT_ENVIRONMENT };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      if (environment === undefined) delete process.env.MDBASE_CONNECT_ENVIRONMENT; else process.env.MDBASE_CONNECT_ENVIRONMENT = environment;
      process.argv = ["node", "next-migration-lab", "lab-run", account, hold];
      await import("./migration-lab-cli.js");
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      expect(String(error.mock.calls[0]![0])).toContain("MDBASE_CONNECT_ENVIRONMENT=lab");
      expect(createDatabase).not.toHaveBeenCalled();
      expect(openDatabase).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = saved.argv;
      process.exitCode = saved.exitCode;
      if (saved.environment === undefined) delete process.env.MDBASE_CONNECT_ENVIRONMENT; else process.env.MDBASE_CONNECT_ENVIRONMENT = saved.environment;
      error.mockRestore();
      vi.doUnmock("../../db.js");
    }
  });
});
