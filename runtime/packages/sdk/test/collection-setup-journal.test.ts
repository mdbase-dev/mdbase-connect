// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPackPlan } from "../src/app-host/collection-setup-types.js";
import { decode, AppCollectionSetupJournal } from "../src/app-host/collection-setup-journal.js";
const scope = {
  account: "11111111-1111-4111-8111-111111111111",
  installation: "22222222-2222-4222-8222-222222222222",
  collection: "33333333-3333-4333-8333-333333333333",
};
const appOrigin = "http://127.0.0.1:48319",
  cpOrigin = "https://connect-lab.mdbase.dev";
const puts = [
  {
    kind: "resource_put" as const,
    path: "_contracts/tasknotes.task.md",
    doc: "Synthetic inline contract definition",
    mustNotExist: true,
  },
  {
    kind: "resource_put" as const,
    path: "_types/task.md",
    doc: "Synthetic inline implementing type",
    mustNotExist: true,
  },
];
const plan: ModelPackPlan = {
  pack: {
    id: "tasknotes.task",
    version: "0.3.0-rc.18",
    digest: "sha256:" + "ab".repeat(32),
  },
  assessmentDigest: "sha256:" + "cd".repeat(32),
  ops: puts,
  readback: puts.map(({ path, doc }) => ({ path, doc })),
};
const signal = () => new AbortController().signal;
const journal = (bound = scope, isCurrent = () => true) =>
  new AppCollectionSetupJournal({
    databaseName: "tasknotes.native-model-setup.v1",
    applicationNamespace: "tasknotes-web",
    scope: bound,
    appOrigin,
    cpOrigin,
    isCurrent,
  });
const namespace = (bound = scope) =>
  JSON.stringify([
    appOrigin,
    cpOrigin,
    "tasknotes-web",
    bound.account,
    bound.installation,
    bound.collection,
  ]);
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tasknotes.native-model-setup.v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function row(key = namespace()) {
  const db = await database();
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const tx = db.transaction("original-model-operation", "readonly"),
        request = tx.objectStore("original-model-operation").get(key);
      tx.oncomplete = () => resolve(request.result as Record<string, unknown>);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
async function replace(value: unknown, key = namespace()) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("original-model-operation", "readwrite");
      tx.objectStore("original-model-operation").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
// IDB/WebCrypto stand-ins only: not native model write/receipt/READ/LAB proof.
describe("fixed protected model pack setup intent", () => {
  it("commits one immutable original plan/UUID, recovers every monotonic phase, and exposes no reset", async () => {
    const store = journal();
    expect(await store.load(signal())).toBeNull();
    const original = await store.prepare(plan, signal());
    expect(original.version).toBe(2);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.plan)).toBe(true);
    expect(Object.isFrozen(original.plan.pack)).toBe(true);
    expect(Object.isFrozen(original.plan.ops[0])).toBe(true);
    expect(Object.isFrozen(original.plan.readback[0])).toBe(true);
    expect(await journal().prepare(plan, signal())).toEqual(original);
    const attempted = await store.recordAttempt(original.mutationId, signal());
    expect(await journal().load(signal())).toEqual(attempted);
    expect(await store.recordAttempt(original.mutationId, signal())).toEqual(
      attempted,
    );
    await store.recordConfirmed(original.mutationId, signal());
    const verified = await store.recordVerified(original.mutationId, signal());
    expect(verified).toEqual({ ...original, phase: "verified" });
    expect(await journal().load(signal())).toEqual(verified);
    expect(await journal().prepare(plan, signal())).toEqual(verified);
    expect("remove" in store).toBe(false);
  });
  it("keeps a nonextractable origin key and ciphertext, not plaintext definitions", async () => {
    await journal().prepare(plan, signal());
    const stored = await row();
    const key = stored.key as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    expect(JSON.stringify(stored)).not.toContain(puts[0]!.doc);
    expect(stored.version).toBe(1); // Existing envelope and AAD, new plaintext only.
    expect(stored.ciphertext).toBeInstanceOf(ArrayBuffer);
  });
  it("refuses unknown original database schema without creating an alias, key or replacement operation", async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tasknotes.native-model-setup.v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("unknown-original-store");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); const key = vi.spyOn(crypto.subtle, "generateKey"), uuid = vi.spyOn(crypto, "randomUUID");
    await expect(journal().load(signal())).rejects.toMatchObject({reason: "recovery_required"});
    expect(key).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled();
    const original = await database(); expect(original.objectStoreNames.length).toBe(1); expect(original.objectStoreNames.item(0)).toBe("unknown-original-store"); original.close();
  });
  it.each(["databaseName"] as const)("fences changed BUILD %s without aliasing the original ciphertext", async field => {
    const owner = {databaseName: "tasknotes.native-model-setup.v1", applicationNamespace: "tasknotes-web", scope, appOrigin, cpOrigin, isCurrent: () => true};
    const store = new AppCollectionSetupJournal(owner); const original = await store.prepare(plan, signal()); const before = await row();
    owner[field] = field.endsWith("Origin") ? "https://replacement.example.test" : "replacement";
    await expect(store.load(signal())).rejects.toMatchObject({reason: "fenced"});
    expect(await row()).toEqual(before); expect(await journal().load(signal())).toEqual(original); store.close();
  });
  it("copies the entire exact plan before the first await", async () => {
    const mutable = structuredClone(plan);
    const prepare = journal().prepare(mutable, signal());
    (mutable.ops[0] as { doc: string }).doc = "Caller mutation";
    (mutable.readback[0] as { doc: string }).doc = "Caller readback mutation";
    (mutable.pack as { version: string }).version = "Changed";
    expect((await prepare).plan).toEqual(plan);
  });
  it("does not replace original operations or readback after an attempted/lost reply", async () => {
    const store = journal(),
      original = await store.prepare(plan, signal());
    await store.recordAttempt(original.mutationId, signal());
    await expect(
      journal().prepare(
        { ...plan, assessmentDigest: "sha256:" + "ef".repeat(32) },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "binding" });
    await expect(
      journal().prepare(
        {
          ...plan,
          readback: [
            ...plan.readback,
            { path: "_types/preserved.md", doc: "Different preserved seed" },
          ],
        },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "binding" });
    expect((await journal().load(signal()))!.mutationId).toBe(
      original.mutationId,
    );
  });
  it("refuses mismatched IDs, skipped phases, regressions and missing recovery", async () => {
    const store = journal();
    await expect(
      store.recordAttempt(scope.collection, signal()),
    ).rejects.toMatchObject({ reason: "recovery_required" });
    const original = await store.prepare(plan, signal());
    await expect(
      store.recordAttempt(scope.collection, signal()),
    ).rejects.toMatchObject({ reason: "binding" });
    await expect(
      store.recordConfirmed(original.mutationId, signal()),
    ).rejects.toMatchObject({ reason: "recovery_required" });
    await store.recordAttempt(original.mutationId, signal());
    await store.recordConfirmed(original.mutationId, signal());
    await expect(
      store.recordAttempt(original.mutationId, signal()),
    ).rejects.toMatchObject({ reason: "recovery_required" });
  });
  it("binds ciphertext to the original collection and preserves an unreadable record", async () => {
    await journal().prepare(plan, signal());
    const stored = await row();
    const other = {
      ...scope,
      collection: "44444444-4444-4444-8444-444444444444",
    };
    await replace(stored, namespace(other));
    await expect(journal(other).load(signal())).rejects.toMatchObject({
      reason: "recovery_required",
    });
    await expect(journal(other).prepare(plan, signal())).rejects.toMatchObject({
      reason: "recovery_required",
    });
    expect((await row(namespace(other))).ciphertext).toEqual(stored.ciphertext);
  });
  it.each(["key", "revision"])(
    "never regenerates missing or corrupt %s",
    async (field) => {
      await journal().prepare(plan, signal());
      const stored = await row();
      if (field === "revision") stored.revision = 2;
      else delete stored[field];
      await replace(stored);
      await expect(journal().prepare(plan, signal())).rejects.toMatchObject({
        reason: "recovery_required",
      });
      expect(await row()).toEqual(stored);
    },
  );
  it("fences owner replacement, closure and abort without committing new intent", async () => {
    let current = true;
    const store = journal(scope, () => current);
    current = false;
    await expect(store.prepare(plan, signal())).rejects.toMatchObject({
      reason: "fenced",
    });
    current = true;
    await expect(store.load(signal())).rejects.toMatchObject({
      reason: "fenced",
    });
    const closed = journal();
    closed.close();
    await expect(closed.load(signal())).rejects.toMatchObject({
      reason: "fenced",
    });
    const owner = new AbortController();
    owner.abort();
    await expect(journal().prepare(plan, owner.signal)).rejects.toThrow();
    expect(await journal().load(signal())).toBeNull();
  });
  it("one strict CAS wins concurrent prepares; the loser fences instead of minting a replacement", async () => {
    let arrivals = 0;
    let both!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      both = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      if (++arrivals === 2) both();
      await gate;
      return encrypt(...args);
    });
    const left = journal(),
      right = journal();
    const pending = [
      left.prepare(plan, signal()),
      right.prepare(plan, signal()),
    ];
    await started;
    release();
    const results = await Promise.allSettled(pending);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const index = results.findIndex((result) => result.status === "rejected");
    expect(results[index]).toMatchObject({
      status: "rejected",
      reason: { reason: "outcome_unknown" },
    });
    await expect([left, right][index]!.load(signal())).rejects.toMatchObject({
      reason: "fenced",
    });
    const winner = results.find((result) => result.status === "fulfilled")!;
    expect(await journal().load(signal())).toEqual(
      winner.status === "fulfilled" ? winner.value : undefined,
    );
  });
  it("permits only a bounded exact guarded plan, refusing empty/no-op preparation and ambiguous readback", async () => {
    for (const invalid of [
      { ...plan, ops: [] },
      { ...plan, ops: [...puts, { ...puts[0], path: "../secrets.md" }] },
      { ...plan, ops: [{ ...puts[0], mustNotExist: undefined }, puts[1]] },
      {
        ...plan,
        readback: [{ ...plan.readback[0], doc: "Different" }, plan.readback[1]],
      },
      { ...plan, readback: [plan.readback[0], plan.readback[0]] },
      {
        ...plan,
        readback: [{ ...plan.readback[0], doc: null }, plan.readback[1]],
      },
      {
        ...plan,
        ops: [{ kind: "resource_delete", path: puts[0]!.path }, puts[1]],
      },
      { ...plan, readback: [plan.readback[1]] },
      { ...plan, ops: [{ ...puts[0], baseRevision: "not-a-digest" }, puts[1]] },
      { ...plan, ops: Array.from({ length: 65 }, () => puts[0]) },
      {
        ...plan,
        readback: Array.from({ length: 129 }, (_, i) => ({
          path: `preserved/${i}.md`,
          doc: "Preserved",
        })),
      },
      { ...plan, ignored: "unknown field" },
    ]) {
      expect(() =>
        journal().prepare(invalid as ModelPackPlan, signal()),
      ).toThrow();
    }
    expect(await journal().load(signal())).toBeNull();
  });
  it("bounds the TOTAL intent including duplicate readback bytes and phase overhead", async () => {
    const document = "x".repeat(256 * 1024 - 220);
    const oversized: ModelPackPlan = {
      ...plan,
      ops: [{ ...puts[0]!, doc: document }],
      readback: [{ path: puts[0]!.path, doc: document }],
    };
    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeLessThan(512 * 1024);
    const uuid = vi.spyOn(crypto, "randomUUID");
    expect(() => journal().prepare(oversized, signal())).toThrow();
    expect(uuid).not.toHaveBeenCalled();
    expect(await journal().load(signal())).toBeNull();
  });
  it.each(["attempted"] as const)(
    "loads but NEVER converts, replaces or advances a legacy %s intent",
    async (phase) => {
      await journal().prepare(plan, signal());
      const stored = await row();
      const legacy = {
        version: 1,
        scope,
        mutationId: "55555555-5555-4555-8555-555555555555",
        ops: puts,
        phase,
      };
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(
            JSON.stringify([namespace(), 1, stored.revision]),
          ),
        },
        stored.key as CryptoKey,
        new TextEncoder().encode(JSON.stringify(legacy)),
      );
      await replace({ ...stored, iv, ciphertext });
      const before = await row();
      expect(await journal().load(signal())).toEqual(legacy);
      await expect(journal().prepare(plan, signal())).rejects.toMatchObject({
        reason: "recovery_required",
      });
      for (const operation of [
        "recordAttempt",
        "recordConfirmed",
        "recordVerified",
      ] as const) {
        await expect(
          journal()[operation](legacy.mutationId, signal()),
        ).rejects.toMatchObject({ reason: "recovery_required" });
      }
      expect(await row()).toEqual(before);
    },
  );
  it("refuses unknown plaintext versions or added intent fields", () => {
    const intent = {
      version: 2,
      scope,
      mutationId: scope.collection,
      plan,
      phase: "prepared",
    };
    expect(() => decode({ ...intent, version: 3 }, scope)).toThrow();
    expect(() =>
      decode({ ...intent, extra: "not understood" }, scope),
    ).toThrow();
  });
});
