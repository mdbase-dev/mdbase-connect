import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCollectionSetupJournal } from "../src/app-host/collection-setup-journal.js";
import { appCollectionControlClient, attachAppCollectionControl, type AppResourceSetupPort } from "../src/app-host/collection-control.js";
const scope = {account: "11111111-1111-4111-8111-111111111111", installation: "22222222-2222-4222-8222-222222222222", collection: "33333333-3333-4333-8333-333333333333"};
const hash = "sha256:" + "ab".repeat(32);
const plan = {pack: {id: "sample", version: "1", digest: hash}, assessmentDigest: hash, ops: [{kind: "resource_put" as const, path: "_types/sample.md", doc: "original source", mustNotExist: true}], readback: [{path: "_types/sample.md", doc: "original source"}]};
const resourcePlan = {assessmentDigest: hash, provisionDigest: hash, packs: [plan.pack], resourceOps: plan.ops, resourceReadback: plan.readback, sources: [{id: "44444444-4444-4444-8444-444444444444", path: "Views/original.base", document: "views: []\n"}]};
const mutators = ["prepare", "recordAttempt", "recordConfirmed", "recordVerified", "prepareResources", "prepareResourceRound", "recordResourceAttempt", "recordResourceConfirmed", "recordResourceVerified"] as const;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
function fixture(resourceSetup?: AppResourceSetupPort) {
  const parent = new AbortController(), ui = new AbortController(), channel = new MessageChannel();
  const binding = {scope, generation: crypto.randomUUID()};
  const journal = new AppCollectionSetupJournal({scope, databaseName: "original-model-db", applicationNamespace: "sample-app", appOrigin: "https://app.example.test", cpOrigin: "https://cp.example.test", isCurrent: () => !parent.signal.aborted});
  const assess = vi.fn(), foreground = vi.fn(), bad = vi.fn(), onClose = vi.fn();
  const server = attachAppCollectionControl(channel.port1, binding, {journal, resourceSetup, signal: parent.signal, isCurrent: () => !parent.signal.aborted, assess, foreground, onProtocolFailure: bad});
  const client = appCollectionControlClient(channel.port2, binding, {signal: ui.signal, isCurrent: () => !ui.signal.aborted, onClose});
  cleanup.push(async () => {parent.abort(); client.close(); await server.close(); journal.close();});
  return {parent, ui, channel, binding, journal, client, server, assess, foreground, bad, onClose};
}
describe("public scoped SDK journal/control channel", () => {
  it("serves write-ledger rows beside a busy setup request", async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    const producer: AppResourceSetupPort = {assess: vi.fn(async () => {await gate; return {status: "current" as const, assessmentDigest: hash};}), apply: vi.fn()};
    const parent = new AbortController(), ui = new AbortController(), channel = new MessageChannel(), binding = {scope, generation: crypto.randomUUID()};
    const journal = new AppCollectionSetupJournal({scope, databaseName: "ledger-db", applicationNamespace: "sample-app", appOrigin: "https://app.example.test", cpOrigin: "https://cp.example.test", isCurrent: () => true});
    const rows = new Map<string, string>();
    const server = attachAppCollectionControl(channel.port1, binding, {journal, resourceSetup: producer, signal: parent.signal, isCurrent: () => true, assess: vi.fn(), foreground: vi.fn(), onProtocolFailure: vi.fn(),
      ledger: () => ({list: () => [...rows.values()], put: (k, v) => void rows.set(k, v), remove: k => void rows.delete(k)})});
    const client = appCollectionControlClient(channel.port2, binding, {signal: ui.signal, isCurrent: () => true, onClose: vi.fn()});
    cleanup.push(async () => {finish(); parent.abort(); client.close(); await server.close(); journal.close();});
    const busy = client.resourceSetup.assess({}, ui.signal);
    await vi.waitFor(() => expect(producer.assess).toHaveBeenCalled());
    const entry = {mutationId: "55555555-5555-4555-8555-555555555555", records: [scope.collection], createdAt: 1, state: "rejected" as const,
      problem: {code: "conflict", recovery: "resolve_conflict" as const, message: "refused"}};
    await client.ledger.put(entry);
    expect(await client.ledger.list()).toEqual([entry]);
    await client.ledger.remove(entry.mutationId);
    expect(await client.ledger.list()).toEqual([]);
    finish(); await busy;
  });
  it("resource DATA uses the same control slot without a journal mutation or host loan", async () => {
    const producer: AppResourceSetupPort = { assess: vi.fn(async () => ({status: "provision" as const, assessmentDigest: hash})),
      apply: vi.fn(async () => ({...resourcePlan, sources: []})) };
    const f = fixture(producer), manifest = {id: "org.example.app", requirements: {}, provisions: {}};
    expect(await f.client.resourceSetup.assess(manifest, f.ui.signal)).toEqual({status: "provision", assessmentDigest: hash});
    const result = await f.client.resourceSetup.apply(manifest, hash, f.ui.signal);
    expect(result.resourceOps).toEqual(resourcePlan.resourceOps); expect(Object.isFrozen(result)).toBe(true);
    expect(producer.assess).toHaveBeenCalledWith(manifest, f.parent.signal);
    expect(producer.apply).toHaveBeenCalledWith(manifest, hash, f.parent.signal);
    expect(await f.client.journal.load(f.ui.signal)).toBeNull(); expect(f.assess).not.toHaveBeenCalled();
    expect("host" in f.client.resourceSetup).toBe(false); expect("session" in f.client.resourceSetup).toBe(false);
  });
  it("carries reviewed decisions and the review across the control slot, refusing a malformed review", async () => {
    const adopt = {"_types/task.md": "sha256:" + "cd".repeat(32)};
    const review = {packs: [{id: "org.example.task", version: "1.0.0", status: "install", installedVersion: null,
      resources: [{target: "_types/task.md", kind: "type", mode: "managed", action: "adopt", installed: false, currentDigest: adopt["_types/task.md"]}]}],
      configuration: [{requirement: "ext", path: "/settings/record_extensions", action: "add", value: "md"}], staged: [{path: "_types/task.md", document: "doc"}]};
    const producer: AppResourceSetupPort = { assess: vi.fn(async () => ({status: "provision" as const, assessmentDigest: hash, review} as never)),
      apply: vi.fn(async () => ({...resourcePlan, sources: []})) };
    const f = fixture(producer), manifest = {id: "org.example.app"};
    expect(await f.client.resourceSetup.assess(manifest, f.ui.signal, {adopt})).toEqual({status: "provision", assessmentDigest: hash, review});
    expect(producer.assess).toHaveBeenCalledWith(manifest, f.parent.signal, {adopt});
    await f.client.resourceSetup.apply(manifest, hash, f.ui.signal, {adopt});
    expect(producer.apply).toHaveBeenCalledWith(manifest, hash, f.parent.signal, {adopt});
    await expect(f.client.resourceSetup.assess(manifest, f.ui.signal, {adopt: {"_types/task.md": "md5:x"}})).rejects.toMatchObject({reason: "binding"});
    vi.mocked(producer.assess).mockResolvedValueOnce({status: "provision", assessmentDigest: hash, review: {...review, staged: [{path: "x", document: 1}]}} as never);
    await expect(f.client.resourceSetup.assess(manifest, f.ui.signal, {})).rejects.toBeTruthy();
  });
  it.each(["assess", "apply"] as const)("resource %s cancellation retains the original occupied slot", async action => {
    let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    const producer: AppResourceSetupPort = { assess: vi.fn(async () => {await gate; return {status: "provision" as const, assessmentDigest: hash};}),
      apply: vi.fn(async () => {await gate; return {...resourcePlan, sources: []};}) };
    const f = fixture(producer), caller = new AbortController();
    const work = action === "assess" ? f.client.resourceSetup.assess({}, caller.signal) : f.client.resourceSetup.apply({}, hash, caller.signal);
    await vi.waitFor(() => expect(producer[action]).toHaveBeenCalled());
    caller.abort(); await expect(work).rejects.toMatchObject({reason: "fenced"});
    await expect(f.client.journal.load(f.ui.signal)).rejects.toMatchObject({reason: "busy"});
    let settled = false; const close = f.server.close(); expect(f.server.close()).toBe(close); void close.then(() => {settled = true;});
    await Promise.resolve(); expect(settled).toBe(false); finish(); await close;
  });
  it.each(["assess", "apply"] as const)("resource %s fences at the original reply delivery boundary", async action => {
    const producer: AppResourceSetupPort = { assess: async () => ({status: "current", assessmentDigest: hash}), apply: async () => ({...resourcePlan, sources: []}) };
    const f = fixture(producer), caller = new AbortController(), receive = f.channel.port2.onmessage!;
    f.channel.port2.onmessage = event => {receive.call(f.channel.port2, event); if (event.data[4] === "result") caller.abort();};
    const work = action === "assess" ? f.client.resourceSetup.assess({}, caller.signal) : f.client.resourceSetup.apply({}, hash, caller.signal);
    await expect(work).rejects.toMatchObject({reason: "fenced"}); expect(f.assess).not.toHaveBeenCalled();
  });
  it("missing producer, malformed response and invalid digest refuse without preparing", async () => {
    const missing = fixture(); await expect(missing.client.resourceSetup.assess({}, missing.ui.signal)).rejects.toMatchObject({reason: "recovery_required"});
    const f = fixture({assess: async () => ({status: "current", assessmentDigest: "not-a-digest"}), apply: async () => ({...resourcePlan, sources: []})});
    await expect(f.client.resourceSetup.assess({}, f.ui.signal)).rejects.toMatchObject({reason: "binding"});
    await expect(f.client.resourceSetup.apply({}, "bad", f.ui.signal)).rejects.toMatchObject({reason: "binding"});
    expect(await f.client.journal.load(f.ui.signal)).toBeNull();
  });
  it.each(mutators.flatMap(action => [0, 1, ...(action === "prepareResources" || action === "prepareResourceRound" ? [2] : [])].map(depth => ({action, depth}))))("fences $action at delivery stage $depth without rollback, retry or remint", async ({action, depth}) => {
    const f = fixture(), caller = new AbortController(); const resource = action.includes("Resource");
    let previous: string | undefined;
    if (action !== "prepare" && action !== "prepareResources") {
      const seed = resource ? await f.journal.prepareResources(resourcePlan, f.parent.signal) : await f.journal.prepare(plan, f.parent.signal);
      previous = seed.mutationId;
      if (action.endsWith("Confirmed") || action.endsWith("Verified") || action === "prepareResourceRound") {
        if (resource) await f.journal.recordResourceAttempt(previous, f.parent.signal); else await f.journal.recordAttempt(previous, f.parent.signal);
      }
      if (action.endsWith("Verified") || action === "prepareResourceRound") {
        if (resource) await f.journal.recordResourceConfirmed(previous, f.parent.signal); else await f.journal.recordConfirmed(previous, f.parent.signal);
      }
      if (action === "prepareResourceRound") await f.journal.recordResourceVerified(previous, f.parent.signal);
    }
    const uuid = vi.spyOn(crypto, "randomUUID"); const receive = f.channel.port2.onmessage!;
    f.channel.port2.onmessage = event => {
      receive.call(f.channel.port2, event);
      if (event.data[4] === "result") {
        // 0: private waiter; 1: pack/resource wrapper; 2: outer resource facade.
        const cancel = (remaining: number): void => { if (remaining === 0) caller.abort(); else queueMicrotask(() => cancel(remaining - 1)); };
        cancel(depth);
      }
    };
    let operation: Promise<unknown>;
    if (action === "prepare") operation = f.client.journal.prepare(plan, caller.signal);
    else if (action === "prepareResources") operation = f.client.journal.prepareResources(resourcePlan, caller.signal);
    else if (action === "prepareResourceRound") operation = f.client.journal.prepareResourceRound!(resourcePlan, previous!, caller.signal);
    else operation = f.client.journal[action]!(previous!, caller.signal);
    await expect(operation).rejects.toMatchObject({reason: "outcome_unknown"}); expect(caller.signal.aborted).toBe(true);
    const committed = await f.journal.load(f.parent.signal); expect(committed).not.toBeNull();
    if (!committed || committed.version === 1) throw new Error("expected the committed original plan");
    expect(committed.plan).toEqual(resource ? resourcePlan : plan);
    expect(committed.phase).toBe(action.endsWith("Attempt") ? "attempted" : action.endsWith("Confirmed") ? "confirmed" : action.endsWith("Verified") ? "verified" : "prepared");
    if (action !== "prepareResourceRound" && previous) expect(committed.mutationId).toBe(previous);
    expect(uuid).toHaveBeenCalledTimes(action === "prepare" || action === "prepareResources" || action === "prepareResourceRound" ? 1 : 0);
    // The original reply releases the slot, unlike cancellation before a reply.
    f.channel.port2.onmessage = receive;
    expect(await f.client.journal.load(f.ui.signal)).toEqual(committed);
  });
  it.each(["assess", "foreground"] as const)("fences canceled %s acknowledgement after the private reply without replaying it", async action => {
    const f = fixture(), caller = new AbortController(); const receive = f.channel.port2.onmessage!;
    f.channel.port2.onmessage = event => { receive.call(f.channel.port2, event); if (event.data[4] === "result") caller.abort(); };
    const operation = action === "assess" ? f.client.assess("ready", caller.signal) : f.client.setForeground(false, caller.signal);
    await expect(operation).rejects.toMatchObject({reason: "fenced"});
    expect(action === "assess" ? f.assess : f.foreground).toHaveBeenCalledExactlyOnceWith(action === "assess" ? "ready" : false);
  });
  it("proxies original sealed journal verbs without replacing MID/plan/phase, ciphertext or key loans", async () => {
    const f = fixture(); expect(await f.client.journal.load(f.ui.signal)).toBeNull();
    const prepared = await f.client.journal.prepare(plan, f.ui.signal);
    expect(prepared.plan).toEqual(plan); expect(Object.isFrozen(prepared)).toBe(true);
    await f.client.journal.recordAttempt(prepared.mutationId, f.ui.signal);
    expect(await f.journal.load(f.parent.signal)).toEqual({...prepared, phase: "attempted"});
    await f.client.journal.recordConfirmed(prepared.mutationId, f.ui.signal);
    await f.client.journal.recordVerified(prepared.mutationId, f.ui.signal);
    expect(await f.client.journal.load(f.ui.signal)).toEqual({...prepared, phase: "verified"});
    expect("sql" in f.client).toBe(false); expect("key" in f.client).toBe(false); expect("host" in f.client).toBe(false);
  });
  it("requires explicit exact-generation assessment; load/prepare/history alone never reports ready", async () => {
    const f = fixture(); await f.client.journal.load(f.ui.signal); expect(f.assess).not.toHaveBeenCalled();
    await f.client.assess("setup_required", f.ui.signal); await f.client.assess("ready", f.ui.signal);
    expect(f.assess.mock.calls).toEqual([["setup_required"], ["ready"]]);
    await f.client.setForeground(false, f.ui.signal); expect(f.foreground).toHaveBeenCalledWith(false);
  });
  it("has one outstanding request with no hidden queue/retry, retaining canceled slot until original reply", async () => {
    const f = fixture(); let finish!: () => void;
    const gate = new Promise<void>(resolve => {finish = resolve;});
    const original = f.journal.load.bind(f.journal);
    vi.spyOn(f.journal, "load").mockImplementation(async signal => {await gate; return original(signal);});
    const ctrl = new AbortController(), request = f.client.journal.load(ctrl.signal);
    await expect(f.client.journal.load(f.ui.signal)).rejects.toMatchObject({reason: "busy"});
    ctrl.abort(); await expect(request).rejects.toMatchObject({reason: "fenced"});
    await expect(f.client.journal.load(f.ui.signal)).rejects.toMatchObject({reason: "busy"});
    finish(); await vi.waitFor(() => expect(f.journal.load).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await f.client.journal.load(f.ui.signal)).toBeNull());
  });
  it("owner stop rejects pending UI control before native teardown and stale response cannot ready another scope", async () => {
    const f = fixture(); let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    vi.spyOn(f.journal, "load").mockImplementation(async () => {await gate; return null;});
    const request = f.client.journal.load(f.ui.signal); await vi.waitFor(() => expect(f.journal.load).toHaveBeenCalledOnce());
    f.parent.abort(); const closing = f.server.close();
    await expect(request).rejects.toMatchObject({reason: "fenced"}); expect(f.onClose).toHaveBeenCalledOnce();
    finish(); await closing; expect(f.assess).not.toHaveBeenCalled();
  });
  it.each(["scope", "generation", "sql", "oversized"])("fails closed on %s packet before journal/assessment calls", async variant => {
    const f = fixture(); const load = vi.spyOn(f.journal, "load");
    const packet: unknown[] = [1, JSON.stringify([scope.account, scope.installation, scope.collection]), f.binding.generation, 1, "load", null];
    if (variant === "scope") packet[1] = "wrong";
    if (variant === "generation") packet[2] = crypto.randomUUID();
    if (variant === "sql") packet[4] = "executeSql";
    if (variant === "oversized") packet[5] = "x".repeat(600000);
    f.channel.port2.postMessage(packet); await vi.waitFor(() => expect(f.bad).toHaveBeenCalledOnce());
    expect(load).not.toHaveBeenCalled(); expect(f.assess).not.toHaveBeenCalled();
  });
  it("records a rejected round only on the native final-rejection witness for that exact mutation", async () => {
    const witness = vi.fn(async (_id: string, _signal: AbortSignal) => false);
    const producer: AppResourceSetupPort = { assess: vi.fn(), apply: vi.fn(), rejected: witness };
    const f = fixture(producer);
    const prepared = await f.journal.prepareResources(resourcePlan, f.parent.signal);
    await f.journal.recordResourceAttempt(prepared.mutationId, f.parent.signal);
    // A bare control assertion (no native rejection) never settles the round.
    await expect(f.client.journal.recordResourceRejected!(prepared.mutationId, f.ui.signal)).rejects.toMatchObject({reason: "recovery_required"});
    expect(witness).toHaveBeenCalledWith(prepared.mutationId, expect.anything());
    expect(await f.journal.load(f.parent.signal)).toMatchObject({phase: "attempted", mutationId: prepared.mutationId});
    // Without a native witness at all the verb is refused too.
    const bare = fixture({assess: vi.fn(), apply: vi.fn()});
    const other = await bare.journal.prepareResources(resourcePlan, bare.parent.signal);
    await bare.journal.recordResourceAttempt(other.mutationId, bare.parent.signal);
    await expect(bare.client.journal.recordResourceRejected!(other.mutationId, bare.ui.signal)).rejects.toMatchObject({reason: "recovery_required"});
    expect((await bare.journal.load(bare.parent.signal))?.phase).toBe("attempted");
    // A final native rejection of that mutation settles it.
    witness.mockResolvedValueOnce(true);
    expect(await f.client.journal.recordResourceRejected!(prepared.mutationId, f.ui.signal)).toMatchObject({phase: "rejected"});
  });
  it("does not serialize backend exception details into public control errors", async () => {
    const f = fixture(); vi.spyOn(f.journal, "load").mockRejectedValue(Error("private storage detail"));
    await expect(f.client.journal.load(f.ui.signal)).rejects.toMatchObject({reason: "recovery_required"});
  });
});
