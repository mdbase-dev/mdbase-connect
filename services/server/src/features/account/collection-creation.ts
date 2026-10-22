import {randomUUID} from "node:crypto";
import type {DatabaseConnection} from "../../database-types.js";
import type {HostedAuthorityRegistry} from "../../hosted.js";
import {CreateError, inTransaction} from "../next/bootstrap-common.js";
import {requireNextAccountNotMigrationFrozen} from "../next/migration-topology.js";
import {createServiceCloudCopy, currentCloudCopy, type CloudCopyBootstrapOptions} from "../next/service-cloud-copy.js";
import {createHostedCollectionForUser, type HostedServiceOptions} from "../hosted/service.js";

export interface AccountCollectionCreationOptions extends HostedServiceOptions {
  publicUrl: string;
  hostedReference?: HostedAuthorityRegistry;
  native?: CloudCopyBootstrapOptions;
}
export interface AccountCollectionRequest {requestId: string; displayName: string; timezone: string}
interface Intent {
  user_id: string; request_id: string; collection_id: string; display_name: string;
  timezone: string; runtime: "legacy" | "next"; published_at: Date | null;
}
type Principal = (client: DatabaseConnection) => Promise<void>;

async function backend(client: DatabaseConnection, account: string, principal: Principal): Promise<Intent["runtime"]> {
  // Match native onboarding's account-first freeze/session lock ordering.
  await requireNextAccountNotMigrationFrozen(client, account);
  await principal(client);
  const row = (await client.query<{account_backend: string; flipped: boolean}>(
    `SELECT u.account_backend, f.account_id IS NOT NULL AS flipped
     FROM users u LEFT JOIN next_migration_account_flips f ON f.account_id=u.id
     WHERE u.id=$1 AND u.suspended_at IS NULL FOR SHARE OF u`, [account]
  )).rows[0];
  if (!row) throw new CreateError(403, "identity_not_current");
  if (row.account_backend === "next" && row.flipped) return "next";
  if (row.account_backend === "legacy") return "legacy";
  throw new CreateError(409, "account_not_ready");
}
function matches(row: Intent, account: string, input: AccountCollectionRequest): boolean {
  return row.user_id === account && row.request_id === input.requestId && row.display_name === input.displayName && row.timezone === input.timezone;
}
async function claim(options: AccountCollectionCreationOptions, account: string, input: AccountCollectionRequest, principal: Principal): Promise<Intent> {
  return inTransaction(options.db, async client => {
    const runtime = await backend(client, account, principal);
    await client.query(
      `INSERT INTO account_collection_creations(user_id,request_id,collection_id,display_name,timezone,runtime)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,request_id) DO NOTHING`,
      [account, input.requestId, randomUUID(), input.displayName, input.timezone, runtime]
    );
    const row = (await client.query<Intent>(
      "SELECT * FROM account_collection_creations WHERE user_id=$1 AND request_id=$2 FOR SHARE", [account, input.requestId]
    )).rows[0];
    if (!row || !matches(row, account, input)) throw new CreateError(409, "creation_intent_mismatch");
    if (row.runtime !== runtime) throw new CreateError(409, "creation_backend_changed");
    return row;
  });
}
async function original(client: DatabaseConnection, intent: Intent, principal: Principal): Promise<void> {
  const runtime = await backend(client, intent.user_id, principal);
  const row = (await client.query<Intent>(
    `SELECT * FROM account_collection_creations WHERE user_id=$1 AND request_id=$2 FOR ${intent.runtime === "legacy" ? "UPDATE" : "SHARE"}`, [intent.user_id, intent.request_id]
  )).rows[0];
  if (!row || row.collection_id !== intent.collection_id || row.runtime !== intent.runtime || runtime !== intent.runtime ||
      row.display_name !== intent.display_name || row.timezone !== intent.timezone) throw new CreateError(409, "creation_intent_mismatch");
}
async function publish(client: DatabaseConnection, intent: Intent): Promise<void> {
  const marked = await client.query(
    `UPDATE account_collection_creations SET published_at=COALESCE(published_at,now())
     WHERE user_id=$1 AND request_id=$2 AND collection_id=$3 AND display_name=$4 AND timezone=$5 AND runtime=$6 RETURNING 1`,
    [intent.user_id, intent.request_id, intent.collection_id, intent.display_name, intent.timezone, intent.runtime]
  );
  if (!marked.rows.length) throw new CreateError(409, "creation_intent_mismatch");
}
async function readPublished(client: DatabaseConnection, intent: Intent): Promise<{id: string; display_name: string}> {
  if (intent.runtime === "next") await currentCloudCopy(client, intent.collection_id, intent.user_id);
  const result = intent.runtime === "next"
    ? await client.query<{id: string; display_name: string}>("SELECT collection_id AS id,display_name FROM next_collections WHERE collection_id=$1 AND owner_user_id=$2", [intent.collection_id, intent.user_id])
    : await client.query<{id: string; display_name: string}>("SELECT id,display_name FROM hosted_collections WHERE id=$1 AND user_id=$2 AND authority_state='active' FOR SHARE", [intent.collection_id, intent.user_id]);
  if (!result.rows[0]) throw new CreateError(404, "collection_unavailable");
  return result.rows[0];
}
/** Metadata-only account creation. Original UUID/name/runtime survive unknown
 * outcomes. No pairing, browser device, content grant or readiness assertion. */
export async function createAccountCollection(options: AccountCollectionCreationOptions, account: string, input: AccountCollectionRequest, principal: Principal) {
  const intent = await claim(options, account, input, principal);
  const current = (client: DatabaseConnection) => original(client, intent, principal);
  if (intent.published_at !== null) return inTransaction(options.db, async client => {await current(client); return readPublished(client, intent);});
  if (intent.runtime === "next") {
    if (!options.native) throw new CreateError(503, "not_ready");
    await createServiceCloudCopy(options.native, {collection: intent.collection_id, owner: account, runtime: "next", displayName: intent.display_name, current});
    return inTransaction(options.db, async client => {
      await current(client); const result = await readPublished(client, intent); await publish(client, intent); return result;
    });
  }
  // The legacy creator holds its guard through provider effects. Publication is
  // recorded IN that metadata transaction, so a deleted acknowledged collection
  // cannot be recreated by a lost-response retry.
  await createHostedCollectionForUser(options, options.hostedReference, options.publicUrl, account, intent.display_name, "mdbase", intent.timezone,
    {collectionId: intent.collection_id, current, published: client => publish(client, intent), alreadyPublished: async client => {
      const row = (await client.query<Intent>("SELECT * FROM account_collection_creations WHERE user_id=$1 AND request_id=$2", [account,input.requestId])).rows[0];
      if (row?.published_at === null) return false;
      await readPublished(client,intent); return true;
    }});
  return inTransaction(options.db, async client => {await current(client); return readPublished(client, intent);});
}
