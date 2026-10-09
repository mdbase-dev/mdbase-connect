# Explicit account backend

`users.account_backend` is a non-null `legacy | next` marker, defaulting to
`legacy` for existing and newly created accounts. A deployment's NEXT flag,
collection encryption mode, transport failure or client preference never selects
an account backend. The guarded migration/cutover owner sets `next` only after
account takeover has met its admission/data-preservation requirements. There is
no automatic promotion.

## Staged migration and the flip

The hosted migrator calls these routes with its own token,
`MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN`. That token is distinct from the hosted and
escrow service tokens; without it the routes are not mounted. Every change is an
`audit_events` row.

Suspension is not migration exclusion. The dedicated migration service can
select, start, obtain a source witness for, cut over and flip a suspended account
without clearing its suspension. Ordinary session, application, connector,
member and takeover checks continue to deny suspended accounts before and after
the flip. Only a separate account-status change restores ordinary access.
Accepted deletion remains terminal exclusion and refuses all migration steps.
Migration ledger facts and source witnesses do not establish physical byte
preservation or grant ordinary access.

1. **Start.** `POST /internal/v1/next/migration/accounts/{id}/start` is the atomic
   claim. It requires a released cohort and a legacy account, and it is refused
   while the rollout is paused. A started account appears in `GET …/in-progress`
   whatever the pause, so it always finishes.
2. **Cutover.** `POST /internal/v1/next/migration/collections/{id}/cutover
   {barrier_f, final_digest}` records one hosted collection's completed cutover.
   It requires a started account and the control plane's cloud copy with the
   preserved ID, owned by that account. It sets that copy's runtime to `next`.
3. **Flip.** `POST …/accounts/{id}/flip {collections, evidence_digest}` is the
   only setter of `next`. It requires a started account. The collections must be
   exactly its hosted collections (transferred ones excluded), none may be mid
   import or transfer, and every one must be cut over. The evidence digest must
   equal SHA-256 over the sorted lines `collection:barrier_f:final_digest\n`,
   which the server recomputes from the cutover records. A retry with the same
   evidence returns the same flip. An account with no hosted collections flips
   with an empty list once started. There is no un-flip: rollback is only
   possible before cutover.

Operators run the `next:migration-rollout` CLI (`MDBASE_OPERATOR` names them) to
release cohorts, pause and resume. A flipped account cannot create legacy hosted
collections. Collections of an account whose migration started are never
quarantined as missing: the provider's freeze is not a deletion. Deleting the
account while its batch is frozen is accepted immediately and its credentials
are revoked at once. The account is durably terminal-excluded in that same
transaction: it is not migrated and needs no witness, cutover or flip. Exclusion
does not alter captured archive membership/revision. Terminal topology changes
and erasure are durably queued and run automatically after the **whole batch**
completes (validated flips or accepted terminal exclusions), or an audited
unfreeze before archive acceptance, including after restart. Acceptance is not
completed erasure. Outside a freeze deletion remains immediate.
See [the topology-freeze procedure](migration-topology-freeze.md).

## Retained application grant

`GET /v1/account/backend` returns only:

```json
{"account_id":"11111111-1111-4111-8111-111111111111","backend":"legacy"}
```

This metadata call works on a bare retained consent connection, before
`application.start`, `describe`, type-pack assessment, data setup or a Noise data
session. It does not issue a collection operation or widen grant capabilities.
The account is the consenting `grants.user_id`, not the collection's creator or
connector's owner. Responses use `Cache-Control: no-store`.

Supply the active access token as Bearer and the existing authority-request
proof **version 1**, domain `mdbase-authority-request-proof-v1`. The proof binds
`GET`, the exact request target `/v1/account/backend`, empty body and that exact
access-token credential, with the protocol's timestamp and nonce headers. The
server verifies against `grants.proof_public_key` (canonical base64url raw65
uncompressed P-256 signing public key). This is the installation/application
signing proof, not P-256 agreement or a Noise-frame signature. The SDK's narrow
optional getter owns the private signing-key lease and token; neither is
exported to the application.

The server checks token expiry/revocation, grant activation/revocation, a
non-nil consenting account and account suspension. Token/grant/account rows are
share-locked through proof checking and the response snapshot, with five-second
lock/statement limits. Missing proof binding, invalid proof or unusable grant
returns 401; contention returns 503 `busy`. There is no legacy fallback on an
authentication/getter error. A missing/invalid persisted marker is an internal
invariant error, never a default. The SDK must strictly parse the known enum and
account identity and recheck retained-grant identity after awaiting the call.

A backend change is not authorization to retry an uncertain legacy write in
NEXT. Preserve its original operation identity and receipt; migration admission
and stale-writer fencing belong to the cutover owner. This endpoint is metadata,
not current collection policy, approval/key delivery or Ready proof.
