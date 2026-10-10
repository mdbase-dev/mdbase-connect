/** Installation devices extend daemon pairing, never application OAuth grants.
 * Public account selection precedes key custody; attestation precedes explicit
 * device approval. Original request/tuple and outcome are immutable. */
import { createHmac, randomBytes, randomUUID, verify } from "node:crypto";
import type { DatabasePool } from "../../database-types.js";
import { tokenHash, randomToken } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import {
  clientFingerprint,
  deviceRegistrationDigest,
  weakSigningKey,
  weakAgreementKey,
} from "../next/devices.js";
import { ed25519PublicKeyObject } from "../next/policy-keys.js";
import { currentMember, currentSession, inTransaction, lock, refuseRevoked } from "../next/bootstrap-common.js";
import type { ConnectorIdentity } from "../../platform/request-authentication.js";
import { installationCollections, requireInstallationScope } from "../next/installation-scope.js";
import { queueNextPolicy } from "../next/policy-outbox.js";
import { findInstallationApplication } from "../applications/store.js";
export class InstallationPairingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: string, status = 409): never => {
  throw new InstallationPairingError(
    status,
    code,
    "The original device sign-in cannot continue. Preserve its state and reconcile.",
  );
};
const strict = (): never => {
  throw new InstallationPairingError(
    403,
    "strict_device_approval",
    "this account uses strict device approval; add this device from your desktop",
  );
};
/** Registry-owned installation authorization, not a caller URL/declaration.
 * Origin is mandatory (including native) and matches the exact environment/kind. */
export async function installationApp(db: DatabasePool, environment: string | undefined, appId: string, origin: string | undefined, kind: "app-runtime" | "mobile") {
  if (!environment || !["lab", "staging", "production"].includes(environment) || !origin) return fail("installation_app_not_allowed", 403);
  const app = await findInstallationApplication(db, appId);
  if (!app) return fail("installation_app_not_allowed", 403);
  const config = app.installation_origins;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid registered installation origins.");
  const policy = Object.hasOwn(config, environment) ? config[environment as keyof typeof config] : undefined;
  if (policy === undefined) return fail("installation_app_not_allowed", 403);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Invalid registered installation origin policy.");
  const allowed = Object.hasOwn(policy, kind) ? policy[kind] : undefined;
  if (allowed === undefined) return fail("installation_app_not_allowed", 403);
  if (!Array.isArray(allowed) || allowed.some(value => typeof value !== "string" || !value.length)) throw new Error("Invalid registered installation origins.");
  if (!allowed.includes(origin)) return fail("installation_app_not_allowed", 403);
  if (!app.name || !app.family_identity) throw new Error("Invalid registered installation identity.");
  return Object.freeze({ id: app.id, origin, name: app.name });
}
type Connection = Awaited<ReturnType<DatabasePool["connect"]>>;
interface Row {
  id: string;
  connector_name: string;
  secret_hash: string;
  user_id: string | null;
  approved_at: Date | string | null;
  consumed_at: Date | string | null;
  expires_at: Date | string;
  installation_id: string;
  previous_pairing_id: string | null;
  app_id: string;
  app_origin: string;
  revoked_at: Date | string | null;
  device_id: string;
  connector_id: string;
  kind: "app-runtime" | "mobile";
  challenge: Buffer;
  account_selected_at: Date | string | null;
  portal_account_confirmed_at: Date | string | null;
  portal_account_email: string | null;
  portal_account_session_id: string | null;
  portal_account_session_epoch: string | number | null;
  selected_collection_id: string | null;
  created_collection_ids: string[];
  sign_pk: Buffer | null;
  kem_pk: Buffer | null;
  noise_pk: Buffer | null;
  registration_sig: Buffer | null;
  attested_at: Date | string | null;
  requested_create_collections: boolean;
  approved_create_collections: boolean;
  approved_collection_ids: string[];
  scope_only: boolean;
  approved_session_epoch: string | number | null;
}
const tx = inTransaction;
async function row(
  c: Pick<Connection, "query">,
  id: string,
  secret?: string,
  lock = false,
  includeRevoked = false,
): Promise<Row> {
  const found = await c.query<Row>(
    `SELECT p.*, i.installation_id,i.previous_pairing_id,i.app_id,i.app_origin,i.device_id,i.connector_id,i.kind,i.challenge,i.account_selected_at,COALESCE(i.sign_pk,k.sign_pk) AS sign_pk,COALESCE(i.kem_pk,k.kem_pk) AS kem_pk,COALESCE(i.noise_pk,k.noise_pk) AS noise_pk,i.registration_sig,i.attested_at,i.requested_create_collections,i.approved_create_collections,i.approved_collection_ids,i.scope_only,i.approved_session_epoch,i.portal_account_confirmed_at,i.portal_account_email,i.portal_account_session_id,i.portal_account_session_epoch,i.selected_collection_id,i.created_collection_ids FROM pairing_requests p JOIN installation_device_pairings i ON i.pairing_id=p.id LEFT JOIN installation_device_credentials k ON k.connector_id=i.connector_id AND i.scope_only WHERE p.id=$1 ${includeRevoked ? "" : "AND p.revoked_at IS NULL"} ${secret === undefined ? "" : "AND p.secret_hash=$2"} ${lock ? "FOR UPDATE OF p,i" : ""}`,
    [id, ...(secret === undefined ? [] : [tokenHash(secret)])],
  );
  const r = found.rows[0];
  if (!r) fail("installation_pairing_not_found", 404);
  return r;
}
function live(r: Row): void {
  if (new Date(r.expires_at).getTime() <= Date.now())
    fail("installation_pairing_expired", 404);
}
async function active(
  c: Pick<Connection, "query">,
  user: string,
  lock = false,
  allowLegacy = false,
): Promise<void> {
  const account = (await c.query<{ account_backend: string }>(
    `SELECT account_backend FROM users WHERE id=$1 AND suspended_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [user],
  )).rows[0];
  if (!account) fail("installation_account_unavailable", 403);
  if (!allowLegacy && account.account_backend === "legacy")
    throw new InstallationPairingError(409, "installation_legacy_backend", "This account still uses the legacy backend. Finish migrating the account before approving this device sign-in.");
  if (account.account_backend !== "legacy" && account.account_backend !== "next")
    throw new Error("Account backend marker is unavailable or invalid.");
}
async function ordinary(
  c: Pick<Connection, "query">,
  user: string,
): Promise<void> {
  if (
    (
      await c.query<{ mode: string }>(
        "SELECT mode FROM next_account_keys WHERE user_id=$1",
        [user],
      )
    ).rows[0]?.mode === "strict"
  )
    strict();
}
function portalConfirmation(r: Row) {
  return r.portal_account_confirmed_at ? {
    account_email: r.portal_account_email!,
    account_selection_confirmed: true as const,
  } : {};
}
function collectionSelection(r: Row) {
  return r.selected_collection_id ? {
    selected_collection_id: r.selected_collection_id,
    created_collection_ids: r.created_collection_ids,
  } : {};
}
function selection(r: Row) {
  return {
    ...portalConfirmation(r),
    request_id: r.id,
    account_id: r.user_id,
    connector_id: r.connector_id,
    device_id: r.device_id,
    installation_id: r.installation_id,
    kind: r.kind,
    challenge: r.challenge.toString("hex"),
    approval_mode: "password-ak1" as const,
    app_id: r.app_id,
    app_origin: r.app_origin,
    expires_at: new Date(r.expires_at).getTime(),
  };
}
export async function installationPairingExists(
  db: DatabasePool,
  id: string,
): Promise<boolean> {
  return !!(
    await db.query(
      "SELECT pairing_id FROM installation_device_pairings WHERE pairing_id=$1",
      [id],
    )
  ).rows[0];
}
export async function startInstallationPairing(
  db: DatabasePool,
  input: { request_id: string; pairing_secret: string; installation_id: string; device_id: string; kind: "app-runtime" | "mobile"; requested_create_collections?: boolean; reconsent?: boolean; renewal?: { request_id: string; pairing_secret: string } },
  app: Awaited<ReturnType<typeof installationApp>>,
  publicUrl: string,
  existingConnector?: ConnectorIdentity,
) {
  return tx(db, async c => {
    // Serialize both identifiers, in a stable order. A new attempt may not
    // replace an active window or a registered actor, including cross-ID drift.
    for (const key of [`installation:${input.installation_id}`, `device:${input.device_id}`].sort())
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,20261008))", [key]);
    const already = await c.query("SELECT id FROM pairing_requests WHERE id=$1", [input.request_id]);
    if (!already.rows[0]) {
      const priorIds = await c.query<{pairing_id:string}>("SELECT pairing_id FROM installation_device_pairings WHERE installation_id=$1 OR device_id=$2", [input.installation_id,input.device_id]);
      const registered = await c.query("SELECT device_id FROM installation_device_credentials WHERE installation_id=$1 OR device_id=$2", [input.installation_id,input.device_id]);
      if (input.reconsent) {
        if (input.renewal || !existingConnector?.installation_device_id) return fail("installation_credential_required",403);
        await requireInstallationScope(c,existingConnector);
        const k = (await c.query<{connector_id:string;sign_pk:Buffer;kem_pk:Buffer;noise_pk:Buffer}>(
          "SELECT connector_id,sign_pk,kem_pk,noise_pk FROM installation_device_credentials WHERE connector_id=$1 AND installation_id=$2 AND device_id=$3 AND kind=$4 AND app_id=$5 AND app_origin=$6 FOR SHARE",
          [existingConnector.id,input.installation_id,input.device_id,input.kind,app.id,app.origin]
        )).rows[0];
        if (!k) return fail("installation_original_binding_changed");
        await active(c,existingConnector.user_id,true);
        await ordinary(c,existingConnector.user_id);
        await c.query("INSERT INTO pairing_requests(id,secret_hash,connector_name,user_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",[input.request_id,tokenHash(input.pairing_secret),app.name,existingConnector.user_id]);
        // Re-consent uses the current authenticated credential, not a fabricated
        // device attestation or a second registration. The public keys are read
        // from that credential even if the original pairing window was pruned.
        await c.query("INSERT INTO installation_device_pairings(pairing_id,installation_id,device_id,connector_id,app_id,app_origin,kind,challenge,account_selected_at,requested_create_collections,scope_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,true)",[input.request_id,input.installation_id,input.device_id,k.connector_id,app.id,app.origin,input.kind,randomBytes(32),input.requested_create_collections??false]);
      } else {
      if (registered.rows[0]) return fail("installation_already_registered");
      let prior: Row | null = null;
      if (priorIds.rows.length) {
        if (!input.renewal) return fail("installation_original_window_required");
        prior = await row(c,input.renewal.request_id,input.renewal.pairing_secret,true,true);
        if (prior.consumed_at || (!prior.revoked_at && new Date(prior.expires_at).getTime()>Date.now())) return fail("installation_window_not_closed");
        if (prior.scope_only || prior.requested_create_collections!==(input.requested_create_collections??false) || prior.installation_id!==input.installation_id || prior.device_id!==input.device_id || prior.kind!==input.kind || prior.app_id!==app.id || prior.app_origin!==app.origin) return fail("installation_original_binding_changed");
        // Only the latest closed window can be renewed. An already-created
        // successor blocks a parallel renewal, even if its parent was denied.
        const successors = await c.query("SELECT pairing_id FROM installation_device_pairings WHERE previous_pairing_id=$1", [prior.id]);
        if (successors.rows[0]) return fail("installation_original_window_required");
        if (prior.user_id) { await active(c,prior.user_id); await ordinary(c,prior.user_id); }
        await c.query("UPDATE pairing_requests SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [prior.id]);
      } else if (input.renewal) return fail("installation_original_window_required");
      await c.query("INSERT INTO pairing_requests(id,secret_hash,connector_name,user_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [input.request_id,tokenHash(input.pairing_secret),app.name,prior?.user_id??null]);
      // A renewed window retains the SAME attested key, challenge, connector,
      // account and signature. A denial requires explicit SAME-account selection
      // again before approval; expiry alone retains the previous selection.
      await c.query("INSERT INTO installation_device_pairings(pairing_id,previous_pairing_id,installation_id,device_id,connector_id,app_id,app_origin,kind,challenge,account_selected_at,sign_pk,kem_pk,noise_pk,registration_sig,attested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [input.request_id,prior?.id??null,input.installation_id,input.device_id,prior?.connector_id??randomUUID(),app.id,app.origin,input.kind,prior?.challenge??randomBytes(32),prior?.revoked_at?null:prior?.account_selected_at??null,prior?.sign_pk??null,prior?.kem_pk??null,prior?.noise_pk??null,prior?.registration_sig??null,prior?.attested_at??null]);
      await c.query("UPDATE installation_device_pairings SET requested_create_collections=$2 WHERE pairing_id=$1",[input.request_id,input.requested_create_collections??false]);
      }
    }
    const r = await row(c,input.request_id,input.pairing_secret,true);
    if (r.scope_only!==(input.reconsent??false) || r.requested_create_collections!==(input.requested_create_collections??false)) return fail("installation_original_binding_changed");
    if (r.scope_only) {
      if (!existingConnector?.installation_device_id || r.connector_id!==existingConnector.id || r.device_id!==existingConnector.installation_device_id) return fail("installation_credential_required",403);
      await requireInstallationScope(c,existingConnector);
    }
    if (r.installation_id!==input.installation_id || r.device_id!==input.device_id || r.kind!==input.kind || r.app_id!==app.id || r.app_origin!==app.origin || r.previous_pairing_id!==(input.renewal?.request_id??null)) return fail("installation_original_binding_changed");
    if (!r.consumed_at) live(r);
    return {pairing_id:r.id,pairing_secret:input.pairing_secret,verification_uri:`${publicUrl}/pair/${r.id}`,expires_in:Math.max(0,Math.floor((new Date(r.expires_at).getTime()-Date.now())/1000)),installation_device:true,app_id:r.app_id,app_origin:r.app_origin,app_name:r.connector_name};
  });
}
export async function inspectInstallationPairing(
  db: DatabasePool,
  id: string,
  user: string,
  canCreateCollection = false,
) {
  const r = await row(db, id);
  live(r);
  if (r.user_id && r.user_id !== user)
    fail("installation_account_changed", 403);
  return {
    pairing: {
      id: r.id,
      connector_name: r.connector_name,
      approved_at: r.approved_at,
      consumed_at: r.consumed_at,
      expires_at: r.expires_at,
      installation_device: true,
      kind: r.kind,
      app_id: r.app_id,
      app_origin: r.app_origin,
      account_selected: !!r.account_selected_at,
      ...portalConfirmation(r),
      // Current signed-in account is display-only before explicit confirmation.
      signed_in_account_email: (await db.query<{email:string}>("SELECT email FROM users WHERE id=$1",[user])).rows[0]?.email,
      selected_collection_id: r.selected_collection_id,
      creation: (await db.query<{collection_id:string;display_name:string;completed:boolean}>("SELECT collection_id,display_name,completed_at IS NOT NULL AS completed FROM installation_pairing_collection_creations WHERE pairing_id=$1",[id])).rows[0] ?? null,
      attested: r.scope_only || !!r.attested_at,
      fingerprint: r.sign_pk ? clientFingerprint(r.sign_pk) : null,
      requested_create_collections: r.requested_create_collections,
      can_create_collection: canCreateCollection && r.requested_create_collections,
      approved_create_collections: r.approved_create_collections,
      approved_collection_ids: r.approved_collection_ids,
      scope_only: r.scope_only,
      retained_collection_ids: r.scope_only ? (await db.query<{collection_id:string}>("SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1 ORDER BY collection_id",[r.connector_id])).rows.map(row=>row.collection_id) : [],
      retained_create_collections: r.scope_only ? (await db.query<{create_collections:boolean}>("SELECT create_collections FROM installation_device_credentials WHERE connector_id=$1",[r.connector_id])).rows[0]?.create_collections??false : false,
      collections: r.account_selected_at ? await tx(db,c=>installationCollections(c,user,undefined,r.device_id)) : [],
    },
  };
}
export async function selectInstallationAccount(
  db: DatabasePool,
  id: string,
  user: string,
  session: string,
) {
  return tx(db, async (c) => {
    await active(c, user, true);
    await currentSession(c, session, user);
    await ordinary(c, user);
    const r = await row(c, id, undefined, true);
    live(r);
    if (r.user_id && r.user_id !== user)
      fail("installation_account_changed", 403);
    if (!r.portal_account_confirmed_at && (r.approved_at || r.consumed_at))
      fail("installation_approval_already_recorded");
    if (!r.account_selected_at) {
      await c.query("UPDATE pairing_requests SET user_id=$2 WHERE id=$1", [
        id,
        user,
      ]);
      await c.query(
        "UPDATE installation_device_pairings SET account_selected_at=now() WHERE pairing_id=$1",
        [id],
      );
    }
    // This authenticated click, not account_selected_at copied by renewal or
    // re-consent, is the SDK's exact-request portal confirmation evidence.
    if (!r.portal_account_confirmed_at) {
      await c.query(`UPDATE installation_device_pairings SET
        portal_account_confirmed_at=now(),portal_account_email=u.email,
        portal_account_session_id=$3,portal_account_session_epoch=u.session_epoch
        FROM users u WHERE pairing_id=$1 AND u.id=$2`,[id,user,session]);
    }
    return { ok: true };
  });
}
/** Current original request/session boundary for the canonical portal creator.
 * Called before and after every await; network work never runs under these locks. */
export async function currentInstallationPairingPortal(c: Connection, id: string, user: string, session: string): Promise<void> {
  await active(c,user,true);
  await currentSession(c,session,user);
  await ordinary(c,user);
  const r = await row(c,id,undefined,true);
  live(r);
  if (r.user_id!==user) fail("installation_account_changed",403);
  if (r.approved_at || r.consumed_at) fail("installation_approval_already_recorded");
  const epoch = (await c.query<{session_epoch:string|number}>("SELECT session_epoch FROM users WHERE id=$1",[user])).rows[0]?.session_epoch;
  if (!r.portal_account_confirmed_at || String(epoch)!==String(r.portal_account_session_epoch)) fail("installation_account_confirmation_required",403);
  if (!r.attested_at && !r.scope_only) fail("installation_attestation_required");
  if (!r.requested_create_collections) fail("installation_creation_not_requested",403);
  if (r.scope_only) await requireInstallationScope(c,{id:r.connector_id,user_id:user,installation_device_id:r.device_id});
}
export async function attestInstallationPairing(
  db: DatabasePool,
  id: string,
  secret: string,
  input: { sign_pk: string; kem_pk: string; noise_pk: string; sig: string },
) {
  const signPk = Buffer.from(input.sign_pk, "hex"),
    kemPk = Buffer.from(input.kem_pk, "hex"),
    noisePk = Buffer.from(input.noise_pk, "hex"),
    sig = Buffer.from(input.sig, "hex");
  if (
    signPk.length !== 32 ||
    kemPk.length !== 32 ||
    noisePk.length !== 32 ||
    sig.length !== 64 ||
    weakSigningKey(signPk) ||
    weakAgreementKey(kemPk) ||
    weakAgreementKey(noisePk)
  )
    fail("installation_invalid_key", 400);
  return tx(db, async (c) => {
    const r = await row(c, id, secret, true);
    live(r);
    if (r.scope_only) return fail("installation_already_registered");
    if (!r.user_id || !r.account_selected_at)
      return fail("installation_account_not_selected");
    await active(c, r.user_id);
    await ordinary(c, r.user_id);
    const digest = deviceRegistrationDigest({
      challenge: r.challenge,
      connectorId: r.connector_id,
      deviceId: r.device_id,
      signPk,
      kemPk,
      noisePk,
    });
    if (!verify(null, digest, ed25519PublicKeyObject(signPk), sig))
      fail("installation_invalid_attestation", 400);
    if (r.attested_at) {
      if (
        !r.sign_pk?.equals(signPk) ||
        !r.kem_pk?.equals(kemPk) ||
        !r.noise_pk?.equals(noisePk) ||
        !r.registration_sig?.equals(sig)
      )
        fail("installation_original_key_changed");
      return { ok: true };
    }
    if (r.approved_at || r.consumed_at)
      fail("installation_original_binding_changed");
    await c.query(
      "UPDATE installation_device_pairings SET sign_pk=$2,kem_pk=$3,noise_pk=$4,registration_sig=$5,attested_at=now() WHERE pairing_id=$1",
      [id, signPk, kemPk, noisePk, sig],
    );
    return { ok: true };
  });
}
export async function approveInstallationPairing(
  db: DatabasePool,
  id: string,
  user: string,
  session: string,
  fingerprint: string,
  consent: {collection_ids:string[];create_collections:boolean;selected_collection_id?:string} = {collection_ids:[],create_collections:false},
) {
  return tx(db, async (c) => {
    await active(c, user, true);
    await currentSession(c, session, user);
    await ordinary(c, user);
    const r = await row(c, id, undefined, true);
    live(r);
    if (r.user_id !== user || !r.account_selected_at || (!r.attested_at && !r.scope_only))
      fail("installation_attestation_required");
    if (!r.sign_pk || fingerprint !== clientFingerprint(r.sign_pk)) return fail("installation_fingerprint_changed", 403);
    const selected = consent.selected_collection_id ?? null;
    // Manual legacy approval remains supported, but can never fabricate the
    // guarded SDK's portal confirmation or collection-selection provenance.
    if (selected) {
      const epoch = (await c.query<{session_epoch:string|number}>("SELECT session_epoch FROM users WHERE id=$1",[user])).rows[0]?.session_epoch;
      if (!r.portal_account_confirmed_at || String(epoch)!==String(r.portal_account_session_epoch))
        fail("installation_account_confirmation_required",403);
    }
    const ids = [...consent.collection_ids].sort();
    if (new Set(ids).size!==ids.length || ids.length>1000 || (consent.create_collections && !r.requested_create_collections)) return fail("installation_invalid_scope",400);
    if (r.approved_at && (r.approved_create_collections!==consent.create_collections || r.selected_collection_id!==selected || JSON.stringify([...r.approved_collection_ids].sort())!==JSON.stringify(ids))) return fail("installation_approved_scope_changed");
    if (!r.approved_at) {
      if (selected && !ids.includes(selected)) {
        const retained = r.scope_only && (await c.query("SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[r.connector_id,selected])).rows.length;
        if (!retained) fail("installation_invalid_scope",400);
      }
      if (selected) {
        await currentMember(c,selected,user);
        await refuseRevoked(c,selected,r.device_id);
        const current = await c.query("SELECT 1 FROM next_collections n JOIN users owner ON owner.id=n.owner_user_id WHERE n.collection_id=$1 AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL AND owner.suspended_at IS NULL FOR SHARE OF n,owner",[selected]);
        if (!current.rows.length) fail("installation_collection_unavailable",403);
      }
      for (const collection of ids) {
        const current = await c.query("SELECT 1 FROM next_collections n JOIN users owner ON owner.id=n.owner_user_id WHERE n.collection_id=$1 AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL AND owner.suspended_at IS NULL FOR SHARE OF n,owner",[collection]);
        if (!current.rows.length) return fail("installation_collection_unavailable",403);
        await currentMember(c,collection,user);
        await refuseRevoked(c,collection,r.device_id);
      }
      if (selected && (await c.query("SELECT 1 FROM installation_pairing_collection_creations WHERE pairing_id=$1 AND collection_id=$2 AND completed_at IS NULL",[id,selected])).rows.length)
        fail("installation_creation_incomplete",503);
      const created = selected ? (await c.query<{collection_id:string}>("SELECT collection_id FROM installation_pairing_collection_creations WHERE pairing_id=$1 AND completed_at IS NOT NULL AND collection_id=ANY($2::uuid[]) ORDER BY collection_id",[id,ids])).rows.map(row=>row.collection_id) : [];
      await c.query("UPDATE installation_device_pairings SET approved_collection_ids=$2,approved_create_collections=$3,approved_session_epoch=(SELECT session_epoch FROM users WHERE id=$4),selected_collection_id=$5,created_collection_ids=$6 WHERE pairing_id=$1",[id,ids,consent.create_collections,user,selected,created]);
      await c.query(
        "UPDATE pairing_requests SET approved_at=now(),expires_at=GREATEST(expires_at,now()+interval '10 minutes') WHERE id=$1",
        [id],
      );
      await audit(c, user, "device.installation_approved", id, {
        kind: r.kind,
        installation_id: r.installation_id,
        device_id: r.device_id,
      });
    }
    return { ok: true, installation_device: true };
  });
}
export async function denyInstallationPairing(
  db: DatabasePool,
  id: string,
  user: string,
  session: string,
) {
  return tx(db, async (c) => {
    // Cancellation remains possible even if migration was rolled back.
    await active(c, user, true, true);
    await currentSession(c, session, user);
    const r = await row(c, id, undefined, true);
    live(r);
    if (r.user_id && r.user_id !== user)
      fail("installation_account_changed", 403);
    if (r.consumed_at) fail("installation_already_registered");
    await c.query("UPDATE pairing_requests SET revoked_at=now() WHERE id=$1", [
      id,
    ]);
    return { ok: true };
  });
}
/** Separate explicit removal, never an implicit re-consent side effect. One
 * registered app family, one account and one collection; all its installations.
 * Native revocation is permanent for these device/collection pairs. */
export async function removeInstallationAccess(db:DatabasePool,id:string,user:string,session:string,collection:string) {
  return tx(db,async c=>{
    await currentSession(c,session,user);
    const r=await row(c,id,undefined,true);
    live(r);
    if (!r.scope_only || r.user_id!==user) return fail("installation_account_changed",403);
    const app = await findInstallationApplication(c,r.app_id);
    if (!app?.family_identity) return fail("installation_app_not_allowed",403);
    await lock(c,collection);
    const target=await c.query("SELECT 1 FROM next_collections WHERE collection_id=$1 AND runtime='next' FOR UPDATE",[collection]);
    if (!target.rows.length) return fail("installation_collection_unavailable",404);
    // Registered declaration family, not the caller-controlled name or origin.
    // #653's database hook enqueues each immutable log grant's revoke atomically.
    await c.query(`UPDATE grants g SET revoked_at=now() FROM applications a
      WHERE a.id=g.application_id AND a.family_identity=$3
        AND g.user_id=$1 AND g.revoked_at IS NULL
        AND (g.hosted_collection_id=$2 OR g.collection_id IN (SELECT id FROM collections WHERE local_id=$2))`,[user,collection,app.family_identity]);
    const installations=await c.query<{connector_id:string;device_id:string}>(
      `SELECT k.connector_id,k.device_id FROM installation_device_credentials k JOIN connectors c ON c.id=k.connector_id
       JOIN applications a ON a.id::text=k.app_id
       WHERE c.user_id=$1 AND a.family_identity=$2 ORDER BY k.connector_id FOR UPDATE OF k`,[user,app.family_identity]);
    for (const k of installations.rows) {
      const enrolled=await c.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb LIMIT 1",[collection,JSON.stringify([{op:"device-enrol",device:k.device_id}])]);
      const revoked=await c.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> $2::jsonb LIMIT 1",[collection,JSON.stringify([{op:"device-revoke",device:k.device_id}])]);
      if (enrolled.rows.length && !revoked.rows.length) {
        if (!await queueNextPolicy(c,collection,[{op:"device-revoke",device:k.device_id}])) return fail("installation_collection_unavailable",409);
      }
      await c.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[k.connector_id,collection]);
    }
    await audit(c,user,"device.installation_access_removed",collection,{app_id:r.app_id});
    return {ok:true,state:"revoking" as const,collection_id:collection};
  });
}

/** Secret-capability KDF, not a device signer. No reversible bearer in server DB.
 * Original immutable public outcome + the SAME authenticated pairing secret
 * reproduce the SAME scoped credential after a lost committed response. */
function credential(r: Row, secret: string): string {
  return `idev_${createHmac("sha256", secret)
    .update("mdbase/v1/installation-device-credential\0")
    .update(
      JSON.stringify([
        r.id,
        r.user_id,
        r.connector_id,
        r.device_id,
        r.installation_id,
        r.kind,
        r.app_id,
        r.app_origin,
        r.sign_pk!.toString("hex"),
        r.kem_pk!.toString("hex"),
        r.noise_pk!.toString("hex"),
      ]),
    )
    .digest("base64url")}`;
}
/** Add only after explicit consent, under the same credential lock used by
 * creates/mints. Recheck membership at exchange, not just at portal approval.
 * Re-consent never removes access or revokes a device as a hidden side effect. */
async function persistScope(c: Connection, r: Row): Promise<void> {
  await c.query("UPDATE installation_device_credentials SET create_collections=create_collections OR $2 WHERE connector_id=$1",[r.connector_id,r.approved_create_collections]);
  if (r.scope_only && r.selected_collection_id && !r.approved_collection_ids.includes(r.selected_collection_id)) {
    const retained = await c.query("SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2",[r.connector_id,r.selected_collection_id]);
    if (!retained.rows.length) fail("installation_collection_unavailable",403);
  }
  for (const collection of [...new Set([...r.approved_collection_ids,...(r.selected_collection_id?[r.selected_collection_id]:[])])].sort()) {
    const current = await c.query("SELECT 1 FROM next_collections n JOIN users owner ON owner.id=n.owner_user_id WHERE n.collection_id=$1 AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL AND owner.suspended_at IS NULL FOR UPDATE OF n",[collection]);
    if (!current.rows.length) return fail("installation_collection_unavailable",403);
    await currentMember(c,collection,r.user_id!);
    await refuseRevoked(c,collection,r.device_id);
  }
  for (const collection of r.approved_collection_ids)
    await c.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[r.connector_id,collection]);
}
export async function exchangeInstallationPairing(
  db: DatabasePool,
  id: string,
  secret: string,
) {
  return tx(db, async (c) => {
    const initial = await row(c, id, secret);
    if (!initial.user_id || !initial.account_selected_at) {
      live(initial);
      return { status: "pending" as const };
    }
    // Match daemon lock order: account BEFORE request, and recheck after locking.
    await active(c, initial.user_id, true);
    const r = await row(c, id, secret, true);
    if (r.user_id !== initial.user_id) fail("installation_account_changed");
    if (!r.consumed_at) {
      live(r);
      await ordinary(c, r.user_id!);
    }
    if (!r.attested_at && !r.scope_only)
      return { status: "account_selected" as const, ...selection(r) };
    if (!r.approved_at)
      return { status: "awaiting_approval" as const, ...selection(r) };
    if (r.scope_only) {
      const identity = {id:r.connector_id,user_id:r.user_id!,installation_device_id:r.device_id};
      await requireInstallationScope(c,identity);
      if (!r.consumed_at) {
        const epoch = (await c.query<{session_epoch:string|number}>("SELECT session_epoch FROM users WHERE id=$1",[r.user_id])).rows[0]?.session_epoch;
        if (r.approved_session_epoch===null || String(epoch)!==String(r.approved_session_epoch)) return fail("installation_approval_not_current",403);
        await persistScope(c,r);
        await c.query("UPDATE pairing_requests SET consumed_at=now() WHERE id=$1",[id]);
      }
      return {status:"scope_updated" as const,...selection(r),...collectionSelection(r),added_collection_ids:r.approved_collection_ids,approved_create_collections:r.approved_create_collections};
    }
    const token = credential(r, secret);
    if (!r.consumed_at) {
      if (r.portal_account_confirmed_at) {
        const epoch = (await c.query<{session_epoch:string|number}>("SELECT session_epoch FROM users WHERE id=$1",[r.user_id])).rows[0]?.session_epoch;
        if (r.approved_session_epoch===null || String(epoch)!==String(r.approved_session_epoch)) fail("installation_approval_not_current",403);
      }
      await c.query(
        "INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,$3,$4)",
        [
          r.connector_id,
          r.user_id,
          r.connector_name,
          tokenHash(randomToken("installation-unused-controller")),
        ],
      );
      await c.query(
        "INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          r.device_id,
          r.connector_id,
          r.user_id,
          r.kind,
          r.sign_pk,
          r.kem_pk,
          r.noise_pk,
        ],
      );
      await c.query(
        "INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,token_hash,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [id, r.connector_id, r.device_id, r.installation_id, tokenHash(token),r.app_id,r.app_origin,r.kind,r.sign_pk,r.kem_pk,r.noise_pk],
      );
      await persistScope(c,r);
      await c.query(
        "UPDATE pairing_requests SET consumed_at=now() WHERE id=$1",
        [id],
      );
      await audit(
        c,
        r.user_id!,
        "device.installation_registered",
        r.device_id,
        { request_id: id, kind: r.kind, installation_id: r.installation_id },
      );
    }
    const bound = await c.query(
      "SELECT d.device_id FROM installation_device_credentials d JOIN connectors c ON c.id=d.connector_id JOIN next_devices n ON n.id=d.device_id WHERE d.pairing_id=$1 AND d.token_hash=$2 AND c.revoked_at IS NULL AND c.user_id=$3 AND n.connector_id=d.connector_id AND n.user_id=c.user_id AND n.kind=$4 AND n.sign_pk=$5 AND n.kem_pk=$6 AND n.noise_pk=$7 AND d.connector_id=$8 AND d.device_id=$9 AND d.installation_id=$10 FOR SHARE OF d,c,n",
      [
        id,
        tokenHash(token),
        r.user_id,
        r.kind,
        r.sign_pk,
        r.kem_pk,
        r.noise_pk,
        r.connector_id,
        r.device_id,
        r.installation_id,
      ],
    );
    if (!bound.rows[0]) fail("installation_device_revoked", 403);
    return {
      status: "paired" as const,
      ...selection(r),
      ...collectionSelection(r),
      collection_ids:r.approved_collection_ids,
      create_collections:r.approved_create_collections,
      connector: { id: r.connector_id, name: r.connector_name },
      token,
      registration: {
        device_id: r.device_id,
        sign_pk: r.sign_pk!.toString("hex"),
        kem_pk: r.kem_pk!.toString("hex"),
        noise_pk: r.noise_pk!.toString("hex"),
      },
    };
  });
}
