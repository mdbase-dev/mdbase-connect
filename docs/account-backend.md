# Explicit account backend

`users.account_backend` is a non-null `legacy | next` marker, defaulting to
`legacy` for existing and newly created accounts. A deployment's NEXT flag,
collection encryption mode, transport failure or client preference never selects
an account backend. The guarded migration/cutover owner sets `next` only after
account takeover has met its admission/data-preservation requirements. There is
no automatic promotion.

## Staged migration and the flip

The only setter is the hosted migrator's `POST
/internal/v1/next/migration/accounts/{id}/flip`. It accepts only the hosted
service token and takes `{collections, evidence_digest}`. In one transaction it
locks the account and its hosted collections, then refuses with 409 when:

- the account is not in a released cohort;
- any hosted collection is mid import or transfer (`collections_unsettled`);
- `collections` is not exactly the account's hosted collections, ignoring
  transferred ones (`collections_mismatch`).

Otherwise it sets `next` and records the collections and evidence digest in
`next_migration_account_flips`. A retry with the same evidence returns the same
flip.

Operators release cohorts with the `next:migration-rollout` CLI. There is no
user opt-in. The global pause (it starts paused) empties
`GET /internal/v1/next/migration/candidates`, so no new account starts. It never
blocks the flip of an account whose collections already migrated. Old agents of
a flipped account are told to update; the new daemon's takeover moves their
local folders.

The session-only `GET /v1/account` includes `backend` at the top level. It does
not become application-grant accessible.

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
