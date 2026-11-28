import { randomUUID } from "node:crypto";
import type { DatabaseQueryable } from "../../database-types.js";
import { STARTER_TEMPLATE_VERSION } from "./starter-collection.js";

export async function scheduleStarterCollection(
  db: DatabaseQueryable,
  userId: string,
  timezone: string | null = null
): Promise<string> {
  const collectionId = randomUUID();
  const scheduled = await db.query<{ starter_collection_id: string }>(
    `INSERT INTO account_onboarding
       (user_id, starter_collection_id, template_version, timezone)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = account_onboarding.updated_at
     RETURNING starter_collection_id`,
    [userId, collectionId, STARTER_TEMPLATE_VERSION, timezone]
  );
  return scheduled.rows[0]!.starter_collection_id;
}
