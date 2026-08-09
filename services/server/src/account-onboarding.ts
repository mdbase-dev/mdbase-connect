import { randomUUID } from "node:crypto";
import type { DatabaseQueryable } from "./database-types.js";
import {
  createHostedCollectionForUser,
  type HostedServiceOptions
} from "./features/hosted/service.js";
import {
  STARTER_COLLECTION_NAME,
  STARTER_TEMPLATE_VERSION
} from "./starter-collection.js";

interface OnboardingRow {
  starter_collection_id: string;
  timezone: string;
  provisioned_at: string | null;
}

export type StarterCollectionOnboarding =
  | { status: "not_scheduled" }
  | { status: "pending"; collectionId: string }
  | { status: "ready"; collectionId: string }
  | { status: "deleted"; collectionId: string };

export async function scheduleStarterCollection(
  db: DatabaseQueryable,
  userId: string,
  timezone = "UTC"
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

export async function provisionStarterCollection(
  options: HostedServiceOptions,
  publicUrl: string,
  userId: string
): Promise<StarterCollectionOnboarding> {
  const current = await onboardingRow(options.db, userId);
  if (!current) return { status: "not_scheduled" };
  if (current.provisioned_at) {
    return await collectionStillExists(options.db, userId, current.starter_collection_id)
      ? { status: "ready", collectionId: current.starter_collection_id }
      : { status: "deleted", collectionId: current.starter_collection_id };
  }

  const claimed = await options.db.query<OnboardingRow>(
    `UPDATE account_onboarding
     SET provisioning_started_at = now(), updated_at = now()
     WHERE user_id = $1 AND provisioned_at IS NULL
       AND (
         provisioning_started_at IS NULL
         OR provisioning_started_at < now() - interval '30 seconds'
       )
     RETURNING starter_collection_id, timezone, provisioned_at`,
    [userId]
  );
  const row = claimed.rows[0];
  if (!row) {
    const refreshed = await onboardingRow(options.db, userId);
    return refreshed?.provisioned_at
      ? { status: "ready", collectionId: refreshed.starter_collection_id }
      : { status: "pending", collectionId: current.starter_collection_id };
  }

  try {
    await createHostedCollectionForUser(
      options,
      undefined,
      publicUrl,
      userId,
      STARTER_COLLECTION_NAME,
      "onboarding",
      row.timezone,
      { collectionId: row.starter_collection_id, source: "onboarding" }
    );
    await options.db.query(
      `UPDATE account_onboarding
       SET provisioned_at = now(), provisioning_started_at = NULL, updated_at = now()
       WHERE user_id = $1`,
      [userId]
    );
    return { status: "ready", collectionId: row.starter_collection_id };
  } catch (error) {
    await options.db.query(
      `UPDATE account_onboarding
       SET provisioning_started_at = NULL, updated_at = now()
       WHERE user_id = $1 AND provisioned_at IS NULL`,
      [userId]
    );
    throw error;
  }
}

export function starterEditorUrl(
  editorOrigin: string | undefined,
  publicUrl: string,
  collectionId: string
): string | null {
  if (!editorOrigin) return null;
  const editor = new URL("/", editorOrigin);
  editor.searchParams.set("server", new URL(publicUrl).origin);
  editor.searchParams.set("collection", collectionId);
  return editor.href;
}

async function onboardingRow(
  db: DatabaseQueryable,
  userId: string
): Promise<OnboardingRow | null> {
  const result = await db.query<OnboardingRow>(
    `SELECT starter_collection_id, timezone, provisioned_at
     FROM account_onboarding WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

async function collectionStillExists(
  db: DatabaseQueryable,
  userId: string,
  collectionId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM hosted_collections WHERE id = $1 AND user_id = $2`,
    [collectionId, userId]
  );
  return Boolean(result.rows[0]);
}

export interface StarterCollectionRouteOptions extends HostedServiceOptions {
  publicUrl: string;
  editorOrigin?: string;
}
