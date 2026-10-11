// Shared native people authority: exact registered device, current collection,
// acknowledged membership/enrolment; installation consent remains additional.
import type { DatabaseConnection, DatabaseQueryable } from "../../database-types.js";
import type { ConnectorIdentity } from "../../platform/request-authentication.js";
import { CreateError, currentCollectionDevice, type Device } from "./bootstrap-common.js";
import { requireInstallationScope } from "./installation-scope.js";

export async function nextDevicePeople(client: DatabaseConnection, connector: ConnectorIdentity, collection: string, deviceId: string, permission: "identity"|"members", issuer: string) {
  await requireInstallationScope(client,connector,collection);
  const device = (await client.query<Device>(
    "SELECT sign_pk,kem_pk,noise_pk,kind FROM next_devices WHERE id=$1 AND connector_id=$2 AND user_id=$3",
    [deviceId,connector.id,connector.user_id]
  )).rows[0];
  if (!device) throw new CreateError(403,"identity_not_current");
  await currentCollectionDevice(client,connector,collection,deviceId,device);
  const profile = (row:{id:string;public_subject:string;name:string}) => ({issuer,subject:row.public_subject,name:row.name,account_id:row.id});
  if (permission==="identity") {
    const user = (await client.query<{id:string;public_subject:string;name:string}>("SELECT id,public_subject,name FROM users WHERE id=$1 AND suspended_at IS NULL",[connector.user_id])).rows[0];
    if (!user) throw new CreateError(403,"identity_not_current");
    return profile(user);
  }
  return nativeCollectionMembers(client,collection,issuer);
}

/** Current members of a native collection, from its acknowledged policy log. */
export async function nativeCollectionMembers(client: DatabaseQueryable, collection: string, issuer: string) {
  const profile = (row:{id:string;public_subject:string;name:string}) => ({issuer,subject:row.public_subject,name:row.name,account_id:row.id});
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
