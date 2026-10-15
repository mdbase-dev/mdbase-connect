import type { DatabaseQueryable } from "../../database-types.js";
import type { RelayHub } from "../../relay.js";
import type { PolicyEmitter } from "../next/policy-outbox.js";
import { nativeDevices, nativeGrantStanding } from "../next/native-grant-target.js";

const PUBLICATION_WAIT_MS = 8_000;

/** Delivery only: call AFTER the original transaction commits and releases its
 * connection. The existing relay builds current policy and waits for its bounded,
 * exact session ACK; this is not sealed/Effective readiness or new consent.
 * Renewal remains the recovery path when delivery is unavailable. */
export function createNativeApprovalDelivery(
  db: DatabaseQueryable,
  relay: Pick<RelayHub, "pushPolicy">,
  onDeferred: () => void,
  publication?: Pick<PolicyEmitter, "publishCommitted">,
) {
  const publish = async (collection: string) => {
    if (!publication) { onDeferred(); return; }
    try {
      // Bound this HTTP courtesy wait, NOT the original producer's append.
      // PolicyEmitter owns late work and retains original unknown-outcome bytes.
      const work = publication.publishCommitted(collection);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("policy publication deferred")), PUBLICATION_WAIT_MS);
        timer.unref();
        void work.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
    } catch { onDeferred(); }
  };
  const safely = (work: () => Promise<void>) => work().catch(onDeferred);
  const deliver = async (grantId: string): Promise<void> => {
    const grant = (await db.query<{ collection: string; account: string }>(
      `SELECT g.next_collection_id AS collection, g.user_id AS account
       FROM grants g JOIN users u ON u.id = g.user_id AND u.suspended_at IS NULL
       JOIN next_grant_bindings b ON b.grant_id = g.id AND b.active
       JOIN next_grant_client_keys k ON k.grant_id = g.id
       WHERE g.id = $1 AND g.activated_at IS NOT NULL AND g.revoked_at IS NULL
         AND g.next_collection_id IS NOT NULL`, [grantId],
    )).rows[0];
    if (!grant || await nativeGrantStanding(db, grant.collection, grant.account) !== "current") return;
    // A feed/cache ACK cannot create the request in the replica's log. Wake
    // the canonical producer before asking Native to publish its sealed Approve.
    await publish(grant.collection);
    // Reuse relay admission's exact consenting-account/key/enrolment/revocation
    // fence; another member's Native and unenrolled devices are not targets.
    const devices = await nativeDevices(db, grant.collection, grant.account);
    const results = await Promise.allSettled(devices.map(device => relay.pushPolicy(device.connector_id)));
    if (results.some(result => result.status === "rejected")) onDeferred();
  };
  return {
    authorization: (requestId: string) => safely(async () => {
      const request = (await db.query<{ grant_id: string }>(
        `SELECT grant_id FROM authorization_requests WHERE id = $1
         AND completed_at IS NOT NULL AND denied_at IS NULL AND grant_id IS NOT NULL`, [requestId],
      )).rows[0];
      if (request) await deliver(request.grant_id);
    }),
    installation: (pairingId: string) => safely(async () => {
      const link = (await db.query<{ grant_id: string }>(
        `SELECT link.grant_id FROM installation_native_authorizations link
         JOIN authorization_requests ar ON ar.id = link.authorization_request_id
           AND ar.user_id = link.account_id AND ar.grant_id = link.grant_id
         JOIN grants g ON g.id = link.grant_id AND g.next_collection_id = link.selected_collection_id
         WHERE link.pairing_id = $1 AND link.approved_at IS NOT NULL`, [pairingId],
      )).rows[0];
      if (link) await deliver(link.grant_id);
    }),
    // A status poll can observe approval before its courtesy push finishes.
    // Keep the same delivery barrier at the end of original credential issuance.
    grant: (grantId: string) => safely(() => deliver(grantId)),
  };
}
