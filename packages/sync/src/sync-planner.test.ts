import { describe, expect, it } from "vitest";
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
    const stateStore = new (await import("./mirror-state.js")).MemoryMirrorStateStore();
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
    const objects = [
      inspected("a", exact(baseA), exact(localA), exact(baseA)),
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
    changed.objects[0]!.remote_target_owner = { state: "absent" };
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
});
