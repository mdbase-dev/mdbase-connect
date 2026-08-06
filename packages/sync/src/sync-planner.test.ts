import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { normalizeSelectiveSyncPolicy } from "./mirror-files.js";
import { portableMirrorRuntime } from "./mirror-state.js";
import type { InspectionSummary, InspectedObject } from "./sync-inspection-model.js";
import {
  MIRROR_ENGINE_PROFILE,
  MIRROR_PLANNER_POLICY,
  MIRROR_PROJECTION_POLICY,
  type ExpectedObjectState,
  type SyncObjectRef
} from "./sync-model.js";
import { planReconciliation } from "./sync-planner.js";
import { PlanOnlyMirrorInspector } from "./sync-inspector.js";
import { PlanOnlySyncExecutor } from "./sync-executor.js";
import { prepareSyncBatch } from "./sync-journal.js";
import { advanceSyncCheckpoint } from "./sync-checkpoint.js";
import { MemoryAuthority } from "./memory-authority.js";
import type { MirrorFileSystem } from "./mirror-state.js";

class InspectorFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async read(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async write(path: string, value: string): Promise<void> { this.files.set(path, value); }
  async move(source: string, target: string): Promise<void> {
    const value = this.files.get(source);
    if (value === undefined) throw new Error("missing source");
    this.files.set(target, value);
    this.files.delete(source);
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.endsWith(".md") && !excluded.has(path));
  }
  async inspectBinary(): Promise<null> { return null; }
  async writeBinary(): Promise<void> { throw new Error("unused"); }
}

const digest = portableMirrorRuntime.digest;

function ref(identity: string, path: string, document: string): SyncObjectRef {
  return {
    entity: "record",
    identity,
    path,
    revision: `sha256:${digest(document)}`,
    payload_revision: `sha256:${digest(document)}`
  };
}

function exact(object: SyncObjectRef): ExpectedObjectState {
  return { state: "exact", object };
}

function summary(objects: InspectedObject[]): InspectionSummary {
  return {
    boundary: {
      engine_profile: MIRROR_ENGINE_PROFILE,
      protocol_profile: "exact_document_v1",
      planner_policy: MIRROR_PLANNER_POLICY,
      projection_policy: MIRROR_PROJECTION_POLICY,
      replica_id: "11111111-1111-4111-8111-111111111111",
      scope_epoch: 7,
      authority_cursor: 19,
      checkpoint: { generation: 3, cursor: 11 },
      selective_sync_fingerprint: `sha256:${"a".repeat(64)}`
    },
    mode: "read_write",
    kind: "incremental",
    selective_sync: normalizeSelectiveSyncPolicy(),
    objects,
    issues: []
  };
}

function inspected(
  identity: string,
  base: ExpectedObjectState,
  local: ExpectedObjectState,
  remote: ExpectedObjectState
): InspectedObject {
  return {
    entity: "record",
    identity,
    base,
    local,
    remote,
    local_target_owner: local,
    remote_target_owner: remote
  };
}

describe("pure exact-document planner", () => {
  it("emits a stable empty plan for an exact incremental inspection", () => {
    const idle = summary([]);
    idle.boundary.authority_cursor = idle.boundary.checkpoint.cursor!;

    const first = planReconciliation(idle, digest);
    const second = planReconciliation(structuredClone(idle), digest);

    expect(first.actions).toEqual([]);
    expect(first.summary).toEqual({
      uploads: 0,
      downloads: 0,
      conflicts: 0,
      blocking_issues: 0
    });
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("checkpoints a cursor advance even when projection filters every effect", () => {
    const plan = planReconciliation(summary([]), digest);

    expect(plan.actions).toEqual([
      expect.objectContaining({
        command: "advance_checkpoint",
        expected: { generation: 3, cursor: 11 },
        next: { generation: 4, cursor: 19 }
      })
    ]);
  });

  it("matches the shared cross-runtime canonical plan fixture", async () => {
    const identity = "22222222-2222-4222-8222-222222222222";
    const base = ref(identity, "notes/parity.md", "base");
    const local = ref(identity, "notes/parity.md", "local");
    const plan = planReconciliation(summary([
      inspected(identity, exact(base), exact(local), exact(base))
    ]), digest);
    const expected = JSON.parse(await readFile(
      new URL("../../../test-fixtures/sync-plan-parity.json", import.meta.url),
      "utf8"
    ));
    expect({
      action_ids: plan.actions.map((action) => action.action_id),
      fingerprint: plan.fingerprint
    }).toEqual(expected);
  });
  it("keeps inspection I/O separate from the pure plan", async () => {
    const authority = new MemoryAuthority();
    authority.seed([{
      record_id: "remote",
      path: "remote.md",
      document: "remote exact bytes\r\n",
      frontmatter: {},
      body: "remote exact bytes\r\n",
      types: []
    }]);
    const replicaId = authority.registerReplica({ name: "plan-only", mode: "read_write" });
    const fileSystem = new InspectorFileSystem();
    fileSystem.files.set("local.md", "local exact bytes  \n");
    const inspection = await new PlanOnlyMirrorInspector(
      replicaId,
      authority.transport(replicaId),
      "read_write",
      fileSystem,
      undefined,
      normalizeSelectiveSyncPolicy(),
      portableMirrorRuntime,
      async () => null,
      async () => { throw new Error("unused"); }
    ).inspect();

    expect(inspection.plan.actions.map((action) => action.command)).toEqual([
      "put_remote",
      "write_local",
      "advance_checkpoint"
    ]);
    expect(inspection.durable_payloads.documents).toHaveProperty(
      inspection.plan.actions[0]!.action_id,
      "local exact bytes  \n"
    );
    expect(inspection.durable_payloads.records).toHaveProperty(
      inspection.plan.actions[1]!.action_id
    );
    expect(fileSystem.files.get("remote.md")).toBeUndefined();
  });

  it("journals, executes only bound commands, and checkpoints afterward", async () => {
    const authority = new MemoryAuthority();
    authority.seed([{
      record_id: "remote",
      path: "remote.md",
      document: "remote bytes",
      frontmatter: {},
      body: "remote bytes",
      types: []
    }]);
    const replicaId = authority.registerReplica({ name: "executor", mode: "read_write" });
    const fileSystem = new InspectorFileSystem();
    fileSystem.files.set("local.md", "local bytes");
    const stateStore = new (await import("./memory-mirror-state.js")).MemoryMirrorStateStore();
    const inspection = await new PlanOnlyMirrorInspector(
      replicaId,
      authority.transport(replicaId),
      "read_write",
      fileSystem,
      undefined,
      normalizeSelectiveSyncPolicy(),
      portableMirrorRuntime,
      () => stateStore.read(),
      async () => { throw new Error("unused"); }
    ).inspect();
    const state = await prepareSyncBatch(
      null,
      inspection.plan,
      inspection.durable_payloads,
      stateStore
    );
    expect((await stateStore.read())?.batch?.phase).toBe("prepared");
    expect((await stateStore.read())?.cursor).toBe(0);

    const result = await new PlanOnlySyncExecutor({
      transport: authority.transport(replicaId),
      fileSystem,
      runtime: portableMirrorRuntime,
      mode: "read_write",
      store: stateStore
    }).execute(state);

    expect(result.status).toBe("effects_complete");
    expect((await stateStore.read())?.batch?.phase).toBe("effects_complete");
    expect((await stateStore.read())?.cursor).toBe(0);
    await advanceSyncCheckpoint(state, portableMirrorRuntime, stateStore);
    const durable = await stateStore.read();
    expect(durable?.batch).toBeUndefined();
    expect(durable?.cursor).toBe(inspection.plan.authority_cursor);
    expect(durable?.generation).toBe(1);
    expect(fileSystem.files.get("remote.md")).toBe("remote bytes");
    const remote = authority.serialize().records.find((record) => record.path === "local.md");
    expect(remote?.document).toBe("local bytes");
  });

  it("is permutation invariant and fingerprints every precondition", () => {
    const baseA = ref("a", "a.md", "old a");
    const localA = ref("a", "moved/a.md", "new a");
    const baseB = ref("b", "b.md", "old b");
    const remoteB = ref("b", "b.md", "new b");
    const movedA = inspected("a", exact(baseA), exact(localA), exact(baseA));
    movedA.remote_target_owner = { state: "absent" };
    const objects = [
      movedA,
      inspected("b", exact(baseB), exact(baseB), exact(remoteB))
    ];

    const first = planReconciliation(summary(objects), digest);
    const second = planReconciliation(summary([...objects].reverse()), digest);

    expect(second).toEqual(first);
    expect(first.actions.map((action) => action.command)).toEqual([
      "put_remote",
      "move_remote",
      "write_local",
      "advance_checkpoint"
    ]);
    expect(first.actions.at(-1)?.depends_on).toHaveLength(3);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const changed = structuredClone(summary(objects));
    changed.objects[0]!.remote_target_owner = exact(baseB);
    expect(planReconciliation(changed, digest).fingerprint).not.toBe(first.fingerprint);
  });

  it("plans conflicts once and never improvises a winner", () => {
    const base = ref("same", "same.md", "base");
    const local = ref("same", "same.md", "local");
    const remote = ref("same", "same.md", "remote");
    const plan = planReconciliation(summary([
      inspected("same", exact(base), exact(local), exact(remote))
    ]), digest);

    expect(plan.actions.map((action) => action.command)).toEqual([
      "record_conflict",
      "advance_checkpoint"
    ]);
    expect(plan.summary).toMatchObject({ uploads: 0, downloads: 0, conflicts: 1 });
  });

  it("uses explicit absence for creates and deletes", () => {
    const created = ref("new", "new.md", "new");
    const deleted = ref("gone", "gone.md", "gone");
    const plan = planReconciliation(summary([
      inspected("new", { state: "absent" }, exact(created), { state: "absent" }),
      inspected("gone", exact(deleted), { state: "absent" }, exact(deleted))
    ]), digest);

    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "put_remote", expected_remote: { state: "absent" } }),
      expect.objectContaining({ command: "delete_remote", expected_remote: exact(deleted) })
    ]));
  });

  it("breaks local rename cycles with a deterministic staged move", async () => {
    const a = ref("a", "a.md", "exact a");
    const b = ref("b", "b.md", "exact b");
    const remoteA = { ...a, path: "b.md" };
    const remoteB = { ...b, path: "a.md" };
    const objectA = inspected("a", exact(a), exact(a), exact(remoteA));
    objectA.local_target_owner = exact(b);
    const objectB = inspected("b", exact(b), exact(b), exact(remoteB));
    objectB.local_target_owner = exact(a);

    const plan = planReconciliation(summary([objectA, objectB]), digest);
    expect(plan.actions.map((action) => action.command)).toEqual([
      "move_local",
      "move_local",
      "move_local",
      "advance_checkpoint"
    ]);
    const [stage, moveB, moveA] = plan.actions;
    expect(stage).toMatchObject({
      command: "move_local",
      source: a,
      expected_target_owner: { state: "absent" }
    });
    expect(stage && "target_path" in stage ? stage.target_path : "")
      .toMatch(/^\.mdbase-sync-stage-[0-9a-f]{16}\.md$/u);
    expect(moveB?.depends_on).toContain(stage?.action_id);
    expect(moveA?.depends_on).toEqual(expect.arrayContaining([
      stage?.action_id,
      moveB?.action_id
    ]));

    const files = new InspectorFileSystem();
    files.files.set("a.md", "exact a");
    files.files.set("b.md", "exact b");
    const store = new (await import("./memory-mirror-state.js")).MemoryMirrorStateStore();
    const state = await prepareSyncBatch({
      engine_version: 3,
      replica_id: plan.replica_id,
      mode: "read_write",
      cursor: 11,
      scope_epoch: 7,
      generation: 3,
      selective_sync: normalizeSelectiveSyncPolicy(),
      records: {
        a: { path: "a.md", revision: a.revision, hash: a.revision.slice(7) },
        b: { path: "b.md", revision: b.revision, hash: b.revision.slice(7) }
      }
    }, plan, { records: {}, resources: {}, files: {}, local_files: {}, documents: {}, mutations: {} }, store);
    const authority = new MemoryAuthority();
    const replica = authority.registerReplica({ name: "cycle", mode: "read_write" });
    const result = await new PlanOnlySyncExecutor({
      transport: authority.transport(replica),
      fileSystem: files,
      runtime: portableMirrorRuntime,
      mode: "read_write",
      store
    }).execute(state);

    expect(result.status).toBe("effects_complete");
    expect(files.files.get("a.md")).toBe("exact b");
    expect(files.files.get("b.md")).toBe("exact a");
    expect([...files.files.keys()]).toEqual(["a.md", "b.md"]);
  });

  it("plans path occupancy as a conflict when no action can vacate it", () => {
    const a = ref("a", "a.md", "a");
    const b = ref("b", "b.md", "b");
    const changedB = ref("b", "b.md", "changed b");
    const remoteA = { ...a, path: "b.md" };
    const objectA = inspected("a", exact(a), exact(a), exact(remoteA));
    objectA.local_target_owner = exact(changedB);
    const objectB = inspected("b", exact(b), exact(changedB), { state: "absent" });

    const plan = planReconciliation(summary([objectA, objectB]), digest);
    expect(plan.actions.filter((action) => action.command === "move_local")).toHaveLength(0);
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "record_conflict",
        identity: "a",
        conflict_kind: "path_occupied"
      }),
      expect.objectContaining({
        command: "record_conflict",
        identity: "b",
        conflict_kind: "delete_vs_change"
      })
    ]));
  });

  it("propagates an unvacatable destination through the path graph", () => {
    const a = ref("a", "a.md", "a");
    const b = ref("b", "b.md", "b");
    const c = ref("c", "c.md", "c");
    const changedC = ref("c", "c.md", "changed c");
    const objectA = inspected("a", exact(a), exact(a), exact({ ...a, path: "b.md" }));
    objectA.local_target_owner = exact(b);
    const objectB = inspected("b", exact(b), exact(b), exact({ ...b, path: "c.md" }));
    objectB.local_target_owner = exact(changedC);
    const objectC = inspected("c", exact(c), exact(changedC), { state: "absent" });

    const plan = planReconciliation(summary([objectA, objectB, objectC]), digest);
    expect(plan.actions.filter((action) => action.command === "move_local")).toHaveLength(0);
    expect(plan.actions.filter((action) =>
      action.command === "record_conflict" && action.conflict_kind === "path_occupied"
    ).map((action) => "identity" in action ? action.identity : "")).toEqual(["a", "b"]);
  });

  it("orders remote vacancy dependencies without confusing receipt dependencies", () => {
    const baseA = ref("a", "a.md", "old a");
    const localA = ref("a", "b.md", "new a");
    const baseB = ref("b", "b.md", "b");
    const objectA = inspected("a", exact(baseA), exact(localA), exact(baseA));
    objectA.remote_target_owner = exact(baseB);
    const objectB = inspected("b", exact(baseB), { state: "absent" }, exact(baseB));

    const plan = planReconciliation(summary([objectA, objectB]), digest);
    expect(plan.actions.map((action) => action.command)).toEqual([
      "put_remote",
      "delete_remote",
      "move_remote",
      "advance_checkpoint"
    ]);
    const [put, remove, move] = plan.actions;
    expect(move?.depends_on).toEqual(expect.arrayContaining([
      put?.action_id,
      remove?.action_id
    ]));
    expect(move && "revision_from_dependency" in move
      ? move.revision_from_dependency
      : undefined).toBe(put?.action_id);
    expect(move).toMatchObject({ expected_target_owner: { state: "absent" } });
  });

  it("makes remote rename cycles explicit path conflicts", () => {
    const a = ref("a", "a.md", "a");
    const b = ref("b", "b.md", "b");
    const localA = { ...a, path: "b.md" };
    const localB = { ...b, path: "a.md" };
    const objectA = inspected("a", exact(a), exact(localA), exact(a));
    objectA.remote_target_owner = exact(b);
    const objectB = inspected("b", exact(b), exact(localB), exact(b));
    objectB.remote_target_owner = exact(a);

    const plan = planReconciliation(summary([objectA, objectB]), digest);
    expect(plan.actions.filter((action) => action.command === "move_remote")).toHaveLength(0);
    expect(plan.actions.filter((action) =>
      action.command === "record_conflict" && action.conflict_kind === "path_occupied"
    )).toHaveLength(2);
  });
});
