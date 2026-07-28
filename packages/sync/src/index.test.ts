import { describe, expect, it } from "vitest";
import type { JsonObject, SyncMutation } from "@mdbase/connect-protocol";
import {
  HttpSyncTransport,
  MemoryAuthority,
  MemoryReplicaStore,
  OfflineReplica,
  SyncError
} from "./index.js";

const ids = {
  collection: "01910000-0000-7000-8000-000000000001",
  writer: "01920000-0000-7000-8000-000000000002",
  reader: "01930000-0000-7000-8000-000000000003",
  record: "01940000-0000-7000-8000-000000000004",
  mutation: "01950000-0000-7000-8000-000000000005"
};

function authority(pageSize = 100) {
  return new MemoryAuthority({
    id: ids.collection,
    snapshotPageSize: pageSize,
    validate(record) {
      if (record.types.includes("task") && typeof record.frontmatter.title !== "string") {
        throw new SyncError("validation_failed", "Tasks require a title.");
      }
    }
  });
}

function store(replicaId: string) {
  return new MemoryReplicaStore({ replicaId, records: {}, pending: [], conflicts: {} });
}

describe("hosted sync vertical slice", () => {
  it("accepts only complete secure authority sync endpoints", () => {
    const endpoint = `/v1/authorities/${ids.collection}/sync`;
    expect(() => new HttpSyncTransport(`https://provider.example${endpoint}`, "token"))
      .not.toThrow();
    expect(() => new HttpSyncTransport(`http://127.0.0.1:8787${endpoint}`, "token"))
      .not.toThrow();
    for (const invalid of [
      `http://provider.example${endpoint}`,
      `https://provider.example/v1/hosted/collections/${ids.collection}/sync`,
      `https://provider.example${endpoint}?collection=${ids.collection}`,
      "not a URL"
    ]) {
      expect(() => new HttpSyncTransport(invalid, "token"))
        .toThrowError(expect.objectContaining({ code: "invalid_sync_url" }));
    }
  });

  it("accepts a raw body-only create without frontmatter or explicit types", async () => {
    const hosted = authority();
    hosted.registerReplica({ id: ids.writer, name: "Body-only writer", mode: "read_write" });
    const receipt = await hosted.transport(ids.writer).mutate({
      mutation_id: ids.mutation,
      replica_id: ids.writer,
      scope_epoch: 1,
      operation: "create",
      record_id: ids.record,
      input: { path: "Start Here.md", body: "# Start here" },
      created_at: "2026-07-27T00:00:00.000Z"
    });

    expect(receipt).toMatchObject({
      status: "applied",
      record: {
        path: "Start Here.md",
        frontmatter: {},
        body: "# Start here",
        types: []
      }
    });
  });

  it("moves one offline Worklog create exactly once to a second client", async () => {
    const hosted = authority(1);
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    hosted.registerReplica({ id: ids.reader, name: "Tablet", mode: "read_write", allowedTypes: ["task"] });
    const writer = new OfflineReplica(hosted.transport(ids.writer), store(ids.writer));
    const reader = new OfflineReplica(hosted.transport(ids.reader), store(ids.reader));
    await writer.initialize();
    await reader.initialize();
    await writer.queueCreate({
      recordId: ids.record,
      mutationId: ids.mutation,
      path: "tasks/offline.md",
      frontmatter: { type: "task", title: "Created offline", status: "open" },
      body: "From Android",
      types: ["task"]
    });
    expect((await writer.records())[0].revision).toBe(`local:${ids.mutation}`);
    await writer.sync();
    await reader.pull();
    expect(await writer.pending()).toEqual([]);
    expect((await reader.records())[0]).toMatchObject({
      record_id: ids.record,
      path: "tasks/offline.md",
      frontmatter: { title: "Created offline" }
    });

    const replay: SyncMutation = {
      mutation_id: ids.mutation,
      replica_id: ids.writer,
      scope_epoch: 1,
      operation: "create",
      record_id: ids.record,
      input: { path: "tasks/duplicate.md", frontmatter: { type: "task", title: "Duplicate" }, types: ["task"] },
      created_at: "2026-07-21T00:00:00Z"
    };
    expect(await hosted.transport(ids.writer).mutate(replay)).toMatchObject({
      status: "previously_applied",
      record: { path: "tasks/offline.md" }
    });
  });

  it("returns a useful conflict without blocking mutations to other records", async () => {
    const hosted = authority();
    hosted.seed([
      { record_id: ids.record, path: "tasks/one.md", frontmatter: { type: "task", title: "One" }, body: "", types: ["task"] },
      { record_id: crypto.randomUUID(), path: "tasks/two.md", frontmatter: { type: "task", title: "Two" }, body: "", types: ["task"] }
    ]);
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const transport = hosted.transport(ids.writer);
    const initial = (await transport.snapshot((await transport.openSession()).snapshot_id)).records;
    const current = initial.find((record) => record.record_id === ids.record)!;
    const other = initial.find((record) => record.record_id !== ids.record)!;
    const first = await transport.mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.writer, scope_epoch: 1,
      operation: "update", record_id: current.record_id, base_revision: current.revision,
      input: { patch: { title: "Remote" } }, created_at: new Date().toISOString()
    });
    expect(first.status).toBe("applied");
    const stale = await transport.mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.writer, scope_epoch: 1,
      operation: "update", record_id: current.record_id, base_revision: current.revision,
      input: { patch: { title: "Stale" } }, created_at: new Date().toISOString()
    });
    expect(stale).toMatchObject({
      status: "conflicted",
      conflict: { current: { frontmatter: { title: "Remote" } } }
    });
    const independent = await transport.mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.writer, scope_epoch: 1,
      operation: "update", record_id: other.record_id, base_revision: other.revision,
      input: { patch: { title: "Independent" } }, created_at: new Date().toISOString()
    });
    expect(independent).toMatchObject({ status: "applied", record: { frontmatter: { title: "Independent" } } });
  });

  it("resolves stale offline edits by keeping either the local or hosted version", async () => {
    const hosted = authority();
    hosted.seed([{
      record_id: ids.record,
      path: "tasks/one.md",
      frontmatter: { type: "task", title: "Original" },
      body: "",
      types: ["task"]
    }]);
    hosted.registerReplica({ id: ids.writer, name: "Phone", mode: "read_write", allowedTypes: ["task"] });
    hosted.registerReplica({ id: ids.reader, name: "Tablet", mode: "read_write", allowedTypes: ["task"] });
    const phone = new OfflineReplica(hosted.transport(ids.writer), store(ids.writer));
    const tablet = new OfflineReplica(hosted.transport(ids.reader), store(ids.reader));
    await Promise.all([phone.initialize(), tablet.initialize()]);

    await phone.queueUpdate({ recordId: ids.record, patch: { title: "Phone edit" } });
    await phone.sync();
    await tablet.queueUpdate({ recordId: ids.record, patch: { title: "Tablet edit" } });
    await tablet.sync();
    expect(await tablet.conflicts()).toHaveLength(1);
    await tablet.resolveConflict(ids.record, "local");
    expect((await tablet.records())[0].frontmatter.title).toBe("Tablet edit");
    await tablet.sync();
    await phone.pull();
    expect((await phone.records())[0].frontmatter.title).toBe("Tablet edit");

    await tablet.queueUpdate({ recordId: ids.record, patch: { title: "Tablet stale again" } });
    await phone.queueUpdate({ recordId: ids.record, patch: { title: "Phone final" } });
    await phone.sync();
    await tablet.sync();
    await tablet.resolveConflict(ids.record, "remote");
    expect(await tablet.pending()).toEqual([]);
    expect((await tablet.records())[0].frontmatter.title).toBe("Phone final");
  });

  it("rebuilds an expired cursor without losing a queued offline mutation", async () => {
    const hosted = authority();
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const replicaStore = store(ids.writer);
    const replica = new OfflineReplica(hosted.transport(ids.writer), replicaStore);
    await replica.initialize();
    await replica.queueCreate({
      recordId: ids.record, mutationId: ids.mutation, path: "tasks/queued.md",
      frontmatter: { type: "task", title: "Queued" }, types: ["task"]
    });
    await hosted.transport(ids.writer).mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.writer, scope_epoch: 1,
      operation: "create", record_id: crypto.randomUUID(),
      input: { path: "tasks/remote.md", frontmatter: { type: "task", title: "Remote" }, types: ["task"] },
      created_at: new Date().toISOString()
    });
    hosted.compactThrough(1);
    await replica.pull();
    expect((await replica.pending()).map((mutation) => mutation.mutation_id)).toEqual([ids.mutation]);
    expect(await replica.records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_id: ids.record, revision: `local:${ids.mutation}` })
    ]));
  });

  it("resets on scope epochs and rejects pull and push after revocation", async () => {
    const hosted = authority();
    hosted.seed([{ record_id: ids.record, path: "tasks/one.md", frontmatter: { type: "task", title: "One" }, body: "", types: ["task"] }]);
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const replica = new OfflineReplica(hosted.transport(ids.writer), store(ids.writer));
    await replica.initialize();
    hosted.updateReplicaScope(ids.writer, ["private"]);
    await replica.pull();
    expect(await replica.records()).toEqual([]);
    hosted.revokeReplica(ids.writer);
    await expect(replica.pull()).rejects.toEqual(expect.objectContaining({ code: "replica_revoked" }));
    await expect(hosted.transport(ids.writer).mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.writer, scope_epoch: 2,
      operation: "create", record_id: crypto.randomUUID(),
      input: { path: "private.md", frontmatter: {}, types: ["private"] }, created_at: new Date().toISOString()
    })).resolves.toEqual(expect.objectContaining({ status: "rejected", error: { code: "replica_revoked", message: expect.any(String) } }));
  });

  it("persists rejected receipts and does not retry them forever", async () => {
    const hosted = authority();
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const replicaStore = store(ids.writer);
    const replica = new OfflineReplica(hosted.transport(ids.writer), replicaStore);
    await replica.initialize();
    await replica.queueCreate({
      path: "private/denied.md",
      frontmatter: { type: "private", title: "Denied" },
      types: ["private"]
    });
    await replica.sync();
    expect(await replica.pending()).toEqual([]);
    expect(await replica.conflicts()).toEqual([
      expect.objectContaining({ status: "rejected", error: expect.objectContaining({ code: "scope_denied" }) })
    ]);
    expect(await replica.records()).toEqual([]);
  });

  it("pins paginated snapshots while writes advance the collection head", async () => {
    const hosted = authority(1);
    hosted.seed([
      { record_id: crypto.randomUUID(), path: "tasks/a.md", frontmatter: { type: "task", title: "A" }, body: "", types: ["task"] },
      { record_id: crypto.randomUUID(), path: "tasks/b.md", frontmatter: { type: "task", title: "B" }, body: "", types: ["task"] }
    ]);
    hosted.registerReplica({ id: ids.reader, name: "Reader", mode: "read_only", allowedTypes: ["task"] });
    hosted.registerReplica({ id: ids.writer, name: "Writer", mode: "read_write", allowedTypes: ["task"] });
    const reader = hosted.transport(ids.reader);
    const session = await reader.openSession();
    const first = await reader.snapshot(session.snapshot_id);
    await hosted.transport(ids.writer).mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.writer, scope_epoch: 1,
      operation: "create", record_id: crypto.randomUUID(),
      input: { path: "tasks/c.md", frontmatter: { type: "task", title: "C" }, types: ["task"] },
      created_at: new Date().toISOString()
    });
    const second = await reader.snapshot(session.snapshot_id, first.next_page);
    expect([...first.records, ...second.records].map((record) => record.path)).toEqual(["tasks/a.md", "tasks/b.md"]);
    expect(second.cursor).toBe(session.head);
  });

  it("expires a replica's previous snapshot when it opens a new session", async () => {
    const hosted = authority();
    hosted.registerReplica({ id: ids.reader, name: "Reader", mode: "read_only", allowedTypes: ["task"] });
    const reader = hosted.transport(ids.reader);
    const previous = await reader.openSession();
    const current = await reader.openSession();
    expect(current.snapshot_id).not.toBe(previous.snapshot_id);
    await expect(reader.snapshot(previous.snapshot_id)).rejects.toMatchObject({ code: "snapshot_expired" });
    await expect(reader.snapshot(current.snapshot_id)).resolves.toMatchObject({ records: [] });
  });

  it("advances scoped cursors across invisible authority changes", async () => {
    const hosted = authority();
    hosted.registerReplica({ id: ids.reader, name: "Task reader", mode: "read_only", allowedTypes: ["task"] });
    hosted.registerReplica({ id: ids.writer, name: "Full writer", mode: "read_write" });
    const writer = hosted.transport(ids.writer);
    await writer.mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.writer, scope_epoch: 1,
      operation: "create", record_id: crypto.randomUUID(),
      input: { path: "private/one.md", frontmatter: { type: "private" }, types: ["private"] },
      created_at: new Date().toISOString()
    });
    const page = await hosted.transport(ids.reader).changes(0, 1);
    expect(page).toMatchObject({ events: [], cursor: 1, head: 1, has_more: false });
  });

  it("projects collection resources through the same type scope as records", async () => {
    const hosted = new MemoryAuthority({
      resources: {
        revision: "fixture:1",
        spec_version: "0.3.0",
        types: [
          { name: "task", schema: {}, extensions: {} },
          { name: "private", schema: {}, extensions: {} }
        ],
        contracts: [
          {
            id: "example.work-item",
            version: "1.0.0",
            digest: `sha256:${"0".repeat(64)}`,
            schema: {},
            implementations: [{
              type_name: "task",
              type_version: 1,
              digest: `sha256:${"1".repeat(64)}`,
              fields: {}
            }]
          },
          {
            id: "private.note",
            version: "1.0.0",
            digest: `sha256:${"2".repeat(64)}`,
            schema: {},
            implementations: [{
              type_name: "private",
              type_version: 1,
              digest: `sha256:${"3".repeat(64)}`,
              fields: {}
            }]
          }
        ]
      }
    });
    hosted.registerReplica({ id: ids.reader, name: "Task reader", mode: "read_only", allowedTypes: ["task"] });
    const resources = (await hosted.transport(ids.reader).openSession()).resources;
    expect(resources.types.map((type) => type.name)).toEqual(["task"]);
    expect(resources.contracts.map((contract) => contract.id)).toEqual(["example.work-item"]);
  });

  it("keeps queued changes visible while pulling remote changes", async () => {
    const hosted = authority();
    hosted.seed([{ record_id: ids.record, path: "tasks/one.md", frontmatter: { type: "task", title: "One" }, body: "", types: ["task"] }]);
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    hosted.registerReplica({ id: ids.reader, name: "Other", mode: "read_write", allowedTypes: ["task"] });
    const replica = new OfflineReplica(hosted.transport(ids.writer), store(ids.writer));
    await replica.initialize();
    const initial = (await replica.records())[0];
    await replica.queueUpdate({ recordId: ids.record, patch: { status: "local" } });
    await hosted.transport(ids.reader).mutate({
      mutation_id: crypto.randomUUID(), replica_id: ids.reader, scope_epoch: 1,
      operation: "update", record_id: ids.record, base_revision: initial.revision,
      input: { patch: { title: "Remote" } }, created_at: new Date().toISOString()
    });
    await replica.pull();
    expect((await replica.records())[0]).toMatchObject({
      revision: expect.stringMatching(/^local:/),
      frontmatter: { title: "Remote", status: "local" }
    });
  });

  it("persists causal rebasing across an interrupted multi-mutation upload", async () => {
    const hosted = authority();
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const replicaStore = store(ids.writer);
    const upstream = hosted.transport(ids.writer);
    let calls = 0;
    const interrupted = {
      ...upstream,
      mutate: async (mutation: SyncMutation) => {
        calls += 1;
        if (calls === 2) throw new SyncError("offline", "Network interrupted.");
        return upstream.mutate(mutation);
      }
    };
    const first = new OfflineReplica(interrupted, replicaStore);
    await first.initialize();
    await first.queueCreate({
      recordId: ids.record, mutationId: ids.mutation, path: "tasks/one.md",
      frontmatter: { type: "task", title: "One" }, types: ["task"]
    });
    await first.queueUpdate({ recordId: ids.record, patch: { status: "done" } });
    await expect(first.sync()).rejects.toMatchObject({ code: "offline" });
    const remaining = await first.pending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ base_revision: expect.stringMatching(/^authority:1:/) });
    expect(remaining[0].causal_predecessor).toBeUndefined();

    const restarted = new OfflineReplica(upstream, replicaStore);
    await restarted.sync();
    expect(await restarted.pending()).toEqual([]);
    expect((await restarted.records())[0].frontmatter.status).toBe("done");
  });

  it("serializes concurrent local writes and supports optimistic rename and delete", async () => {
    const hosted = authority();
    hosted.registerReplica({ id: ids.writer, name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const replica = new OfflineReplica(hosted.transport(ids.writer), store(ids.writer));
    await replica.initialize();
    const created = await Promise.all(Array.from({ length: 20 }, (_, index) => replica.queueCreate({
      path: `tasks/${index}.md`, frontmatter: { type: "task", title: String(index) }, types: ["task"]
    })));
    expect(await replica.pending()).toHaveLength(20);
    await replica.sync();
    expect(await replica.records()).toHaveLength(20);
    await replica.queueRename({ recordId: created[0].record_id, path: "tasks/renamed.md" });
    expect((await replica.records()).find((record) => record.record_id === created[0].record_id)?.path).toBe("tasks/renamed.md");
    await replica.sync();
    await replica.queueDelete({ recordId: created[0].record_id });
    expect((await replica.records()).some((record) => record.record_id === created[0].record_id)).toBe(false);
    await replica.sync();
    expect(await replica.records()).toHaveLength(19);
  });

  it("rejects non-advancing provider pages instead of looping", async () => {
    const transport = {
      openSession: async () => ({
        protocol_version: 1 as const, session_id: crypto.randomUUID(), replica_id: ids.reader,
        collection_id: ids.collection, mode: "read_only" as const, scope_epoch: 1,
        retained_after: 0, head: 0, snapshot_id: crypto.randomUUID(),
        resources: { revision: "test:1", spec_version: "0.3.0", types: [], contracts: [] }
      }),
      snapshot: async (snapshotId: string) => ({
        protocol_version: 1 as const, snapshot_id: snapshotId, scope_epoch: 1, cursor: 0, records: []
      }),
      changes: async () => ({
        protocol_version: 1 as const, scope_epoch: 1, events: [], cursor: 0, head: 1,
        has_more: true, reset_required: false
      }),
      mutate: async () => { throw new Error("unused"); }
    };
    const replica = new OfflineReplica(transport, store(ids.reader));
    await replica.initialize();
    await expect(replica.pull()).rejects.toMatchObject({ code: "invalid_changes_page" });
  });
});
