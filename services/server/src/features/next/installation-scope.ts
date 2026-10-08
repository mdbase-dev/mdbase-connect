// Dedicated installation credentials have explicit UUID scope, independent of
// their account's inventory and their device's historical enrolments.
import type { DatabaseConnection } from "../../database-types.js";
import type { ConnectorIdentity } from "../../platform/request-authentication.js";
import { CreateError, currentMember, exactEnrolment, refuseRevoked } from "./bootstrap-common.js";

/** Ordinary daemons retain their existing controls. Installation identities never
 * become ordinary if their credential row disappears after authentication. */
export async function requireInstallationScope(client: DatabaseConnection, connector: ConnectorIdentity, collection?: string, create = false): Promise<void> {
  if (!connector.installation_device_id) return;
  const row = await client.query<{ create_collections: boolean }>(
    `SELECT k.create_collections FROM installation_device_credentials k
       JOIN connectors c ON c.id=k.connector_id JOIN users u ON u.id=c.user_id
       JOIN next_devices d ON d.id=k.device_id
     WHERE k.connector_id=$1 AND k.device_id=$2 AND c.user_id=$3
       AND c.revoked_at IS NULL AND u.suspended_at IS NULL AND u.account_backend='next'
       AND d.connector_id=c.id AND d.user_id=u.id AND d.kind=k.kind
       AND d.sign_pk=k.sign_pk AND d.kem_pk=k.kem_pk AND d.noise_pk=k.noise_pk
     FOR SHARE OF k,c,u,d`,
    [connector.id,connector.installation_device_id,connector.user_id]
  );
  if (!row.rows[0]) throw new CreateError(403,"installation_not_current");
  if (create && !row.rows[0].create_collections) throw new CreateError(409,"installation_create_consent_required");
  if (collection) {
    const scope = await client.query(
      `SELECT 1 FROM installation_collection_scopes s JOIN next_collections n ON n.collection_id=s.collection_id JOIN users owner ON owner.id=n.owner_user_id
       WHERE s.connector_id=$1 AND s.collection_id=$2 AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL AND owner.suspended_at IS NULL FOR SHARE OF s,n,owner`, [connector.id,collection]);
    if (!scope.rows.length) throw new CreateError(403,"installation_collection_not_approved");
  }
}

/** Scoped metadata, not an enrolment/readiness assertion. Used by the portal before
 * approval and the installation's list after approval. No arbitrary future scope. */
export async function installationCollections(client: DatabaseConnection, account: string, connector?: string, device?: string) {
  const rows = await client.query<{collection_id:string;display_name:string;role:"owner"|"editor"|"viewer"}>(
    `SELECT n.collection_id,
       COALESCE((SELECT h.display_name FROM hosted_collections h WHERE h.id=n.collection_id),
                (SELECT c.display_name FROM collections c WHERE c.local_id=n.collection_id AND c.removed_at IS NULL ORDER BY c.id LIMIT 1),n.collection_id::text) AS display_name,
       member.role
     FROM next_collections n JOIN users owner ON owner.id=n.owner_user_id
     CROSS JOIN LATERAL (
       SELECT e.value->>'op' AS op,e.value->>'role' AS role
       FROM next_policy_outbox o LEFT JOIN next_policy_batches b ON b.id=o.batch_id
       CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') WITH ORDINALITY e(value,ord)
       WHERE o.collection_id=n.collection_id AND e.value->>'account'=$1
         AND (e.value->>'op'='member-remove' OR (e.value->>'op'='member-set' AND b.state='appended' AND b.lost_at IS NULL))
       ORDER BY o.id DESC,e.ord DESC LIMIT 1
     ) member
     WHERE n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL
       AND owner.suspended_at IS NULL AND member.op='member-set'
       AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM installation_collection_scopes s WHERE s.connector_id=$2 AND s.collection_id=n.collection_id))
       AND ($3::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM next_policy_outbox o WHERE o.collection_id=n.collection_id AND o.ops->'ops' @> jsonb_build_array(jsonb_build_object('op','device-revoke','device',$3::uuid::text))))
     ORDER BY n.collection_id LIMIT 1001`, [account,connector??null,device??null]
  );
  if (rows.rows.length>1000) throw new CreateError(409,"installation_scope_limit");
  return rows.rows;
}

/** People access additionally requires a current, acknowledged exact enrolment.
 * Scope alone does not enrol; enrolment alone does not consent. */
export async function installationPeople(client: DatabaseConnection, connector: ConnectorIdentity, collection: string, permission: "identity"|"members", issuer: string) {
  await requireInstallationScope(client,connector,collection);
  const current = await client.query(
    `SELECT 1 FROM next_collections n JOIN users u ON u.id=n.owner_user_id
     WHERE n.collection_id=$1 AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL AND u.suspended_at IS NULL FOR UPDATE OF n`, [collection]
  );
  if (!current.rows.length) throw new CreateError(409,"not_current_cloud_copy");
  await currentMember(client,collection,connector.user_id);
  await refuseRevoked(client,collection,connector.installation_device_id!);
  const device = (await client.query<{sign_pk:Buffer;kem_pk:Buffer;noise_pk:Buffer;kind:"app-runtime"|"mobile"}>("SELECT sign_pk,kem_pk,noise_pk,kind FROM next_devices WHERE id=$1",[connector.installation_device_id])).rows[0];
  if (!device) throw new CreateError(403,"installation_not_current");
  const enrolled = await client.query(
    `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
     WHERE o.collection_id=$1 AND b.state='appended' AND b.lost_at IS NULL AND o.ops->'ops' @> $2::jsonb LIMIT 1`,
    [collection,exactEnrolment(connector.installation_device_id!,connector.user_id,device)]
  );
  if (!enrolled.rows.length) throw new CreateError(409,"not_enrolled");
  const profile = (row:{id:string;public_subject:string;name:string}) => ({issuer,subject:row.public_subject,name:row.name,account_id:row.id});
  if (permission==="identity") {
    const user = (await client.query<{id:string;public_subject:string;name:string}>("SELECT id,public_subject,name FROM users WHERE id=$1 AND suspended_at IS NULL",[connector.user_id])).rows[0];
    if (!user) throw new CreateError(403,"installation_not_current");
    return profile(user);
  }
  const members = await client.query<{id:string;public_subject:string;name:string;role:"owner"|"editor"|"viewer"}>(
    `SELECT u.id,u.public_subject,u.name,m.role FROM users u
     JOIN LATERAL (
       SELECT e.value->>'op' AS op,e.value->>'role' AS role
       FROM next_policy_outbox o LEFT JOIN next_policy_batches b ON b.id=o.batch_id
       CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') WITH ORDINALITY e(value,ord)
       WHERE o.collection_id=$1 AND e.value->>'account'=u.id::text
         AND (e.value->>'op'='member-remove' OR (e.value->>'op'='member-set' AND b.state='appended' AND b.lost_at IS NULL))
       ORDER BY o.id DESC,e.ord DESC LIMIT 1
     ) m ON m.op='member-set' WHERE u.suspended_at IS NULL ORDER BY u.id LIMIT 1001`, [collection]
  );
  if (members.rows.length>1000) throw new CreateError(409,"installation_scope_limit");
  return {members:members.rows.map(row=>({...profile(row),role:row.role}))};
}
