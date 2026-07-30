import { randomUUID } from "node:crypto";
import type { DatabaseQueryable } from "../database-types.js";

export async function audit(
  db: DatabaseQueryable,
  userId: string | null,
  eventType: string,
  subjectId: string | null,
  metadata: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), userId, eventType, subjectId, JSON.stringify(metadata)]
  );
}
