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
import { currentSession, inTransaction } from "../next/bootstrap-common.js";
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
/** Fixed first-party identities. Environment picks the map, never arbitrary
 * caller URLs. Native origins match TaskNotes Capacitor's declared hostname/
 * scheme; Origin is mandatory (including native), with no missing-origin bypass. */
export function installationApp(environment: string | undefined, appId: string, origin: string | undefined, kind: "app-runtime" | "mobile") {
  const web: Record<string, readonly string[]> = {
    production: ["https://app.tasknotes.dev"],
    lab: ["https://lab.tasknotes-app.pages.dev"],
    staging: ["https://staging.tasknotes-app.pages.dev"],
  };
  if (!environment || !Object.hasOwn(web, environment) || !origin) return fail("installation_app_not_allowed", 403);
  const allowed = appId === "tasknotes-web" && kind === "app-runtime" ? web[environment]
    : appId === "tasknotes-mobile" && kind === "mobile" ? ["https://app.tasknotes.dev", "capacitor://app.tasknotes.dev"] : [];
  if (!allowed.includes(origin)) return fail("installation_app_not_allowed", 403);
  return Object.freeze({ id: appId, origin, name: "TaskNotes" });
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
  sign_pk: Buffer | null;
  kem_pk: Buffer | null;
  noise_pk: Buffer | null;
  registration_sig: Buffer | null;
  attested_at: Date | string | null;
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
    `SELECT p.*, i.installation_id,i.previous_pairing_id,i.app_id,i.app_origin,i.device_id,i.connector_id,i.kind,i.challenge,i.account_selected_at,i.sign_pk,i.kem_pk,i.noise_pk,i.registration_sig,i.attested_at FROM pairing_requests p JOIN installation_device_pairings i ON i.pairing_id=p.id WHERE p.id=$1 ${includeRevoked ? "" : "AND p.revoked_at IS NULL"} ${secret === undefined ? "" : "AND p.secret_hash=$2"} ${lock ? "FOR UPDATE OF p,i" : ""}`,
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
): Promise<void> {
  if (
    !(
      await c.query(
        `SELECT id FROM users WHERE id=$1 AND suspended_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
        [user],
      )
    ).rows[0]
  )
    fail("installation_account_unavailable", 403);
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
function selection(r: Row) {
  return {
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
  input: { request_id: string; pairing_secret: string; installation_id: string; device_id: string; kind: "app-runtime" | "mobile"; renewal?: { request_id: string; pairing_secret: string } },
  app: ReturnType<typeof installationApp>,
  publicUrl: string,
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
      if (registered.rows[0]) return fail("installation_already_registered");
      let prior: Row | null = null;
      if (priorIds.rows.length) {
        if (!input.renewal) return fail("installation_original_window_required");
        prior = await row(c,input.renewal.request_id,input.renewal.pairing_secret,true,true);
        if (prior.consumed_at || (!prior.revoked_at && new Date(prior.expires_at).getTime()>Date.now())) return fail("installation_window_not_closed");
        if (prior.installation_id!==input.installation_id || prior.device_id!==input.device_id || prior.kind!==input.kind || prior.app_id!==app.id || prior.app_origin!==app.origin) return fail("installation_original_binding_changed");
        // Only the latest closed window can be renewed. An already-created
        // successor blocks a parallel renewal, even if its parent was denied.
        const successors = await c.query("SELECT pairing_id FROM installation_device_pairings WHERE previous_pairing_id=$1", [prior.id]);
        if (successors.rows[0]) return fail("installation_original_window_required");
        if (prior.user_id) { await active(c,prior.user_id); await ordinary(c,prior.user_id); }
        await c.query("UPDATE pairing_requests SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [prior.id]);
      } else if (input.renewal) return fail("installation_original_window_required");
      await c.query("INSERT INTO pairing_requests(id,secret_hash,connector_name,user_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [input.request_id,tokenHash(input.pairing_secret),app.name,prior?.user_id??null]);
      // A renewed window retains the SAME attested key, challenge, connector,
      // account and signature. No native re-sign/rebind or second device.
      await c.query("INSERT INTO installation_device_pairings(pairing_id,previous_pairing_id,installation_id,device_id,connector_id,app_id,app_origin,kind,challenge,account_selected_at,sign_pk,kem_pk,noise_pk,registration_sig,attested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [input.request_id,prior?.id??null,input.installation_id,input.device_id,prior?.connector_id??randomUUID(),app.id,app.origin,input.kind,prior?.challenge??randomBytes(32),prior?.account_selected_at??null,prior?.sign_pk??null,prior?.kem_pk??null,prior?.noise_pk??null,prior?.registration_sig??null,prior?.attested_at??null]);
    }
    const r = await row(c,input.request_id,input.pairing_secret,true);
    if (r.installation_id!==input.installation_id || r.device_id!==input.device_id || r.kind!==input.kind || r.app_id!==app.id || r.app_origin!==app.origin || r.previous_pairing_id!==(input.renewal?.request_id??null)) return fail("installation_original_binding_changed");
    if (!r.consumed_at) live(r);
    return {pairing_id:r.id,pairing_secret:input.pairing_secret,verification_uri:`${publicUrl}/pair/${r.id}`,expires_in:Math.max(0,Math.floor((new Date(r.expires_at).getTime()-Date.now())/1000)),installation_device:true,app_id:r.app_id,app_origin:r.app_origin,app_name:r.connector_name};
  });
}
export async function inspectInstallationPairing(
  db: DatabasePool,
  id: string,
  user: string,
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
      attested: !!r.attested_at,
      fingerprint: r.sign_pk ? clientFingerprint(r.sign_pk) : null,
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
    return { ok: true };
  });
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
) {
  return tx(db, async (c) => {
    await active(c, user, true);
    await currentSession(c, session, user);
    await ordinary(c, user);
    const r = await row(c, id, undefined, true);
    live(r);
    if (r.user_id !== user || !r.account_selected_at || !r.attested_at)
      fail("installation_attestation_required");
    if (!r.sign_pk || fingerprint !== clientFingerprint(r.sign_pk)) return fail("installation_fingerprint_changed", 403);
    if (!r.approved_at) {
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
    await active(c, user, true);
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
export async function exchangeInstallationPairing(
  db: DatabasePool,
  id: string,
  secret: string,
) {
  return tx(db, async (c) => {
    const initial = await row(c, id, secret);
    if (!initial.user_id) {
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
    if (!r.attested_at)
      return { status: "account_selected" as const, ...selection(r) };
    if (!r.approved_at)
      return { status: "awaiting_approval" as const, ...selection(r) };
    const token = credential(r, secret);
    if (!r.consumed_at) {
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
