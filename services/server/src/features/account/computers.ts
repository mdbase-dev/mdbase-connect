import type { DatabaseQueryable } from "../../database-types.js";

export interface AccountComputerRow {
  id: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  connector_version: string | null;
  last_incompatible_at: string | null;
  incompatibility_code: string | null;
  minimum_connector_version: string | null;
  connector_update_url: string | null;
  latest_policy_ack_mode: "lease_v1" | "legacy_ack_v0" | null;
}

/** The account's registered computers: the Portal's Computers page and the
 * delete-account dialog's count. An app installation device is app access,
 * not a computer, so it is listed under the app instead. */
export async function listAccountComputers(
  db: DatabaseQueryable,
  userId: string
): Promise<AccountComputerRow[]> {
  const computers = await db.query<AccountComputerRow>(
    `SELECT c.id, c.name, c.last_seen_at, c.created_at,
            c.connector_version, c.last_incompatible_at,
            c.incompatibility_code, c.minimum_connector_version,
            c.connector_update_url, c.latest_policy_ack_mode
     FROM connectors c
     LEFT JOIN installation_device_credentials installation
       ON installation.connector_id = c.id
     LEFT JOIN applications installed_app ON installed_app.id::text = installation.app_id
       AND installed_app.family_identity IS NOT NULL
     WHERE c.user_id = $1 AND c.revoked_at IS NULL
       AND installed_app.id IS NULL
     ORDER BY c.created_at`,
    [userId]
  );
  return computers.rows;
}
