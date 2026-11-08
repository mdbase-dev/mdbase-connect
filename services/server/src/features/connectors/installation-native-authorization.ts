/** Compose consent, never the two transports' credentials or content scopes. */
import type { ApplicationAuthorizationProof } from "@mdbase-dev/connect-protocol";
import type { DatabaseConnection, DatabaseQueryable } from "../../database-types.js";
import { listNativeCollectionsVisibleToUser } from "../../collection-catalog.js";
import { approveNativeAuthorizationInTransaction, resolveNativeCollectionAccess } from "../authorizations/native-approval-service.js";
import { applicationOriginForRedirect } from "../authorizations/redirects.js";
import { requiresHostedCollection } from "../grants/policy.js";
import { findInstallationApplication } from "../applications/store.js";
import { InstallationPairingError } from "./installation-pairing-error.js";
import { audit } from "../../platform/audit-events.js";

interface Pairing {
  id: string; user_id: string | null; app_id: string; app_origin: string; challenge: Buffer;
}
function refuse(): never {
  throw new InstallationPairingError(409,"installation_native_binding_changed",
    "The original app approval cannot continue. Preserve this sign-in and reconcile.");
}

export async function privateInstallationChoices(db: DatabaseQueryable, user: string, appId: string) {
  const app = await findInstallationApplication(db,appId);
  if (!app || requiresHostedCollection(app.requirements)) return [];
  const choices: {collection_id:string;display_name:string;role:"owner"|"editor"|"viewer";kind:"private"}[] = [];
  for (const collection of await listNativeCollectionsVisibleToUser(db,user)) {
    if (collection.sync !== "private") continue;
    const access = await resolveNativeCollectionAccess(db,user,collection.id,"private");
    if (!access?.actions.has("application.authorize")) continue;
    choices.push({collection_id:collection.id,display_name:access.collection.displayName,role:collection.access.role,kind:"private"});
  }
  return choices;
}

async function boundRequest(db: DatabaseQueryable, pairing: Pairing, id: string, manifest?: string) {
  const r=(await db.query<{
    user_id:string|null;application_id:string;redirect_uri:string|null;flow:string;
    expires_at:Date|string;completed_at:Date|string|null;denied_at:Date|string|null;grant_id:string|null;
    application_authorization:ApplicationAuthorizationProof|null;requested_operations: string[];
    homepage:string;distribution:string;manifest_digest:string;requirements:Parameters<typeof requiresHostedCollection>[0];
    has_client_key:boolean;application_signing_public_key:string|null;
  }>(`SELECT ar.*,a.homepage,a.distribution,a.manifest_digest,a.requirements,
       EXISTS(SELECT 1 FROM next_authorization_client_keys ck WHERE ck.request_id=ar.id) AS has_client_key
     FROM authorization_requests ar JOIN applications a ON a.id=ar.application_id
     WHERE ar.id=$1 FOR UPDATE OF ar`,[id])).rows[0];
  const proof=r?.application_authorization?.binding;
  if (!r || !proof || !pairing.user_id || (r.user_id!==null && r.user_id!==pairing.user_id)
      || r.application_id!==pairing.app_id || proof.application_id!==pairing.app_id
      || proof.authorization_id!==id || proof.authorization_nonce!==pairing.challenge.toString("base64url")
      || proof.application_manifest_digest!==r.manifest_digest || (manifest && manifest!==r.manifest_digest)
      || r.flow!=="authorization_code" || r.distribution!=="web" || !r.has_client_key
      || !r.application_signing_public_key || !r.redirect_uri || requiresHostedCollection(r.requirements)
      || applicationOriginForRedirect(r.redirect_uri,r.homepage)!==pairing.app_origin
      || r.denied_at || new Date(r.expires_at).getTime()<=Date.now()) refuse();
  return r;
}

/** Caller holds the ORIGINAL pairing, current account and portal-session locks. */
export async function attachNativeAuthorization(db: DatabaseQueryable, pairing: Pairing, id: string) {
  const r=await boundRequest(db,pairing,id);
  if (r.completed_at || r.grant_id) refuse();
  const prior=(await db.query<{authorization_request_id:string;account_id:string;manifest_digest:string}>(
    "SELECT * FROM installation_native_authorizations WHERE pairing_id=$1 FOR UPDATE",[pairing.id])).rows[0];
  if (prior && (prior.authorization_request_id!==id || prior.account_id!==pairing.user_id || prior.manifest_digest!==r.manifest_digest)) refuse();
  if (!prior) await db.query(
    "INSERT INTO installation_native_authorizations(pairing_id,authorization_request_id,account_id,manifest_digest) VALUES($1,$2,$3,$4)",
    [pairing.id,id,pairing.user_id,r.manifest_digest]);
  if (r.user_id===null) await db.query("UPDATE authorization_requests SET user_id=$2 WHERE id=$1 AND user_id IS NULL",[id,pairing.user_id]);
  return {request_id:pairing.id,authorization_request_id:id,account_id:pairing.user_id};
}

/** The ONE native approval implementation, inside the same pairing transaction. */
export async function approveInstallationNativeChoice(db: DatabaseConnection, pairing: Pairing, collection: string) {
  const link=(await db.query<{authorization_request_id:string;account_id:string;manifest_digest:string;
    selected_collection_id:string|null;approved_at:Date|string|null}>(
    "SELECT * FROM installation_native_authorizations WHERE pairing_id=$1",[pairing.id])).rows[0];
  if (!link || link.account_id!==pairing.user_id) refuse();
  if (link.approved_at) {
    if (link.selected_collection_id!==collection) refuse();
    return {fresh:false,authorization_request_id:link.authorization_request_id};
  }
  // Same order as attachment: authorization BEFORE linkage (the caller already
  // holds the original account/pairing). A reused request cannot invert locks.
  const r=await boundRequest(db,pairing,link.authorization_request_id,link.manifest_digest);
  await db.query("SELECT pairing_id FROM installation_native_authorizations WHERE pairing_id=$1 FOR UPDATE",[pairing.id]);
  if (r.completed_at || r.grant_id || r.user_id!==pairing.user_id) refuse();
  // Native helper repeats current membership/manifest/capability checks under its
  // canonical collection locks, and publishes the same account-only kind6 grant.
  if (!await approveNativeAuthorizationInTransaction(db,{requestId:link.authorization_request_id,
      userId:pairing.user_id!,collectionId:collection,sync:"private",installationPairingId:pairing.id,
      fileActions:r.application_authorization!.binding.requested_files?.actions??[],operations:r.requested_operations as Parameters<typeof approveNativeAuthorizationInTransaction>[1]["operations"]})) refuse();
  await db.query(`UPDATE installation_native_authorizations SET selected_collection_id=$2,
    grant_id=(SELECT grant_id FROM authorization_requests WHERE id=$3),approved_at=now() WHERE pairing_id=$1`,
    [pairing.id,collection,link.authorization_request_id]);
  return {fresh:true,authorization_request_id:link.authorization_request_id};
}

/** A pairing that ends without the Private choice (cloud-copy approval or
 * cancellation) closes its unused Native companion in the same transaction.
 * Only the original chooser could complete it, so it would otherwise stay
 * pending in the portal until it expired. The SDK cancels its Native port when
 * the pairing finishes without a Native selection, so nothing observes the denial. */
export async function closeUnusedNativeAuthorization(db: DatabaseQueryable, pairingId: string, user: string,
  reason: "superseded_by_installation_approval" | "installation_pairing_denied") {
  const closed=(await db.query<{id:string}>(`UPDATE authorization_requests ar SET completed_at=now(),denied_at=now()
    FROM installation_native_authorizations na
    WHERE na.pairing_id=$1 AND ar.id=na.authorization_request_id AND ar.completed_at IS NULL AND ar.grant_id IS NULL
    RETURNING ar.id`,[pairingId])).rows[0];
  if (closed) await audit(db,user,"authorization.denied",closed.id,{source:"installation_pairing",pairing_id:pairingId,reason});
}
