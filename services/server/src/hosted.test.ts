import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import {
  hostedContracts,
  hostedResources,
  HostedAuthorityRegistry
} from "./hosted.js";

let database: DatabasePool | undefined;
afterEach(async () => database?.end());

describe("hosted collection profiles", () => {
  it("keeps generic mdbase collections independent of application contracts", () => {
    expect(hostedContracts("mdbase")).toEqual([]);
  });

  it("enables Obsidian Base view sources in every new hosted collection", () => {
    const resources = hostedResources("mdbase");
    expect(resources.revision).toBe("mdbase-template:2");
    expect(resources.documents[0]!.document).toContain(
      "include:\n      - views/**/*.base"
    );
    expect(resources.documents[0]!.document).toContain("create_folder: views");
    expect(resources.documents[0]!.document).toContain(
      "default_for_new_views: true"
    );
  });
});

describe("persisted hosted authority", () => {
  it("allows full-collection replicas to store untyped Markdown records", async () => {
    database = await createDatabase("memory");
    const userId = randomUUID();
    const collectionId = randomUUID();
    const replicaId = randomUUID();
    await database.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
      userId,
      "templates@example.com",
      "Templates"
    ]);
    await database.query(
      "INSERT INTO hosted_collections (id, user_id, display_name, template) VALUES ($1, $2, $3, $4)",
      [collectionId, userId, "Writing", "mdbase"]
    );
    const registry = new HostedAuthorityRegistry(database);
    await registry.create(collectionId, "mdbase");
    await registry.registerReplica(collectionId, {
      id: replicaId,
      name: "Full collection app",
      mode: "read_write",
      allowedTypes: []
    });
    const transport = await registry.transport(collectionId, replicaId);
    const receipt = await transport.mutate({
      mutation_id: randomUUID(),
      replica_id: replicaId,
      scope_epoch: 1,
      operation: "create",
      record_id: randomUUID(),
      input: {
        path: "Templates/Document.md",
        frontmatter: { purpose: "document-template" },
        body: "Template body for {{title}}",
        types: []
      },
      created_at: new Date().toISOString()
    });
    expect(receipt).toMatchObject({
      status: "applied",
      record: { path: "Templates/Document.md", types: [] }
    });
  });

  it("survives registry restart, preserves idempotency, and serializes stale writers", async () => {
    database = await createDatabase("memory");
    const userId = randomUUID();
    const collectionId = randomUUID();
    const replicaId = randomUUID();
    await database.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [userId, "sync@example.com", "Sync"]);
    await database.query(
      "INSERT INTO hosted_collections (id, user_id, display_name, template) VALUES ($1, $2, $3, $4)",
      [collectionId, userId, "Writing", "mdbase"]
    );
    const first = new HostedAuthorityRegistry(database);
    await first.create(collectionId, "mdbase");
    await first.registerReplica(collectionId, {
      id: replicaId,
      name: "Client",
      mode: "read_write",
      allowedTypes: []
    });
    const mutation = {
      mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1 as const,
      operation: "create" as const, record_id: randomUUID(),
      input: { path: "records/one.md", frontmatter: { title: "One" }, types: [] },
      created_at: new Date().toISOString()
    };
    const applied = await (await first.transport(collectionId, replicaId)).mutate(mutation);
    expect(applied.status).toBe("applied");

    const restarted = new HostedAuthorityRegistry(database);
    const transport = await restarted.transport(collectionId, replicaId);
    const replay = await transport.mutate({ ...mutation, input: { path: "records/duplicate.md" } });
    expect(replay).toMatchObject({ status: "previously_applied", record: { path: "records/one.md" } });
    const session = await transport.openSession();
    const current = (await transport.snapshot(session.snapshot_id)).records[0];
    const updates = await Promise.all([
      transport.mutate({
        mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1,
        operation: "update", record_id: current.record_id, base_revision: current.revision,
        input: { patch: { title: "A" } }, created_at: new Date().toISOString()
      }),
      transport.mutate({
        mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1,
        operation: "update", record_id: current.record_id, base_revision: current.revision,
        input: { patch: { title: "B" } }, created_at: new Date().toISOString()
      })
    ]);
    expect(updates.filter((receipt) => receipt.status === "applied")).toHaveLength(1);
    expect(updates.filter((receipt) => receipt.status === "conflicted")).toHaveLength(1);
  });

  it("retries optimistic state writes across independent server registries", async () => {
    database = await createDatabase("memory");
    const userId = randomUUID();
    const collectionId = randomUUID();
    const replicaId = randomUUID();
    await database.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [userId, "cluster@example.com", "Cluster"]);
    await database.query(
      "INSERT INTO hosted_collections (id, user_id, display_name, template) VALUES ($1, $2, $3, $4)",
      [collectionId, userId, "Writing", "mdbase"]
    );
    const first = new HostedAuthorityRegistry(database);
    await first.create(collectionId, "mdbase");
    await first.registerReplica(collectionId, {
      id: replicaId, name: "Client", mode: "read_write", allowedTypes: []
    });
    const creator = await first.transport(collectionId, replicaId);
    const create = await creator.mutate({
      mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1,
      operation: "create", record_id: randomUUID(),
      input: { path: "records/one.md", frontmatter: { title: "One" }, types: [] },
      created_at: new Date().toISOString()
    });
    if (create.status !== "applied" || !create.record) throw new Error("fixture create failed");

    const second = new HostedAuthorityRegistry(database);
    const left = await first.transport(collectionId, replicaId);
    const right = await second.transport(collectionId, replicaId);
    await Promise.all([left.openSession(), right.openSession()]);
    const updates = await Promise.all([
      left.mutate({
        mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1,
        operation: "update", record_id: create.record.record_id, base_revision: create.record.revision,
        input: { patch: { title: "Left" } }, created_at: new Date().toISOString()
      }),
      right.mutate({
        mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1,
        operation: "update", record_id: create.record.record_id, base_revision: create.record.revision,
        input: { patch: { title: "Right" } }, created_at: new Date().toISOString()
      })
    ]);
    expect(updates.filter((receipt) => receipt.status === "applied")).toHaveLength(1);
    expect(updates.filter((receipt) => receipt.status === "conflicted")).toHaveLength(1);
  });

  it("refreshes cross-process reads without invalidating a pinned local snapshot", async () => {
    database = await createDatabase("memory");
    const userId = randomUUID();
    const collectionId = randomUUID();
    const replicaId = randomUUID();
    await database.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [userId, "reader@example.com", "Reader"]);
    await database.query(
      "INSERT INTO hosted_collections (id, user_id, display_name, template) VALUES ($1, $2, $3, $4)",
      [collectionId, userId, "Writing", "mdbase"]
    );
    const writerRegistry = new HostedAuthorityRegistry(database);
    await writerRegistry.create(collectionId, "mdbase");
    await writerRegistry.registerReplica(collectionId, {
      id: replicaId, name: "Client", mode: "read_write", allowedTypes: []
    });
    const writer = await writerRegistry.transport(collectionId, replicaId);
    await writer.mutate({
      mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1,
      operation: "create", record_id: randomUUID(),
      input: { path: "records/one.md", frontmatter: { title: "One" }, types: [] },
      created_at: new Date().toISOString()
    });

    const readerRegistry = new HostedAuthorityRegistry(database);
    const reader = await readerRegistry.transport(collectionId, replicaId);
    const pinned = await reader.openSession();
    await writer.mutate({
      mutation_id: randomUUID(), replica_id: replicaId, scope_epoch: 1,
      operation: "create", record_id: randomUUID(),
      input: { path: "records/two.md", frontmatter: { title: "Two" }, types: [] },
      created_at: new Date().toISOString()
    });

    const snapshot = await reader.snapshot(pinned.snapshot_id);
    expect(snapshot.records.map((record) => record.path)).toEqual(["records/one.md"]);
    const changes = await reader.changes(pinned.head);
    expect(changes.events).toEqual([
      expect.objectContaining({ type: "put", record: expect.objectContaining({ path: "records/two.md" }) })
    ]);
  });
});
