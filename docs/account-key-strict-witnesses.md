# Strict-mode completion witnesses

Strict completion is an aggregation of device-signed **replica application**
evidence. Connect never evaluates replica policy, and log admission/readback is
not an application witness. The full cross-repo contract is mdbase-next
`docs/ship/interfaces/2026-10-07-shipitems-strict-witnesses.md`.

- `POST /v1/next/account-key/strict` creates a generation and queues recovery-device
  revocations. Repeating strict with its current version keeps that generation.
- `GET /v1/next/account-key/status` in strict mode returns `complete` and
  `pending: [{collection_id,device_id,revoked_at:number|null}]` across every current
  private recovery target. Missing hosts remain pending; an empty set explicitly
  completes. It does not spend the bundle-fetch budget.
- `POST /v1/next/collections/:id/private/strict-witness` authenticates a current
  exact enrolled member device. Without `witness`, it returns that collection's
  missing targets (`account_id,collection_id,recovery_device,strict_version,
  revoked_at`). With `witness`, it also checks its replica signature and exact
  current generation/appended revoke position before storing evidence.
- Witness JSON contains those five target fields plus `applied_at`, `epoch`,
  `reporter` and hex `signature`. Its signature covers the domain hash of canonical
  CBOR `[1,account,collection,recovery_device,strict_version,revoked_at,applied_at,
  epoch,reporter]`, all UUIDs as 16-byte values. Domain:
  `mdbase/v1/account-key-strict-witness`.
- The ordinary challenge signature covers `H("mdbase/v1/account-key-strict-report",
  cbor[challenge,connector,device,collection,witness_fields_plus_signature])`.
  Querying uses an empty array in the last slot. No signature or payload defaults.

Migration 0053 holds one witness per recovery target, version-bound. A new
password/strict transition cannot reuse an old generation's witness. The
attestation trusts the authenticated member device's claim of valid application;
compromised authorized devices are inside this explicit trust boundary.

Native hosts report automatically. A device deletes its local account secret
only after explicit CP `complete:true`, never from local hosting coverage,
revocation queueing, log readback or an absent response field.
