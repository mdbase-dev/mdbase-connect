// Controller/journal lifecycle only: the injected producer is an explicit
// stand-in, not canonical Core semantic or native qualification evidence.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/client.js";
import { mdbaseError } from "../src/errors.js";
import type { ListResourcesResult, ResourceView } from "../src/wire.js";
import { MemoryReplica } from "../src/testing/index.js";
import { AppCollectionSetupJournal } from "../src/app-host/collection-setup-journal.js";
import type { ModelResourcePlan } from "../src/app-host/collection-setup-types.js";
import { applicationDeclaration } from "../src/application/declaration.js";
import { compileApplicationManifest } from "../src/application/manifest.js";
import { createApplicationConfiguration, type ApplicationConfigurationResources } from "../src/application/configuration.js";

const digest = `sha256:${"ab".repeat(32)}`;
const generation = "11111111-1111-4111-8111-111111111111";
const plan: ModelResourcePlan = {
  assessmentDigest: digest, provisionDigest: digest,
  packs: [{ id: "org.example.task", version: "1.0.0", digest }],
  resourceOps: [{ kind: "resource_put", path: "_types/task.md", doc: "Synthetic resource", mustNotExist: true }],
  resourceReadback: [{ path: "_types/task.md", doc: "Synthetic resource" }], sources: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(mode: "inspect" | "approved-new" | "reconcile-original" = "inspect", writes = true) {
  const replica = new MemoryReplica();
  const client = await connect({ connector: replica.connector(), app: { name: "configuration-test", version: "0" }, reconnect: false });
  const scope = { account: generation, installation: "22222222-2222-4222-8222-222222222222", collection: client.hello.collection };
  let current = true, status: "current" | "provision" | "conflict" = "current";
  const compiledManifest = compileApplicationManifest(applicationDeclaration({
    id: generation, name: "Example", origin: "https://app.test", environment: "production",
    manifest: { manifest_version: 1, id: "org.example.app", name: "Example", homepage: "https://app.test", redirect_uris: ["https://app.test/callback"],
      requirements: { access: "full_collection", contracts: [], capabilities: { contract_version: 2,
        required: writes ? ["collection.read", "definitions.manage", "records.create"] : ["collection.read"] } } },
  }));
  const journal = new AppCollectionSetupJournal({ databaseName: "configuration-controller", applicationNamespace: "configuration-test", scope,
    appOrigin: "https://app.test", cpOrigin: "https://connect-lab.mdbase.dev", isCurrent: () => current });
  const port: ApplicationConfigurationResources = {
    assess: vi.fn(async () => ({ status, assessmentDigest: digest })),
    apply: vi.fn(async () => { status = "current"; return plan; }),
  };
  const controller = new AbortController();
  const input = { client, compiledManifest, journal, scope, generation, signal: controller.signal, isCurrent: () => current, setupMode: mode };
  const helper = createApplicationConfiguration(input, port);
  return { client, replica, journal, port, helper, input, controller,
    status(value: typeof status) { status = value; }, stale() { current = false; },
    async close() { await helper.close().catch(() => {}); journal.close(); await client.close(); } };
}
async function retirementFixture() {
  const f = await fixture();
  f.replica.seedResource("_types/task.md", "original resource");
  const original = await f.client.resources.get("_types/task.md");
  const retirement: ModelResourcePlan = {...plan,
    resourceOps: [{kind: "resource_delete", path: original.path, baseRevision: original.revision}],
    resourceReadback: [{path: original.path, doc: null}]};
  vi.mocked(f.port.apply).mockImplementation(async () => {f.status("current"); return retirement;});
  return {...f, retirement};
}
async function retainedRetirement() {
  const f = await retirementFixture(), prepared = await f.journal.prepareResources(f.retirement, f.controller.signal);
  await f.journal.recordResourceAttempt(prepared.mutationId, f.controller.signal);
  const writes = await f.client.submit([...f.retirement.resourceOps], {mutationId: prepared.mutationId, wait: "confirmed"});
  await writes[0]!.confirmed;
  await f.journal.recordResourceConfirmed(prepared.mutationId, f.controller.signal);
  f.status("current");
  return {...f, prepared};
}
const metadata = (path: string): ResourceView => ({path, revision: digest, size: 1, state: "confirmed"});
describe("scoped application configuration phase", () => {
  it("construction and initial snapshot do no IO, only explicit assessment delivers scoped evidence", async () => {
    const f = await fixture();
    try {
      expect(f.port.assess).not.toHaveBeenCalled();
      expect(f.helper.getSnapshot()).toEqual({ checking: false, assessment: null, problem: null });
      expect((await f.helper.assess()).assessment?.status).toBe("ready");
      expect(f.port.apply).not.toHaveBeenCalled();
      expect(await f.journal.load(f.controller.signal)).toBeNull();
    } finally { await f.close(); }
  });
  it("missing producer refuses without inventing ready evidence", async () => {
    const f = await fixture();
    const helper = createApplicationConfiguration(f.input);
    try { await expect(helper.assess()).rejects.toMatchObject({ reason: "configuration_unsupported" }); expect(helper.getSnapshot().assessment).toBeNull(); }
    finally { await helper.close(); await f.close(); }
  });
  it("canonical configuration-only declaration journals real config ops with zero packs", async () => {
    const f = await fixture(); f.status("provision");
    const manifest = f.input.compiledManifest.manifest;
    const compiledManifest = compileApplicationManifest(applicationDeclaration({id: generation, name: "Example", origin: "https://app.test", environment: "production",
      manifest: {...manifest, requirements: {...manifest.requirements, configuration: [{id: "base-format", path: "/settings/record_extensions", predicate: "contains", value: "base"}]},
        provisions: {type_packs: [], configuration: [{requirement: "base-format", operation: "set_add", path: "/settings/record_extensions", value: "base"}]}}}));
    const doc = "settings: {record_extensions: [md, base]}\n";
    const configPlan: ModelResourcePlan = {...plan, planKind: "configuration-only", packs: [],
      resourceOps: [{kind: "resource_put", path: "mdbase.yaml", doc, mustNotExist: true}], resourceReadback: [{path: "mdbase.yaml", doc}]};
    vi.mocked(f.port.apply).mockImplementation(async () => {f.status("current"); return configPlan;});
    const helper = createApplicationConfiguration({...f.input, compiledManifest}, f.port);
    try {
      expect((await helper.configure()).assessment?.status).toBe("ready");
      const intent = await f.journal.load(f.controller.signal);
      expect(intent?.phase).toBe("verified");
      if (!intent || intent.version < 3) throw Error("expected original resource intent");
      expect("plan" in intent && intent.plan).toEqual(configPlan);
    } finally {await helper.close(); await f.close();}
  });
  it("inspect assessment never prepares or submits, even when setup is required", async () => {
    const f = await fixture(); f.status("provision");
    const submit = vi.spyOn(f.client, "submit");
    try {
      expect((await f.helper.assess()).assessment?.status).toBe("setup_required");
      expect(f.port.apply).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
      expect(await f.journal.load(f.controller.signal)).toBeNull();
    } finally { await f.close(); }
  });
  it("conflict is scoped incompatible evidence, not success or a mutation attempt", async () => {
    const f = await fixture(); f.status("conflict");
    try { expect((await f.helper.configure()).assessment?.status).toBe("incompatible"); expect(f.port.apply).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });
  it.each(["inspect", "approved-new"] as const)("%s journals the original MID before ordinary submit and exact readback", async mode => {
    const f = await fixture(mode); f.status("provision");
    const originalSubmit = f.client.submit.bind(f.client);
    const submit = vi.spyOn(f.client, "submit").mockImplementation(async (ops, options) => {
      const intent = await f.journal.load(f.controller.signal);
      expect(intent?.phase).toBe("attempted"); expect(intent?.mutationId).toBe(options?.mutationId);
      expect(ops).toEqual(plan.resourceOps);
      return originalSubmit(ops, options);
    });
    try {
      expect((await (mode === "inspect" ? f.helper.configure() : f.helper.assess())).assessment?.status).toBe("ready");
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await f.journal.load(f.controller.signal))?.phase).toBe("verified");
    } finally { await f.close(); }
  });
  it.each(["inspect", "approved-new"] as const)("%s does not treat mode/explicit configure as declaration authority", async mode => {
    const f = await fixture(mode, false); f.status("provision"); const submit = vi.spyOn(f.client, "submit");
    try {
      await expect(f.helper.configure()).rejects.toMatchObject({ reason: "configuration_not_authorized" });
      expect(submit).not.toHaveBeenCalled(); expect(await f.journal.load(f.controller.signal)).toBeNull();
    } finally { await f.close(); }
  });
  it("reconcile-original cannot create a new intent", async () => {
    const f = await fixture("reconcile-original"); f.status("provision");
    try { await expect(f.helper.configure()).rejects.toMatchObject({ reason: "configuration_recovery_required" }); expect(f.port.apply).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });
  it("original prepared intent is retained and never reminted/submitted by configure", async () => {
    const f = await fixture(); const original = await f.journal.prepareResources(plan, f.controller.signal);
    const submit = vi.spyOn(f.client, "submit"); f.status("provision");
    try {
      await expect(f.helper.configure()).rejects.toMatchObject({ reason: "configuration_recovery_required" });
      expect(submit).not.toHaveBeenCalled(); expect(await f.journal.load(f.controller.signal)).toEqual(original);
    } finally { await f.close(); }
  });
  it.each(["attempted", "confirmed"] as const)("%s recovery uses only original receipt/readback and no resubmit", async phase => {
    const f = await fixture("reconcile-original"); const prepared = await f.journal.prepareResources(plan, f.controller.signal);
    await f.journal.recordResourceAttempt(prepared.mutationId, f.controller.signal);
    const writes = await f.client.submit([...plan.resourceOps], { mutationId: prepared.mutationId, wait: "confirmed" });
    await writes[0]!.confirmed;
    if (phase === "confirmed") await f.journal.recordResourceConfirmed(prepared.mutationId, f.controller.signal);
    const submit = vi.spyOn(f.client, "submit");
    try {
      expect((await f.helper.assess()).assessment?.status).toBe("ready");
      expect(submit).not.toHaveBeenCalled(); expect(f.port.apply).not.toHaveBeenCalled();
      expect((await f.journal.load(f.controller.signal))?.mutationId).toBe(prepared.mutationId);
      expect((await f.journal.load(f.controller.signal))?.phase).toBe("verified");
    } finally { await f.close(); }
  });
  it("changed source readback keeps the original confirmed journal and refuses readiness", async () => {
    const f = await fixture("reconcile-original"); const original = await f.journal.prepareResources(plan, f.controller.signal);
    await f.journal.recordResourceAttempt(original.mutationId, f.controller.signal);
    await f.client.submit([...plan.resourceOps], { mutationId: original.mutationId, wait: "confirmed" });
    await f.journal.recordResourceConfirmed(original.mutationId, f.controller.signal);
    f.replica.seedResource(plan.resourceReadback[0]!.path, "changed");
    try { await expect(f.helper.assess()).rejects.toMatchObject({ reason: "configuration_recovery_required" }); expect((await f.journal.load(f.controller.signal))?.phase).toBe("confirmed"); }
    finally { await f.close(); }
  });
  it("legacy v1 is never converted, replaced or submitted", async () => {
    const f = await fixture();
    const legacy = { version: 1 as const, scope: f.input.scope, mutationId: generation, phase: "prepared" as const,
      ops: [{ kind: "resource_put", path: "_contracts/task.md", doc: "legacy", mustNotExist: true },
        { kind: "resource_put", path: "_types/task.md", doc: "legacy", mustNotExist: true }] as const };
    vi.spyOn(f.journal, "load").mockResolvedValue(legacy);
    const submit = vi.spyOn(f.client, "submit"), prepare = vi.spyOn(f.journal, "prepareResources");
    try {
      await expect(f.helper.configure()).rejects.toMatchObject({ reason: "configuration_recovery_required" });
      expect(submit).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(f.port.apply).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("unknown original receipt preserves attempted intent without reminting", async () => {
    const f = await fixture(); const original = await f.journal.prepareResources(plan, f.controller.signal);
    const attempted = await f.journal.recordResourceAttempt(original.mutationId, f.controller.signal);
    vi.spyOn(f.client, "awaitReceipt").mockRejectedValue(new Error("original outcome unknown"));
    const submit = vi.spyOn(f.client, "submit");
    try {
      await expect(f.helper.configure()).rejects.toThrow("original outcome unknown");
      expect(submit).not.toHaveBeenCalled(); expect(f.port.apply).not.toHaveBeenCalled();
      expect(await f.journal.load(f.controller.signal)).toEqual(attempted);
    } finally { await f.close(); }
  });
  it("resources-only plan DATA does not prove absence or authorize new source records", async () => {
    const f = await fixture(); f.status("provision");
    vi.mocked(f.port.apply).mockResolvedValue({ ...plan, sources: [{ id: generation, path: "Views/example.base", document: "views: []\n" }] });
    const submit = vi.spyOn(f.client, "submit");
    try {
      await expect(f.helper.configure()).rejects.toMatchObject({ reason: "configuration_unsupported_source_provision" });
      expect(submit).not.toHaveBeenCalled(); expect(await f.journal.load(f.controller.signal)).toBeNull();
    } finally { await f.close(); }
  });
  it("retirement verifies complete native resource inventory under its original MID, never get-not-found or file absence", async () => {
    const f = await retirementFixture(); f.status("provision");
    const get = vi.spyOn(f.client.resources, "get"), list = vi.spyOn(f.client.resources, "list"), submit = vi.spyOn(f.client, "submit");
    try {
      expect((await f.helper.configure()).assessment?.status).toBe("ready");
      const intent = await f.journal.load(f.controller.signal);
      expect(intent?.phase).toBe("verified"); expect(submit).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({text: false, limit: 128}));
      expect(get).not.toHaveBeenCalled();
      expect(submit.mock.calls[0]?.[1]?.mutationId).toBe(intent?.mutationId);
    } finally {await f.close();}
  });
  it("partial inventory cannot verify retirement; a reappeared target retains the original confirmed intent without resubmit", async () => {
    const f = await retainedRetirement(), held = deferred<ListResourcesResult>();
    const list = vi.spyOn(f.client.resources, "list").mockResolvedValueOnce({resources: [metadata("_types/other.md")], complete: false, cursor: "original-cursor"}).mockReturnValueOnce(held.promise);
    const submit = vi.spyOn(f.client, "submit"), work = f.helper.assess();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(f.helper.getSnapshot().assessment).toBeNull(); expect((await f.journal.load(f.controller.signal))?.phase).toBe("confirmed");
    held.resolve({resources: [metadata("_types/task.md")], complete: true});
    try {
      await expect(work).rejects.toMatchObject({reason: "configuration_recovery_required"});
      expect(list.mock.calls[1]?.[0]?.cursor).toBe("original-cursor"); expect(submit).not.toHaveBeenCalled();
      const original = await f.journal.load(f.controller.signal); expect(original?.phase).toBe("confirmed"); expect(original?.mutationId).toBe(f.prepared.mutationId);
    } finally {await f.close();}
  });
  it("stale native cursor refuses rather than restarting or replaying; post-await scope loss also fences", async () => {
    const f = await retainedRetirement();
    const list = vi.spyOn(f.client.resources, "list").mockResolvedValueOnce({resources: [metadata("_types/other.md")], complete: false, cursor: "original-cursor"})
      .mockRejectedValueOnce(mdbaseError("unavailable", "native inventory changed", "cursor_stale"));
    const submit = vi.spyOn(f.client, "submit");
    try {
      await expect(f.helper.assess()).rejects.toMatchObject({reason: "cursor_stale"}); expect(list).toHaveBeenCalledTimes(2);
      expect((await f.journal.load(f.controller.signal))?.phase).toBe("confirmed"); expect(submit).not.toHaveBeenCalled();
      const held = deferred<ListResourcesResult>(); list.mockReturnValueOnce(held.promise);
      const work = f.helper.assess(); await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      f.stale(); held.resolve({resources: [], complete: true});
      await expect(work).rejects.toMatchObject({reason: "configuration_fenced"}); expect(f.helper.getSnapshot().assessment).toBeNull();
      expect(submit).not.toHaveBeenCalled();
    } finally {await f.close();}
  });
  it("request abort does not free a held producer slot or permit a successor", async () => {
    const f = await fixture(); const hold = deferred<{ status: "current"; assessmentDigest: string }>();
    vi.mocked(f.port.assess).mockReturnValue(hold.promise);
    const request = new AbortController(), work = f.helper.assess({ signal: request.signal });
    await vi.waitFor(() => expect(f.port.assess).toHaveBeenCalled()); request.abort();
    try {
      await expect(f.helper.assess()).rejects.toMatchObject({ reason: "configuration_busy" });
      hold.resolve({ status: "current", assessmentDigest: digest });
      await expect(work).rejects.toThrow(); expect(f.helper.getSnapshot().assessment).toBeNull();
    } finally { await f.close(); }
  });
  it("one operation slot stays occupied through a genuinely held producer promise", async () => {
    const f = await fixture(); const hold = deferred<{ status: "current"; assessmentDigest: string }>();
    vi.mocked(f.port.assess).mockReturnValue(hold.promise);
    const work = f.helper.assess(); await vi.waitFor(() => expect(f.port.assess).toHaveBeenCalled());
    try {
      await expect(f.helper.configure()).rejects.toMatchObject({ reason: "configuration_busy" });
      const stopped = f.helper.close(); expect(f.helper.close()).toBe(stopped);
      let settled = false; void stopped.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      hold.resolve({ status: "current", assessmentDigest: digest });
      await expect(work).rejects.toThrow(); await expect(stopped).rejects.toThrow();
      expect(f.helper.close()).toBe(stopped); expect(f.helper.getSnapshot().assessment).toBeNull();
    } finally { await f.close(); }
  });
  it("currentness after await and immediately before delivery is mandatory", async () => {
    const f = await fixture(); const hold = deferred<{ status: "current"; assessmentDigest: string }>();
    vi.mocked(f.port.assess).mockReturnValue(hold.promise);
    const work = f.helper.assess(); await vi.waitFor(() => expect(f.port.assess).toHaveBeenCalled());
    f.stale(); hold.resolve({ status: "current", assessmentDigest: digest });
    try { await expect(work).rejects.toMatchObject({ reason: "configuration_fenced" }); expect(f.helper.getSnapshot().assessment).toBeNull(); }
    finally { await f.close(); }
  });
  it("subscriber reentrancy cannot deliver a ready facet after retirement", async () => {
    const f = await fixture(); const stop = f.helper.subscribe(() => { if (f.helper.getSnapshot().assessment) f.stale(); });
    try { await expect(f.helper.assess()).rejects.toMatchObject({ reason: "configuration_fenced" }); expect(f.helper.getSnapshot().assessment).toBeNull(); }
    finally { stop(); await f.close(); }
  });
});

describe("reviewable setup plan/apply", () => {
  const target = "_types/task.md", adopted = `sha256:${"ef".repeat(32)}`;
  const welcome = "---\ntitle: Welcome\n---\nStart here.\n";
  // Stand-in for native Core: an unmanaged task type conflicts until adopted.
  let live = `sha256:${"cd".repeat(32)}`;
  function reviewing(f: Awaited<ReturnType<typeof fixture>>) {
    vi.mocked(f.port.assess).mockImplementation(async (_manifest, _signal, decisions) => {
      const adopt = decisions?.adopt?.[target] === live, done = vi.mocked(f.port.apply).mock.calls.length > 0;
      const status = done ? "current" as const : adopt ? "provision" as const : "conflict" as const;
      const assessmentDigest = adopt ? adopted : digest;
      if (!decisions) return { status, assessmentDigest };
      return { status, assessmentDigest, review: { configuration: [], staged: adopt ? [{ path: target, document: "Synthetic resource" }] : [],
        packs: [{ id: "org.example.task", version: "1.0.0", status: done ? "current" as const : "install" as const, installedVersion: null,
          resources: done ? [] : [{ target, kind: "type", mode: "managed" as const, installed: false, currentDigest: live, action: adopt ? "adopt" as const : "conflict" as const }] }] } };
    });
    vi.mocked(f.port.apply).mockImplementation(async () => ({ ...plan, assessmentDigest: adopted,
      resourceOps: [{ kind: "resource_put", path: target, doc: "Synthetic resource", mustNotExist: false, baseRevision: live }] }));
  }
  it("reviews a conflict, adopts it and writes setup plus free starter records in one mutation", async () => {
    const f = await fixture();
    try {
      f.replica.seedResource(target, "user's own type");
      live = (await f.client.resources.get(target)).revision;
      reviewing(f);
      await (await f.client.create({ path: "Taken.md", body: "mine" })).confirmed;
      const blocked = await f.helper.plan();
      expect(blocked).toMatchObject({ status: "conflict", canApply: false, adoptable: { [target]: live }, refusal: { code: "setup_conflict" } });
      expect(blocked.conflicts[0]!.message).toMatch(/already has a "task" record type/);
      await expect(f.helper.apply(blocked)).rejects.toMatchObject({ reason: "setup_conflict" });
      const reviewed = await f.helper.plan({ adopt: blocked.adoptable, records: [{ path: "Welcome.md", document: welcome }, { path: "Taken.md", document: welcome }] });
      expect(reviewed).toMatchObject({ status: "setup", canApply: true, digest: adopted,
        records: [{ path: "Welcome.md", action: "create" }, { path: "Taken.md", action: "skip" }] });
      expect(reviewed.changes.map(c => c.message)).toEqual(["Replace your existing \"task\" record type with this app's version.", "Create the starter note \"Welcome\"."]);
      expect(f.port.apply).not.toHaveBeenCalled();
      const submit = vi.spyOn(f.client, "submit");
      await f.helper.apply(reviewed);
      expect(f.port.apply).toHaveBeenCalledWith(expect.anything(), adopted, expect.anything(), { adopt: { [target]: live } });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]![0].map(op => op.kind)).toEqual(["resource_put", "create"]);
      expect((await f.client.get({ path: "Welcome.md" }, { body: true })).body).toBe("Start here.\n");
      expect((await f.client.get({ path: "Taken.md" }, { body: true })).body).toBe("mine");
      expect(f.helper.getSnapshot().assessment?.status).toBe("ready");
      expect((await f.journal.load(f.controller.signal))?.phase).toBe("verified");
    } finally { await f.close(); }
  });
  it("refuses a plan whose collection changed after review, without writing", async () => {
    const f = await fixture();
    try {
      reviewing(f);
      const reviewed = await f.helper.plan({ adopt: { [target]: live } });
      vi.mocked(f.port.assess).mockResolvedValue({ status: "provision", assessmentDigest: `sha256:${"01".repeat(32)}` });
      const submit = vi.spyOn(f.client, "submit");
      await expect(f.helper.apply(reviewed)).rejects.toMatchObject({ code: "conflict", reason: "setup_changed" });
      expect(submit).not.toHaveBeenCalled();
      expect(await f.journal.load(f.controller.signal)).toBeNull();
    } finally { await f.close(); }
  });
  it("treats native refusal of a reviewed adoption (deleted, changed or not adoptable) as setup_changed", async () => {
    const f = await fixture();
    try {
      reviewing(f);
      const reviewed = await f.helper.plan({ adopt: { [target]: live } });
      const refused = mdbaseError("unavailable", "resource setup unavailable", "resource_setup_unavailable");
      vi.mocked(f.port.assess).mockRejectedValue(refused);
      const submit = vi.spyOn(f.client, "submit");
      await expect(f.helper.apply(reviewed)).rejects.toMatchObject({ code: "conflict", reason: "setup_changed" });
      await expect(f.helper.plan({ adopt: { [target]: live } })).rejects.toMatchObject({ code: "conflict", reason: "setup_changed" });
      // Without decisions the same refusal is not dressed up as a stale review.
      await expect(f.helper.plan()).rejects.toMatchObject({ reason: "resource_setup_unavailable" });
      expect(submit).not.toHaveBeenCalled();
      expect(await f.journal.load(f.controller.signal)).toBeNull();
    } finally { await f.close(); }
  });
  it("settles a rejected setup mutation so a fresh plan can apply", async () => {
    const f = await fixture();
    try {
      reviewing(f);
      vi.mocked(f.port.apply).mockImplementation(async () => ({ ...plan, assessmentDigest: adopted }));
      const reviewed = await f.helper.plan({ adopt: { [target]: live } });
      // The definition appears after review: native refuses the whole mutation.
      f.replica.seedResource(target, "raced");
      const rejected = await f.helper.apply(reviewed).catch((error: unknown) => error);
      expect(rejected).toMatchObject({ code: "conflict", reason: "setup_changed" });
      const settled = await f.journal.load(f.controller.signal);
      expect(settled).toMatchObject({ phase: "rejected", mutationId: (rejected as { mutationId: string }).mutationId });
      const raced = (await f.client.resources.get(target)).revision;
      vi.mocked(f.port.apply).mockClear().mockImplementation(async () => ({ ...plan, assessmentDigest: adopted,
        resourceOps: [{ kind: "resource_put", path: target, doc: "Synthetic resource", mustNotExist: false, baseRevision: raced }] }));
      await f.helper.apply(await f.helper.plan({ adopt: { [target]: live } }));
      const verified = await f.journal.load(f.controller.signal);
      expect(verified).toMatchObject({ phase: "verified" });
      expect(verified!.mutationId).not.toBe(settled!.mutationId);
    } finally { await f.close(); }
  });
});
