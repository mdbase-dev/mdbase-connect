// Shared native people authority: exact registered device, current collection,
// acknowledged membership/enrolment; installation consent remains additional.
import type { DatabaseConnection } from "../../database-types.js";
import type { ConnectorIdentity } from "../../platform/request-authentication.js";
import { CreateError, currentIdentity, currentMember, exactEnrolment, refuseRevoked, type Device } from "./bootstrap-common.js";
import { requireInstallationScope } from "./installation-scope.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";

export async function nextDevicePeople(client: DatabaseConnection, connector: ConnectorIdentity, collection: string, deviceId: string, permission: "identity"|"members", issuer: string) {
  await requireInstallationScope(client,connector,collection);
  const device = (await client.query<Device>(
    "SELECT sign_pk,kem_pk,noise_pk,kind FROM next_devices WHERE id=$1 AND connector_id=$2 AND user_id=$3",
    [deviceId,connector.id,connector.user_id]
  )).rows[0];
  if (!device) throw new CreateError(403,"identity_not_current");
  await currentIdentity(client,connector,deviceId,device);
  // Hold actual owner availability before the collection lock; membership
  // mutation takes owner locks first too. Revalidate the discovered ownership.
  const owner = (await client.query<{owner_user_id:string}>(
    `SELECT n.owner_user_id FROM next_collections n JOIN users u ON u.id=n.owner_user_id
     WHERE n.collection_id=$1 AND n.runtime='next' AND n.sync IN ('cloud_copy','private') AND n.left_sync_at IS NULL AND u.suspended_at IS NULL FOR SHARE OF u`, [collection]
  )).rows[0];
  if (!owner) throw new CreateError(409,"not_current_collection");
  const current = await client.query(
    `SELECT 1 FROM next_collections WHERE collection_id=$1 AND owner_user_id=$2
     AND runtime='next' AND sync IN ('cloud_copy','private') AND left_sync_at IS NULL FOR UPDATE`, [collection,owner.owner_user_id]
  );
  if (!current.rows.length) throw new CreateError(409,"not_current_collection");
  try { await requireCollectionNotDeleted(client,collection); }
  catch (error) {
    if (error instanceof Error && error.message === "collection_deleted") throw new CreateError(409,"collection_deleted");
    throw error;
  }
  await currentMember(client,collection,connector.user_id);
  await refuseRevoked(client,collection,deviceId);
  const enrolled = await client.query(
    `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
     WHERE o.collection_id=$1 AND b.state='appended' AND b.lost_at IS NULL AND o.ops->'ops' @> $2::jsonb LIMIT 1`,
    [collection,exactEnrolment(deviceId,connector.user_id,device)]
  );
  if (!enrolled.rows.length) throw new CreateError(409,"not_enrolled");
  const profile = (row:{id:string;public_subject:string;name:string}) => ({issuer,subject:row.public_subject,name:row.name,account_id:row.id});
  if (permission==="identity") {
    const user = (await client.query<{id:string;public_subject:string;name:string}>("SELECT id,public_subject,name FROM users WHERE id=$1 AND suspended_at IS NULL",[connector.user_id])).rows[0];
    if (!user) throw new CreateError(403,"identity_not_current");
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
       ORDER BY CASE WHEN b.state='appended' AND b.lost_at IS NULL THEN 0 ELSE 1 END DESC,
         b.seq DESC NULLS LAST,o.id DESC,e.ord DESC LIMIT 1
     ) m ON m.op='member-set' WHERE u.suspended_at IS NULL ORDER BY u.id LIMIT 1001`, [collection]
  );
  if (members.rows.length>1000) throw new CreateError(409,"people_member_limit");
  return {members:members.rows.map(row=>({...profile(row),role:row.role}))};
}
