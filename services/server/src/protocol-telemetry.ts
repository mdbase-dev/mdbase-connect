import type { DatabaseQueryable } from "./database-types.js";

export type ProtocolUsageSurface = "direct" | "relay" | "hosted";

export async function recordProtocolUsage(
  db: DatabaseQueryable,
  input: {
    userId: string;
    surface: ProtocolUsageSurface;
    version: number;
    count?: number;
  }
): Promise<void> {
  const count = input.count ?? 1;
  if (
    !Number.isInteger(input.version)
    || input.version <= 0
    || !Number.isSafeInteger(count)
    || count <= 0
    || count > 100_000
  ) return;
  await db.query(
    `INSERT INTO protocol_usage_telemetry
       (user_id, surface, protocol_axis, protocol_version, sample_count)
     VALUES ($1, $2, 'operation_transport', $3, $4)
     ON CONFLICT (user_id, surface, protocol_axis, protocol_version)
     DO UPDATE SET
       sample_count = protocol_usage_telemetry.sample_count + EXCLUDED.sample_count,
       last_seen_at = now()`,
    [input.userId, input.surface, input.version, count]
  );
}

export async function recordConnectorProtocolUsage(
  db: DatabaseQueryable,
  connectorId: string,
  entries: Array<{ version: number; count: number }>
): Promise<void> {
  const connector = await db.query<{ user_id: string }>(
    "SELECT user_id FROM connectors WHERE id = $1 AND revoked_at IS NULL",
    [connectorId]
  );
  const userId = connector.rows[0]?.user_id;
  if (!userId) return;
  for (const entry of entries) {
    if (
      !Number.isInteger(entry.version)
      || entry.version <= 0
      || !Number.isSafeInteger(entry.count)
      || entry.count <= 0
      || entry.count > 100_000
    ) continue;
    await recordProtocolUsage(db, {
      userId,
      surface: "direct",
      version: entry.version,
      count: entry.count
    });
  }
}
