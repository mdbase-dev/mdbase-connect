// Bounded candidate metadata only. CP routing eligibility is NOT a native
// applied-policy/KEYED/app-grant witness. No service, application or LS credential.
import { createHash, randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseConnection } from "../../database-types.js";
import { authenticate, currentIdentity, currentMember, exactEnrolment, refuseRevoked, lock, inTransaction, CreateError, type Connector, type Proof } from "./bootstrap-common.js";
import { ApprovalPeerInputError, parseApprovalPeer, verifyApprovalPeerOrigin, type ApprovalPeerDevice, type ApprovalPeer } from "./approval-peer.js";
import { domainHash, encodeCbor, uuidBytes } from "./policy-wire.js";

type Registered = { device: string; account: string; kind: "desktop" | "cli"; sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer; connector_id: string };
type Row = { id: string; envelope: Buffer; expires_at: Date };
const sameTuple = (a: ApprovalPeerDevice, b: ApprovalPeerDevice) => a.device === b.device && a.account === b.account && a.kind === b.kind
  && a.sign_pk.equals(b.sign_pk) && a.kem_pk.equals(b.kem_pk) && a.noise_pk.equals(b.noise_pk);
function tuple(d: Registered): ApprovalPeerDevice {
  return { ...d, kind: d.kind === "desktop" ? 0 : 3 };
}
function timely(peer: ApprovalPeer): void {
  const left = peer.expiresAt - Date.now();
  if (left <= 0 || left > 120_000) throw new CreateError(409, "peer_expired");
}
async function registered(db: DatabaseConnection, id: string): Promise<Registered | null> {
  return (await db.query<Registered>(
    `SELECT d.id AS device, d.user_id AS account, d.kind, d.sign_pk, d.kem_pk, d.noise_pk, d.connector_id
     FROM next_devices d JOIN connectors c ON c.id = d.connector_id AND c.user_id = d.user_id
       JOIN users u ON u.id = d.user_id
     WHERE d.id = $1 AND c.revoked_at IS NULL AND u.suspended_at IS NULL
       AND d.user_id <> '00000000-0000-0000-0000-000000000000'::uuid
     FOR SHARE OF d, c, u`, [id])).rows[0] ?? null;
}
async function deviceLocks(db: DatabaseConnection, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    const h = createHash("sha256").update(`mdbase/v1/device-approval-peer-queue\0${id}`).digest();
    await db.query("SELECT pg_advisory_xact_lock($1, $2)", [h.readInt32BE(0), h.readInt32BE(4)]);
  }
}
async function credential(db: DatabaseConnection, connector: Connector, hash: string): Promise<void> {
  const r = await db.query("SELECT id FROM connectors WHERE id = $1 AND user_id = $2 AND token_hash = $3 AND revoked_at IS NULL FOR SHARE",
    [connector.id, connector.user_id, hash]);
  if (!r.rows.length) throw new CreateError(403, "identity_not_current");
}
async function privateCollection(db: DatabaseConnection, collection: string, accounts: string[]): Promise<void> {
  const r = await db.query("SELECT collection_id FROM next_collections WHERE collection_id = $1 AND runtime = 'next' AND sync = 'private' FOR SHARE", [collection]);
  if (!r.rows.length) throw new CreateError(409, "not_private");
  for (const account of [...new Set(accounts)].sort()) await currentMember(db, collection, account);
}
async function currentPair(db: DatabaseConnection, peer: ApprovalPeer): Promise<{ sender: Registered; recipient: Registered }> {
  const a = await registered(db, peer.approver.device), n = await registered(db, peer.requester.device);
  if (!a || !n || !sameTuple(peer.approver, tuple(a)) || !sameTuple(peer.requester, tuple(n))) throw new CreateError(409, "peer_not_current");
  await privateCollection(db, peer.collection, [a.account, n.account]);
  for (const d of [a, n]) {
    await refuseRevoked(db, peer.collection, d.device);
    const enrolled = await db.query(
      `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id = o.batch_id
       WHERE o.collection_id = $1 AND o.ops->'ops' @> $2::jsonb AND b.state = 'appended' LIMIT 1`,
      [peer.collection, exactEnrolment(d.device, d.account, d)]);
    if (!enrolled.rows.length) throw new CreateError(409, "peer_not_enrolled");
  }
  const sender = peer.kind === 0 ? a : n, recipient = peer.kind === 0 ? n : a;
  if (!verifyApprovalPeerOrigin(peer, tuple(sender))) throw new CreateError(403, "invalid_peer_origin");
  timely(peer);
  return { sender, recipient };
}

/** Signed envelope itself proves origin; paired connector credential proves caller. */
export async function queueApprovalPeer(db: DatabasePool, connector: Connector, credentialHash: string, collection: string, encoded: Uint8Array): Promise<{ id: string; outcome: "queued" }> {
  const peer = parseApprovalPeer(encoded, collection);
  const deadline = Date.now() + 9_000;
  const check = () => { if (Date.now() >= deadline) throw new CreateError(503, "busy"); timely(peer); };
  check();
  return inTransaction(db, async client => {
    await lock(client, collection);
    await deviceLocks(client, [peer.approver.device, peer.requester.device]);
    check();
    const { sender, recipient } = await currentPair(client, peer);
    if (sender.connector_id !== connector.id || sender.account !== connector.user_id) throw new CreateError(403, "invalid_peer_origin");
    await credential(client, connector, credentialHash);
    const old = (await client.query<Row>(
      `SELECT id, envelope, expires_at FROM next_device_approval_peers
       WHERE collection_id = $1 AND approver_device = $2 AND requester_device = $3 AND generation = $4 AND kind = $5`,
      [collection, peer.approver.device, peer.requester.device, peer.generation, peer.kind])).rows[0];
    if (old) {
      if (!old.envelope.equals(peer.bytes)) throw new CreateError(409, "peer_conflict");
      check(); return { id: old.id, outcome: "queued" };
    }
    // Write-side expiry only; both devices are locked, global active limits16.
    await client.query("DELETE FROM next_device_approval_peers WHERE (sender_device = $1 OR recipient_device = $1 OR sender_device = $2 OR recipient_device = $2) AND expires_at <= clock_timestamp()", [sender.device, recipient.device]);
    const counts = (await client.query<{ sent: string; received: string }>(
      `SELECT (SELECT count(*) FROM next_device_approval_peers WHERE sender_device = $1 AND expires_at > clock_timestamp()) AS sent,
              (SELECT count(*) FROM next_device_approval_peers WHERE recipient_device = $2 AND expires_at > clock_timestamp()) AS received`,
      [sender.device, recipient.device])).rows[0];
    if (Number(counts.sent) >= 16 || Number(counts.received) >= 16) throw new CreateError(429, "peer_capacity");
    const id = randomUUID();
    await client.query(`INSERT INTO next_device_approval_peers(id, collection_id, approver_device, requester_device, sender_device, recipient_device, generation, kind, envelope, expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, collection, peer.approver.device, peer.requester.device, sender.device, recipient.device, peer.generation, peer.kind, peer.bytes, new Date(peer.expiresAt)]);
    await currentPair(client, peer);
    await credential(client, connector, credentialHash);
    check(); return { id, outcome: "queued" };
  });
}

/** Fixed read/ack device proof; never reuse the SAScommit slot for routing data. */
export async function readApprovalPeers(db: DatabasePool, connector: Connector, credentialHash: string, collection: string,
  proof: Proof, acknowledge?: string[]): Promise<{ messages: { id: string; peer: string }[]; acknowledged: number }> {
  const deadline = Date.now() + 9_000;
  const check = () => { if (Date.now() >= deadline) throw new CreateError(503, "busy"); };
  return inTransaction(db, async client => {
    await lock(client, collection);
    await deviceLocks(client, [proof.device_id]);
    check();
    const fields = (challenge: Uint8Array) => [challenge, uuidBytes(connector.id), uuidBytes(proof.device_id), uuidBytes(collection)];
    const device = await authenticate(client, proof, connector, challenge => domainHash(
      acknowledge ? "mdbase/v1/device-approval-peer-ack" : "mdbase/v1/device-approval-peer-inbox",
      encodeCbor(acknowledge ? [...fields(challenge), acknowledge.map(uuidBytes)] : fields(challenge))));
    await currentIdentity(client, connector, proof.device_id, device);
    await credential(client, connector, credentialHash);
    // bootstrap authenticate consumes a challenge; clock_timestamp/JS wall time
    // recheck refuses expiry during lock waits rather than transaction-start now().
    const c = (await client.query<{ expires_at: Date }>("SELECT expires_at FROM next_device_challenges WHERE challenge = $1 AND connector_id = $2", [Buffer.from(proof.challenge, "hex"), connector.id])).rows[0];
    if (!c || c.expires_at.getTime() <= Date.now()) throw new CreateError(403, "invalid_proof");
    await privateCollection(client, collection, [connector.user_id]);
    if (acknowledge) {
      check();
      // Retain identity through expiry: a lost sender response followed by an
      // exact retry cannot recreate an already-consumed candidate with a new ID.
      const updated = await client.query("UPDATE next_device_approval_peers SET acknowledged_at = clock_timestamp() WHERE collection_id = $1 AND recipient_device = $2 AND id = ANY($3::uuid[]) AND acknowledged_at IS NULL RETURNING id",
        [collection, proof.device_id, acknowledge]);
      check(); return { messages: [], acknowledged: updated.rows.length };
    }
    const rows = await client.query<Row>("SELECT id, envelope, expires_at FROM next_device_approval_peers WHERE collection_id = $1 AND recipient_device = $2 AND acknowledged_at IS NULL AND expires_at > clock_timestamp() ORDER BY created_at, id LIMIT 16", [collection, proof.device_id]);
    const messages: { id: string; peer: string }[] = [];
    for (const row of rows.rows) {
      let peer: ApprovalPeer;
      try { peer = parseApprovalPeer(row.envelope, collection); } catch (error) {
        if (!(error instanceof ApprovalPeerInputError)) throw error;
        throw new Error("Invalid persisted approval peer metadata.");
      }
      const { recipient } = await currentPair(client, peer);
      if (recipient.device !== proof.device_id || recipient.account !== connector.user_id) throw new Error("Persisted approval peer recipient mismatch.");
      messages.push({ id: row.id, peer: peer.bytes.toString("base64url") });
      check();
    }
    await currentIdentity(client, connector, proof.device_id, device);
    await credential(client, connector, credentialHash);
    check(); return { messages, acknowledged: 0 };
  });
}
