import { z } from "zod";
import type { DatabasePool } from "../../db.js";
import { InstanceAdminNotFoundError, resolveUserId } from "../../instance-admin.js";
import { nativeDevicesByCollection, nativeGrantStandings } from "../next/native-grant-target.js";
import { deviceAvailability, deviceCandidates } from "../next/route-routes.js";
import type { RegisteredDeviceKind } from "../next/policy-wire.js";
import type { RelayBroker } from "../relay/relay-broker.js";

const inputSchema = z.object({
  user: z.string().min(1),
  collection: z.uuid().transform(value => value.toLowerCase()).optional(),
  limit: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().max(25)).optional(),
  cursor: z.uuid().transform(value => value.toLowerCase()).optional()
}).refine(input => !input.collection || !input.cursor, "--collection and --cursor cannot be combined.");

interface CollectionRow {
  collection_id: string;
  display_name: string | null;
  runtime: "next" | "shadow";
  sync: "private" | "cloud_copy";
  left_sync_at: Date | string | null;
  deleted: boolean;
}

interface RegistrationRow {
  connector_id: string;
  device_id: string | null;
  kind: RegisteredDeviceKind | null;
  connector_version: string | null;
  revoked_at: Date | string | null;
  last_seen_at: Date | string | null;
  update_required: boolean;
}

export async function diagnoseCollections(
  context: { db: DatabasePool; relayBroker?: Pick<RelayBroker, "request">; runtimeRevision?: string },
  rawInput: { user: string; collection?: string | undefined; limit?: string | undefined; cursor?: string | undefined }
) {
  const input = inputSchema.parse(rawInput);
  const limit = input.limit ?? 10;
  const connection = await context.db.connect();
  const observedAt = new Date().toISOString();
  try {
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const userId = await resolveUserId(connection, input.user);
    const user = (await connection.query<{ suspended: boolean }>(
      "SELECT suspended_at IS NOT NULL AS suspended FROM users WHERE id = $1", [userId]
    )).rows[0]!;
    const page = await connection.query<CollectionRow>(
      `SELECT n.collection_id, left(n.display_name, 120) AS display_name, n.runtime, n.sync, n.left_sync_at,
         EXISTS (SELECT 1 FROM next_collection_deletion_facts f WHERE f.collection_id = n.collection_id) AS deleted
       FROM next_collections n
       WHERE n.owner_user_id = $1 AND ($2::uuid IS NULL OR n.collection_id = $2)
         AND ($3::uuid IS NULL OR n.collection_id > $3)
       ORDER BY n.collection_id LIMIT $4`,
      [userId, input.collection ?? null, input.cursor ?? null, limit + 1]
    );
    if (input.collection && page.rows.length === 0) {
      throw new InstanceAdminNotFoundError("Owned native collection was not found.");
    }
    const collections = page.rows.slice(0, limit);
    const registrations = await connection.query<RegistrationRow>(
      `SELECT c.id AS connector_id, d.id AS device_id, d.kind, left(c.connector_version, 80) AS connector_version,
         c.revoked_at, c.last_seen_at, c.incompatibility_code IS NOT NULL AS update_required
       FROM connectors c LEFT JOIN next_devices d ON d.connector_id = c.id AND d.user_id = c.user_id
       WHERE c.user_id = $1 ORDER BY c.id LIMIT 101`, [userId]
    );
    if (registrations.rows.length > 100) throw new Error("Account exceeds the diagnostic limit of 100 registrations; no partial report was produced.");
    const standings = await nativeGrantStandings(connection, userId,
      collections.map(row => ({ collection: row.collection_id, sync: row.sync })));
    const privateIds = collections.filter(row => !user.suspended && row.sync === "private"
      && standings.get(row.collection_id)!.standing === "current").map(row => row.collection_id);
    const devices = await nativeDevicesByCollection(connection, privateIds, userId);
    if ([...devices.values()].reduce((total, entries) => total + entries.length, 0) > 100) {
      throw new Error("Page exceeds the diagnostic limit of 100 presence probes; select --collection or a smaller --limit.");
    }
    await connection.query("COMMIT");
    const results = [];
    for (const row of collections) {
      const standing = standings.get(row.collection_id)!.standing;
      const targets = devices.get(row.collection_id) ?? [];
      if (targets.length > 0 && !context.relayBroker) throw new Error("Relay broker is not configured; live availability cannot be diagnosed.");
      const candidates = targets.length > 0
        ? await deviceCandidates(context.relayBroker!, targets.map(target => ({ ...target, local_id: row.collection_id })), "")
        : [];
      if (candidates.some(candidate => candidate.presence === "failed")) {
        throw new Error("Relay presence probe failed internally; no availability report was produced.");
      }
      results.push({
        ...row,
        left_sync_at: timestamp(row.left_sync_at),
        availability: user.suspended ? { state: "unavailable", reason: "account_suspended" }
          : standing !== "current" ? { state: "unavailable", reason: standing }
          : row.sync !== "private" ? { state: "not_checked", reason: "hosted_replica_not_probed" }
          : deviceAvailability(candidates),
        devices: candidates.map(candidate => ({
          device_id: candidate.value.device,
          connector_id: targets.find(target => target.device_id === candidate.value.device)!.connector_id,
          presence: candidate.presence,
          online: candidate.value.online,
          serving: candidate.serving,
          old_connector_running: candidate.oldConnectorRunning
        }))
      });
    }
    return {
      observed_at: observedAt,
      runtime_revision: context.runtimeRevision ?? null,
      user_id: userId,
      scope: "owned_native_collections",
      collections: results,
      next_cursor: page.rows.length > limit ? collections.at(-1)!.collection_id : null,
      account_registrations: registrations.rows.map(row => ({
        ...row,
        revoked_at: timestamp(row.revoked_at),
        last_seen_at: timestamp(row.last_seen_at)
      }))
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function timestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
