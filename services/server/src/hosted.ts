import type {
  ContractRequirement,
  JsonObject,
  SyncCollectionResources,
  SyncMutation
} from "@mdbase/connect-protocol";
import {
  MemoryHostedAuthority,
  SyncError,
  type ReplicaOptions,
  type SerializedHostedAuthority,
  type SyncTransport
} from "@mdbase/connect-sync";
import type { DatabasePool } from "./db.js";

interface CachedAuthority {
  authority: MemoryHostedAuthority;
  version: number;
}

export type HostedTemplate = "mdbase" | "tasknotes";

/**
 * Transactional persistence boundary for the sync reference authority.
 *
 * It deliberately stores one versioned state document per collection during
 * the vertical slice. The API boundary stays stable when the Rust provider
 * replaces this with normalized record/change tables.
 */
export class HostedAuthorityRegistry {
  private readonly cache = new Map<string, CachedAuthority>();
  private readonly gates = new Map<string, Promise<void>>();
  private readonly schemaReady: Promise<unknown>;

  constructor(private readonly db: DatabasePool) {
    this.schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS hosted_authority_states (
        collection_id uuid,
        state jsonb,
        version bigint,
        updated_at timestamptz
      )
    `);
  }

  async create(collectionId: string, template: HostedTemplate = "mdbase"): Promise<void> {
    await this.schemaReady;
    const authority = new MemoryHostedAuthority({ id: collectionId, ...authorityOptions(hostedResources(template)) });
    await this.db.query(
      `INSERT INTO hosted_authority_states (collection_id, state, version)
       VALUES ($1, $2::jsonb, 1)`,
      [collectionId, JSON.stringify(authority.serialize())]
    );
    this.cache.set(collectionId, { authority, version: 1 });
  }

  async delete(collectionId: string): Promise<void> {
    await this.schemaReady;
    const removed = await this.db.query(
      "DELETE FROM hosted_authority_states WHERE collection_id = $1 RETURNING collection_id",
      [collectionId]
    );
    if (!removed.rows[0]) {
      throw new SyncError("hosted_collection_not_found", "Hosted collection not found.");
    }
    this.cache.delete(collectionId);
  }

  async registerReplica(collectionId: string, options: ReplicaOptions): Promise<string> {
    return this.write(collectionId, (authority) => authority.registerReplica(options));
  }

  async revokeReplica(collectionId: string, replicaId: string): Promise<void> {
    await this.write(collectionId, (authority) => authority.revokeReplica(replicaId));
  }

  async compactThrough(collectionId: string, sequence: number): Promise<void> {
    await this.write(collectionId, (authority) => authority.compactThrough(sequence));
  }

  async transport(collectionId: string, replicaId: string): Promise<SyncTransport> {
    return {
      openSession: () => this.read(collectionId, (authority) => authority.transport(replicaId).openSession()),
      snapshot: (snapshotId, page) => this.read(
        collectionId,
        (authority) => authority.transport(replicaId).snapshot(snapshotId, page)
      ),
      changes: (after, limit) => this.read(
        collectionId,
        (authority) => authority.transport(replicaId).changes(after, limit)
      ),
      mutate: (mutation) => this.write(collectionId, (authority) => authority.transport(replicaId).mutate(mutation))
    };
  }

  private read<Result>(
    collectionId: string,
    operation: (authority: MemoryHostedAuthority) => Result | Promise<Result>
  ): Promise<Result> {
    return this.exclusive(collectionId, async () => {
      const cached = await this.load(collectionId, true);
      return operation(cached.authority);
    });
  }

  private async write<Result>(
    collectionId: string,
    operation: (authority: MemoryHostedAuthority) => Result | Promise<Result>
  ): Promise<Result> {
    return this.exclusive(collectionId, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const cached = await this.load(collectionId, true);
        const working = MemoryHostedAuthority.restore(
          cached.authority.serialize(),
          authorityOptions(cached.authority.serialize().resources ?? mdbaseResources()),
          cached.authority
        );
        const result = await operation(working);
        const updated = await this.db.query(
          `UPDATE hosted_authority_states
           SET state = $2::jsonb, version = version + 1, updated_at = now()
           WHERE collection_id = $1 AND version = $3 RETURNING version`,
          [collectionId, JSON.stringify(working.serialize()), cached.version]
        );
        if (updated.rows[0]) {
          this.cache.set(collectionId, {
            authority: working,
            version: Number(updated.rows[0].version)
          });
          return result;
        }
      }
      throw new SyncError("concurrent_authority_write", "Hosted collection remained busy after three write attempts.");
    });
  }

  private async exclusive<Result>(collectionId: string, operation: () => Promise<Result>): Promise<Result> {
    const prior = this.gates.get(collectionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.gates.set(collectionId, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.gates.get(collectionId) === queued) this.gates.delete(collectionId);
    }
  }

  private async load(collectionId: string, refresh = false): Promise<CachedAuthority> {
    await this.schemaReady;
    const present = this.cache.get(collectionId);
    if (present && !refresh) return present;
    const result = await this.db.query<{ state: SerializedHostedAuthority; version: string | number }>(
      "SELECT state, version FROM hosted_authority_states WHERE collection_id = $1",
      [collectionId]
    );
    const row = result.rows[0];
    if (!row) throw new SyncError("hosted_collection_not_found", "Hosted collection not found.");
    const version = Number(row.version);
    if (present?.version === version) return present;
    const cached = {
      authority: MemoryHostedAuthority.restore(
        row.state,
        authorityOptions(row.state.resources ?? mdbaseResources()),
        present?.authority
      ),
      version
    };
    this.cache.set(collectionId, cached);
    return cached;
  }
}

function authorityOptions(resources: SyncCollectionResources) {
  const tasknotes = resources.contracts.some((contract) => contract.id === "tasknotes.task");
  return {
    ...(tasknotes ? { validate: validateTasknotes } : {}),
    resources
  };
}

function validateTasknotes(record: { types: string[]; frontmatter: JsonObject }): void {
  if (!record.types.includes("task")) throw new SyncError("scope_denied", "The TaskNotes collection accepts task records only.");
  if (record.frontmatter.type !== "task" || typeof record.frontmatter.title !== "string" || !record.frontmatter.title.trim()) {
    throw new SyncError("validation_failed", "Task records require type: task and a non-empty title.");
  }
}

export function asSyncMutation(value: unknown): SyncMutation {
  return value as SyncMutation;
}

export function hostedResources(template: string): SyncCollectionResources {
  if (template === "mdbase") return mdbaseResources();
  if (template === "tasknotes") return tasknotesResources();
  throw new SyncError("unsupported_template", "The hosted collection template is unavailable.");
}

export function hostedContracts(template: string): ContractRequirement[] {
  return hostedResources(template).contracts.map(({ id, version }) => ({ id, version }));
}

export function hostedTypesForContracts(
  template: string,
  contracts: ContractRequirement[]
): string[] {
  if (contracts.length === 0) return [];
  const requested = new Set(contracts.map(({ id, version }) => `${id}@${version}`));
  return [...new Set(hostedResources(template).contracts
    .filter(({ id, version }) => requested.has(`${id}@${version}`))
    .map(({ type_name }) => type_name))];
}

export function mdbaseResources(): SyncCollectionResources {
  return {
    revision: "mdbase-template:1",
    spec_version: "0.3.0",
    types: [],
    contracts: [],
    documents: [{
      path: "mdbase.yaml",
      kind: "configuration",
      revision: "mdbase-config:1",
      document: "spec_version: 0.3.0\nsettings:\n  types_folder: _types\n  default_validation: error\n"
    }]
  };
}

export function tasknotesResources(): SyncCollectionResources {
  const contract = {
    contract: "tasknotes.task",
    version: 1,
    field_roles: { title: "title", status: "status" },
    status: { completed_values: ["done"], default: "open" }
  };
  return {
    revision: "tasknotes-template:1",
    spec_version: "0.3.0",
    types: [{
      name: "task",
      version: 1,
      schema: {
        type: "object",
        required: ["type", "title"],
        additionalProperties: true,
        properties: {
          type: { const: "task" },
          title: { type: "string", minLength: 1 },
          status: { enum: ["open", "done"] }
        }
      },
      collection: { path: { folder: "tasks" } },
      extensions: { "x-tasknotes": contract }
    }],
    contracts: [{
      id: "tasknotes.task",
      version: 1,
      type_name: "task",
      extension: "x-tasknotes",
      configuration: contract
    }],
    documents: [{
      path: "mdbase.yaml",
      kind: "configuration",
      revision: "tasknotes-config:1",
      document: "spec_version: 0.3.0\nsettings:\n  types_folder: _types\n  default_validation: error\n"
    }, {
      path: "_types/task.md",
      kind: "type",
      revision: "tasknotes-type:1",
      document: `---
kind: mdbase.type
name: task
version: 1
description: A TaskNotes-compatible task.
collection:
  path:
    folder: tasks
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string, minLength: 1 }
      status: { enum: [open, done] }
x-tasknotes:
  contract: tasknotes.task
  version: 1
  field_roles: { title: title, status: status }
  status: { completed_values: [done], default: open }
---
`
    }]
  };
}
