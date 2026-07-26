import type {
  CollectionContractDescriptor,
  ContractRequirement,
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
import {
  authorityManifestDigest
} from "@mdbase/connect-sync/mirror";
import { createHash } from "node:crypto";
import type { DatabasePool } from "./db.js";

interface CachedAuthority {
  authority: MemoryHostedAuthority;
  version: number;
}

export type HostedTemplate = "mdbase";

export interface ReferenceAuthorityTransfer {
  id: string;
  collection_id: string;
  replica_id: string;
  final_head: number;
  authority_epoch: number;
  manifest_digest: string;
  state: "prepared" | "completed" | "aborted";
  expires_at: string;
}

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

  async prepareAuthorityTransfer(
    collectionId: string,
    input: { transferId: string; replicaId: string; ttlSeconds: number }
  ): Promise<ReferenceAuthorityTransfer> {
    if (input.ttlSeconds < 60 || input.ttlSeconds > 3_600) {
      throw new SyncError(
        "invalid_authority_transfer_ttl",
        "Authority transfer preparation must expire between one minute and one hour."
      );
    }
    return this.read(collectionId, (authority) => {
      const state = authority.serialize();
      const replica = state.replicas.find(({ id }) => id === input.replicaId);
      if (
        !replica
        || replica.revoked
        || replica.mode !== "read_write"
        || replica.allowedTypes.length > 0
      ) {
        throw new SyncError(
          "promotion_mirror_ineligible",
          "Authority can move only to an active, two-way, full collection mirror."
        );
      }
      const digestValue = manifestDigest(state);
      const expiresAt = new Date(Date.now() + input.ttlSeconds * 1_000).toISOString();
      return {
        id: input.transferId,
        collection_id: collectionId,
        replica_id: input.replicaId,
        final_head: state.head,
        authority_epoch: 2,
        manifest_digest: digestValue,
        state: "prepared" as const,
        expires_at: expiresAt
      };
    });
  }

  async completeAuthorityTransfer(
    transferId: string,
    manifestDigestValue: string
  ): Promise<ReferenceAuthorityTransfer> {
    const transfer = await this.transfer(transferId);
    if (transfer.state === "completed") return transfer;
    if (transfer.state !== "prepared") {
      throw new SyncError("authority_transfer_inactive", "Authority transfer is no longer active.");
    }
    if (transfer.expires_at <= new Date().toISOString()) {
      throw new SyncError(
        "authority_transfer_expired",
        "Authority transfer expired and hosted writes were restored."
      );
    }
    if (transfer.manifest_digest !== manifestDigestValue) {
      throw new SyncError(
        "authority_manifest_mismatch",
        "The local folder does not exactly match the fenced hosted collection."
      );
    }
    await this.write(transfer.collection_id, (authority) => {
      for (const replica of authority.serialize().replicas) {
        if (!replica.revoked) authority.revokeReplica(replica.id);
      }
    });
    return { ...transfer, state: "completed" };
  }

  async abortAuthorityTransfer(transferId: string): Promise<ReferenceAuthorityTransfer> {
    const transfer = await this.transfer(transferId);
    if (transfer.state === "completed") {
      throw new SyncError(
        "authority_transfer_completed",
        "Completed authority transfer cannot be cancelled."
      );
    }
    return { ...transfer, state: "aborted" };
  }

  async transport(collectionId: string, replicaId: string): Promise<SyncTransport> {
    return {
      openSession: async () => {
        await this.assertTransferReadAllowed(collectionId, replicaId);
        return this.read(collectionId, (authority) => authority.transport(replicaId).openSession());
      },
      snapshot: async (snapshotId, page) => {
        await this.assertTransferReadAllowed(collectionId, replicaId);
        return this.read(
          collectionId,
          (authority) => authority.transport(replicaId).snapshot(snapshotId, page)
        );
      },
      changes: async (after, limit) => {
        await this.assertTransferReadAllowed(collectionId, replicaId);
        return this.read(
          collectionId,
          (authority) => authority.transport(replicaId).changes(after, limit)
        );
      },
      mutate: async (mutation) => {
        if (await this.activeTransfer(collectionId)) {
          throw new SyncError(
            "authority_transfer_in_progress",
            "Hosted writes are fenced while authority moves to the local collection."
          );
        }
        return this.write(
          collectionId,
          (authority) => authority.transport(replicaId).mutate(mutation)
        );
      }
    };
  }

  private async assertTransferReadAllowed(collectionId: string, replicaId: string): Promise<void> {
    const transfer = await this.activeTransfer(collectionId);
    if (transfer && transfer.replica_id !== replicaId) {
      throw new SyncError(
        "authority_transfer_in_progress",
        "Only the promotion mirror can read while authority is moving."
      );
    }
  }

  private async activeTransfer(collectionId: string): Promise<ReferenceAuthorityTransfer | null> {
    await this.db.query(
      `UPDATE authority_transfers SET state = 'expired'
       WHERE hosted_collection_id = $1 AND state = 'prepared' AND expires_at <= now()`,
      [collectionId]
    );
    await this.db.query(
      `UPDATE hosted_collections SET authority_state = 'active'
       WHERE id = $1 AND authority_state = 'transferring'
         AND NOT EXISTS (
           SELECT 1 FROM authority_transfers
           WHERE hosted_collection_id = $1 AND state = 'prepared' AND expires_at > now()
         )`,
      [collectionId]
    );
    const result = await this.db.query<ReferenceTransferRow>(
      `SELECT id, hosted_collection_id, replica_id, final_head, next_authority_epoch,
              manifest_digest, state, expires_at
       FROM authority_transfers
       WHERE hosted_collection_id = $1 AND state = 'prepared' AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [collectionId]
    );
    return result.rows[0] ? referenceTransfer(result.rows[0]) : null;
  }

  private async transfer(transferId: string): Promise<ReferenceAuthorityTransfer> {
    const result = await this.db.query<ReferenceTransferRow>(
      `SELECT id, hosted_collection_id, replica_id, final_head, next_authority_epoch,
              manifest_digest, state, expires_at
       FROM authority_transfers WHERE id = $1`,
      [transferId]
    );
    const row = result.rows[0];
    if (!row || row.final_head === null || row.next_authority_epoch === null || !row.manifest_digest) {
      throw new SyncError("authority_transfer_not_found", "Authority transfer was not found.");
    }
    return referenceTransfer(row);
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

interface ReferenceTransferRow {
  id: string;
  hosted_collection_id: string;
  replica_id: string;
  final_head: string | number | null;
  next_authority_epoch: string | number | null;
  manifest_digest: string | null;
  state: "prepared" | "completed" | "cancelled" | "expired";
  expires_at: string | Date;
}

function referenceTransfer(row: ReferenceTransferRow): ReferenceAuthorityTransfer {
  return {
    id: row.id,
    collection_id: row.hosted_collection_id,
    replica_id: row.replica_id,
    final_head: Number(row.final_head),
    authority_epoch: Number(row.next_authority_epoch),
    manifest_digest: row.manifest_digest ?? "",
    state: row.state === "completed"
      ? "completed"
      : row.state === "prepared"
        ? "prepared"
        : "aborted",
    expires_at: new Date(row.expires_at).toISOString()
  };
}

function manifestDigest(state: SerializedHostedAuthority): string {
  const digest = (document: string) => createHash("sha256").update(document).digest("hex");
  return authorityManifestDigest([
    ...(state.resources?.documents ?? []).map((resource) => ({
      kind: "resource" as const,
      path: resource.path,
      document_hash: digest(resource.document)
    })),
    ...state.records.map((record) => ({
      kind: "record" as const,
      path: record.path,
      document_hash: record.revision
    }))
  ]);
}

function authorityOptions(resources: SyncCollectionResources) {
  return { resources };
}

export function asSyncMutation(value: unknown): SyncMutation {
  return value as SyncMutation;
}

export function hostedResources(template: string): SyncCollectionResources {
  if (template === "mdbase") return mdbaseResources();
  throw new SyncError("unsupported_template", "The hosted collection template is unavailable.");
}

export function hostedContracts(template: string): ContractRequirement[] {
  return hostedResources(template).contracts.map(({ id, version }) => ({ id, version }));
}

export function hostedContractDescriptors(template: string): CollectionContractDescriptor[] {
  return hostedResources(template).contracts;
}

export function effectiveHostedContractDescriptors(
  contracts: CollectionContractDescriptor[] | null | undefined,
  template: string
): CollectionContractDescriptor[] {
  return contracts?.length ? contracts : hostedContractDescriptors(template);
}

export function contractRequirements(contracts: CollectionContractDescriptor[]): ContractRequirement[] {
  return contracts.map(({ id, version }) => ({ id, version }));
}

export function typesForContracts(
  available: CollectionContractDescriptor[],
  required: ContractRequirement[]
): string[] {
  if (required.length === 0) return [];
  const requested = new Set(required.map(({ id, version }) => `${id}@${version}`));
  return [...new Set(available
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
