# Explicit account backend

`users.account_backend` is a non-null `legacy | next` marker, defaulting to
`legacy` for existing and newly created accounts. A deployment's NEXT flag,
collection encryption mode, transport failure or client preference never selects
an account backend. The guarded migration/cutover owner sets `next` only after
account takeover has met its admission/data-preservation requirements. This
change adds no setter or automatic promotion.

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
