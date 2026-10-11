// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelPackPlan,
  ModelResourcePlan,
} from "../src/app-host/collection-setup-types.js";
import {
  decode,
  modelResourcePlan,
  AppCollectionSetupJournal,
} from "../src/app-host/collection-setup-journal.js";

const scope = {
  account: "11111111-1111-4111-8111-111111111111",
  installation: "22222222-2222-4222-8222-222222222222",
  collection: "33333333-3333-4333-8333-333333333333",
};
const hash = "sha256:" + "ab".repeat(32);
const puts = [
  {
    kind: "resource_put" as const,
    path: "_types/task.md",
    doc: "Synthetic resource fixture",
    mustNotExist: true,
  },
];
const plan: ModelResourcePlan = {
  assessmentDigest: hash,
  provisionDigest: hash,
  packs: [
    { id: "tasknotes.task", version: "0.3.0-rc.18", digest: hash },
    { id: "obsidian.base", version: "1.0.0", digest: hash },
  ],
  resourceOps: puts,
  resourceReadback: puts.map(({ path, doc }) => ({ path, doc })),
  sources: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      path: "TaskNotes/Views/today.base",
      document: "views: [{type: tasknotesTaskList}]\n",
    },
  ],
};
const signal = () => new AbortController().signal;
const journal = () =>
  new AppCollectionSetupJournal({
    databaseName: "tasknotes.native-model-setup.v1",
    applicationNamespace: "tasknotes-web",
    scope,
    appOrigin: "http://127.0.0.1:48319",
    cpOrigin: "https://connect-lab.mdbase.dev",
    isCurrent: () => true,
  });
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
// Protected journal/data tests only; NOT native writes/receipt/READ/LAB evidence.
describe("resource setup in the original protected model ledger", () => {
  it("explicit config-only variant has no synthetic pack and retains old encoded plans", async () => {
    const config: ModelResourcePlan = { ...plan, planKind: "configuration-only", packs: [], sources: [],
      resourceOps: [{ kind: "resource_put", path: "mdbase.yaml", doc: "settings: {}\n", mustNotExist: true }],
      resourceReadback: [{ path: "mdbase.yaml", doc: "settings: {}\n" }] };
    const original = await journal().prepareResources(config, signal());
    expect(original.plan).toEqual(config); expect(original.plan.packs).toEqual([]);
    expect(decode(JSON.parse(JSON.stringify(original)), scope)).toEqual(original);
    const oldEncoded = JSON.stringify({ version: 3, scope, mutationId: scope.collection, plan, phase: "prepared" });
    expect(decode(JSON.parse(oldEncoded), scope)).toEqual(JSON.parse(oldEncoded));
    for (const wrong of [
      { ...config, planKind: undefined }, { ...config, packs: plan.packs },
      { ...config, resourceOps: plan.resourceOps, resourceReadback: plan.resourceReadback },
      { ...config, sourcePolicy: "current-only" },
      { ...config, resourceOps: [{ kind: "resource_put", path: "mdbase.yaml", doc: "settings: {}\n", mustNotExist: false }] },
    ]) expect(() => modelResourcePlan(wrong)).toThrow();
    // Starter records may ride along with configuration-only setup.
    expect(modelResourcePlan({ ...config, sources: plan.sources }).sources).toEqual(plan.sources);
  });
  it("captures exact sources/UUIDs/ops before await and recovers monotonic v3 phases", async () => {
    const mutable = structuredClone(plan);
    const pending = journal().prepareResources(mutable, signal());
    (mutable.sources[0] as { id: string }).id = scope.collection;
    (mutable.sources[0] as { document: string }).document = "changed";
    const original = await pending;
    expect(original.version).toBe(3);
    expect(original.plan).toEqual(plan);
    expect(Object.isFrozen(original.plan.sources[0])).toBe(true);
    expect(await journal().prepareResources(plan, signal())).toEqual(original);
    const attempted = await journal().recordResourceAttempt(
      original.mutationId,
      signal(),
    );
    expect(await journal().load(signal())).toEqual(attempted);
    expect(
      await journal().recordResourceAttempt(original.mutationId, signal()),
    ).toEqual(attempted);
    await journal().recordResourceConfirmed(original.mutationId, signal());
    const verified = await journal().recordResourceVerified(
      original.mutationId,
      signal(),
    );
    expect(verified).toEqual({ ...original, phase: "verified" });
    expect(await journal().load(signal())).toEqual(verified);
    expect(await journal().prepareResources(plan, signal())).toEqual(verified);
  });
  it.each(["prepared", "attempted", "confirmed", "verified"] as const)(
    "never appends seeds to existing v2 %s",
    async (phase) => {
      const v2Plan: ModelPackPlan = {
        pack: plan.packs[0]!,
        assessmentDigest: hash,
        ops: puts,
        readback: plan.resourceReadback,
      };
      let original = await journal().prepare(v2Plan, signal());
      if (phase !== "prepared")
        original = await journal().recordAttempt(original.mutationId, signal());
      if (phase === "confirmed" || phase === "verified")
        original = await journal().recordConfirmed(
          original.mutationId,
          signal(),
        );
      if (phase === "verified")
        original = await journal().recordVerified(
          original.mutationId,
          signal(),
        );
      await expect(
        journal().prepareResources(plan, signal()),
      ).rejects.toMatchObject({ reason: "recovery_required" });
      await expect(
        journal().recordResourceAttempt(original.mutationId, signal()),
      ).rejects.toMatchObject({ reason: "recovery_required" });
      expect(await journal().load(signal())).toEqual(original);
      expect(await journal().prepare(v2Plan, signal())).toEqual(original);
    },
  );
  it("retains the original v1 decoder and holds it instead of conversion", () => {
    const value = {
      version: 1,
      scope,
      mutationId: scope.collection,
      phase: "prepared",
      ops: [
        {
          kind: "resource_put",
          path: "_contracts/task.md",
          doc: "legacy",
          mustNotExist: true,
        },
        {
          kind: "resource_put",
          path: "_types/task.md",
          doc: "legacy",
          mustNotExist: true,
        },
      ],
    };
    expect(decode(value, scope)).toEqual(value);
  });
  it("retains original v3 after lost reply and refuses new source bytes/IDs/plan", async () => {
    const original = await journal().prepareResources(plan, signal());
    await journal().recordResourceAttempt(original.mutationId, signal());
    for (const changed of [
      { ...plan, assessmentDigest: "sha256:" + "cd".repeat(32) },
      { ...plan, sources: [{ ...plan.sources[0]!, id: scope.collection }] },
      { ...plan, sources: [{ ...plan.sources[0]!, document: "replacement" }] },
    ])
      await expect(
        journal().prepareResources(changed, signal()),
      ).rejects.toMatchObject({ reason: "binding" });
    expect((await journal().load(signal()))!.mutationId).toBe(
      original.mutationId,
    );
    expect("remove" in journal()).toBe(false);
  });
  it("refuses duplicate paths/UUIDs, unguarded resources and operation/readback mismatch", () => {
    for (const changed of [
      { ...plan, sources: [plan.sources[0]!, plan.sources[0]!] },
      { ...plan, sources: [{ ...plan.sources[0]!, path: puts[0]!.path }] },
      {
        ...plan,
        sources: [
          { ...plan.sources[0]!, id: "00000000-0000-0000-0000-000000000000" },
        ],
      },
      { ...plan, resourceOps: [{ ...puts[0]!, mustNotExist: false }] },
      {
        ...plan,
        resourceReadback: [{ path: puts[0]!.path, doc: "different" }],
      },
    ])
      expect(() => modelResourcePlan(changed)).toThrow();
  });
  it("allows current-only source policy only in a new v4 round with verified history", async () => {
    const current = {
      ...plan,
      sourcePolicy: "current-only" as const,
      sources: [],
    };
    expect(modelResourcePlan(current)).toEqual(current);
    expect(() =>
      modelResourcePlan({ ...current, sourcePolicy: "other" }),
    ).toThrow();
    expect(() =>
      modelResourcePlan({ ...current, sources: plan.sources }),
    ).toThrow();
    const uuid = vi.spyOn(crypto, "randomUUID");
    expect(() => journal().prepareResources(current, signal())).toThrow();
    expect(uuid).not.toHaveBeenCalled();
    const first = await journal().prepareResources(plan, signal());
    for (const phase of ["prepared", "attempted", "confirmed"] as const) {
      expect(() =>
        decode(
          {
            version: 4,
            scope,
            mutationId: scope.collection,
            phase: "prepared",
            plan: current,
            previous: { ...first, phase },
          },
          scope,
        ),
      ).toThrow();
    }
    expect(() => decode({ ...first, plan: current }, scope)).toThrow();
    await journal().recordResourceAttempt(first.mutationId, signal());
    await journal().recordResourceConfirmed(first.mutationId, signal());
    const previous = await journal().recordResourceVerified(
      first.mutationId,
      signal(),
    );
    const next = await journal().prepareResourceRound(
      current,
      previous.mutationId,
      signal(),
    );
    expect(next.previous).toEqual(previous);
    expect(next.previous).not.toHaveProperty("plan.sourcePolicy");
    expect(next.plan.sourcePolicy).toBe("current-only");
    expect(await journal().load(signal())).toEqual(next);
  });
  it("never adds a source policy to an existing unfinished v4 definitions-only plan", async () => {
    const first = await journal().prepareResources(plan, signal());
    await journal().recordResourceAttempt(first.mutationId, signal());
    await journal().recordResourceConfirmed(first.mutationId, signal());
    const previous = await journal().recordResourceVerified(
      first.mutationId,
      signal(),
    );
    const next = await journal().prepareResourceRound(
      { ...plan, sources: [] },
      previous.mutationId,
      signal(),
    );
    expect(next.plan).not.toHaveProperty("sourcePolicy");
    await expect(
      journal().prepareResourceRound(
        { ...next.plan, sourcePolicy: "current-only" },
        next.mutationId,
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "recovery_required" });
    expect(await journal().load(signal())).toEqual(next);
    const attempted = await journal().recordResourceAttempt(
      next.mutationId,
      signal(),
    );
    expect(attempted.plan).toEqual(next.plan);
    expect(attempted.plan).not.toHaveProperty("sourcePolicy");
  });
  it("uses one existing nonextractable key through every v3 phase", async () => {
    const key = vi.spyOn(crypto.subtle, "generateKey");
    const original = await journal().prepareResources(plan, signal());
    await journal().recordResourceAttempt(original.mutationId, signal());
    await journal().recordResourceConfirmed(original.mutationId, signal());
    await journal().recordResourceVerified(original.mutationId, signal());
    expect(key).toHaveBeenCalledTimes(1);
    expect(await journal().load(signal())).toEqual({
      ...original,
      phase: "verified",
    });
  });
  it("refuses v2 mutators on v3, mismatched UUIDs/skipped phases/regressions", async () => {
    const original = await journal().prepareResources(plan, signal());
    await expect(
      journal().recordAttempt(original.mutationId, signal()),
    ).rejects.toMatchObject({ reason: "recovery_required" });
    await expect(
      journal().recordResourceConfirmed(original.mutationId, signal()),
    ).rejects.toMatchObject({ reason: "recovery_required" });
    await expect(
      journal().recordResourceAttempt(scope.collection, signal()),
    ).rejects.toMatchObject({ reason: "binding" });
    await journal().recordResourceAttempt(original.mutationId, signal());
    await journal().recordResourceConfirmed(original.mutationId, signal());
    await expect(
      journal().recordResourceAttempt(original.mutationId, signal()),
    ).rejects.toMatchObject({ reason: "recovery_required" });
  });
  it.each([2, 3] as const)(
    "retains verified v%s unchanged inside a new v4 round and recovers it without a new identity",
    async (version) => {
      const store = journal();
      let previous;
      if (version === 2) {
        const original = await store.prepare(
          {
            pack: plan.packs[0]!,
            assessmentDigest: hash,
            ops: puts,
            readback: plan.resourceReadback,
          },
          signal(),
        );
        await store.recordAttempt(original.mutationId, signal());
        await store.recordConfirmed(original.mutationId, signal());
        previous = await store.recordVerified(original.mutationId, signal());
      } else {
        const original = await store.prepareResources(plan, signal());
        await store.recordResourceAttempt(original.mutationId, signal());
        await store.recordResourceConfirmed(original.mutationId, signal());
        previous = await store.recordResourceVerified(
          original.mutationId,
          signal(),
        );
      }
      const retained = structuredClone(previous);
      const next = await store.prepareResourceRound(
        { ...plan, sources: [] },
        previous.mutationId,
        signal(),
      );
      expect(next.version).toBe(4);
      expect(next.mutationId).not.toBe(previous.mutationId);
      expect(next.previous).toEqual(retained);
      expect(Object.isFrozen(next.previous)).toBe(true);
      expect(await journal().load(signal())).toEqual(next);
      await journal().recordResourceAttempt(next.mutationId, signal());
      await journal().recordResourceConfirmed(next.mutationId, signal());
      const verified = await journal().recordResourceVerified(
        next.mutationId,
        signal(),
      );
      expect(verified).toEqual({ ...next, phase: "verified" });
      expect(verified.version === 4 && verified.previous).toEqual(retained);
      await expect(
        journal().recordResourceAttempt(previous.mutationId, signal()),
      ).rejects.toMatchObject({ reason: "binding" });
    },
  );
  it.each(["prepared", "attempted", "confirmed"] as const)(
    "refuses a new round while v3 is %s",
    async (phase) => {
      const original = await journal().prepareResources(plan, signal());
      if (phase !== "prepared")
        await journal().recordResourceAttempt(original.mutationId, signal());
      if (phase === "confirmed")
        await journal().recordResourceConfirmed(original.mutationId, signal());
      const before = await journal().load(signal());
      await expect(
        journal().prepareResourceRound(plan, original.mutationId, signal()),
      ).rejects.toMatchObject({ reason: "recovery_required" });
      expect(await journal().load(signal())).toEqual(before);
    },
  );
  it("rejects cross-scope/unverified ancestors, re-used mutation IDs and destructive additive plans", () => {
    const previous = {
      version: 3,
      scope,
      mutationId: scope.collection,
      plan,
      phase: "verified",
    };
    const round = {
      version: 4,
      scope,
      mutationId: scope.account,
      plan,
      previous,
      phase: "prepared",
    };
    expect(decode(round, scope)).toEqual(round);
    for (const invalid of [
      { ...round, previous: { ...previous, phase: "attempted" } },
      {
        ...round,
        previous: {
          ...previous,
          scope: { ...scope, collection: scope.account },
        },
      },
      { ...round, mutationId: previous.mutationId },
      {
        ...round,
        plan: {
          ...plan,
          resourceOps: [
            { ...puts[0]!, mustNotExist: false, baseRevision: hash },
          ],
        },
      },
    ])
      expect(() => decode(invalid, scope)).toThrow();
  });
  it("preserves verified v1 bytes in a new round and bounds retained history", () => {
    const previous = {
      version: 1,
      scope,
      mutationId: scope.collection,
      phase: "verified",
      ops: [
        {
          kind: "resource_put",
          path: "_contracts/task.md",
          doc: "legacy contract\n",
          mustNotExist: true,
        },
        {
          kind: "resource_put",
          path: "_types/task.md",
          doc: "legacy type\n",
          mustNotExist: true,
        },
      ],
    };
    const value = {
      version: 4,
      scope,
      mutationId: scope.account,
      phase: "verified",
      plan,
      previous,
    };
    expect(decode(value, scope)).toEqual(value);
    let history = decode(value, scope);
    for (let i = 0; i < 7; i++)
      history = decode(
        { ...value, mutationId: crypto.randomUUID(), previous: history },
        scope,
      );
    expect(() =>
      decode(
        { ...value, mutationId: crypto.randomUUID(), previous: history },
        scope,
      ),
    ).toThrow();
  });
  it("strict CAS permits only one concurrent v3 prepare and fences the loser", async () => {
    let arrivals = 0;
    let started!: () => void, release!: () => void;
    const both = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      if (++arrivals === 2) started();
      await gate;
      return encrypt(...args);
    });
    const stores = [journal(), journal()];
    const pending = stores.map((store) =>
      store.prepareResources(plan, signal()),
    );
    await both;
    release();
    const results = await Promise.allSettled(pending);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.findIndex((r) => r.status === "rejected");
    expect(results[loser]).toMatchObject({
      status: "rejected",
      reason: { reason: "outcome_unknown" },
    });
    await expect(stores[loser]!.load(signal())).rejects.toMatchObject({
      reason: "fenced",
    });
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled")
      throw new Error("missing original CAS winner");
    expect(await journal().load(signal())).toEqual(winner.value);
  });
  it("refuses total plaintext/operation bounds and caller-created authority fields", async () => {
    expect(() =>
      journal().prepareResources(
        {
          ...plan,
          sources: [{ ...plan.sources[0]!, document: "x".repeat(512 * 1024) }],
        },
        signal(),
      ),
    ).toThrow();
    expect(() =>
      modelResourcePlan({ ...plan, resourceOps: Array(65).fill(puts[0]) }),
    ).toThrow();
    expect(() =>
      modelResourcePlan({ ...plan, collectionRevision: hash }),
    ).toThrow();
    expect(await journal().load(signal())).toBeNull();
  });
});
