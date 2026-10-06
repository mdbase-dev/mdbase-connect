# NEXT release trust payload v1

`packages/protocol/schemas/next-trust.v1.schema.json` is the closed public shape.
`services/server/src/features/next/trust-payload.ts` is the reference semantic
encoder/validator. The portable vector is
`packages/protocol/test/fixtures/next-trust.v1.json` (PUBLIC SYNTHETIC ONLY).

## Authentication and publication

The payload is **not** a signed envelope and cannot authorize itself. Ops publishes
`next-trust/lab.json`, `next-trust/staging.json`, or `next-trust/production.json`
as an asset of the authenticated release bundle. The external signed manifest
must bind asset path, byte length, SHA-256, environment, CP/log origins and the
same repository/commit/version as the release. No bundle hash or signature is
inside the payload: that would create a self-reference.

The existing Ops verifier authenticates `release-bundle.json` using its detached
`release-bundle.sigstore.json` proof, with EXACT certificate identity
`https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-images.yml@refs/heads/main`
and issuer `https://token.actions.githubusercontent.com`. It also checks release
source/version/publication run and attempt, successful workflow/CI qualification
and immutable images. Any other publisher needs its own explicitly reviewed,
pinned identity. This is not a new Ed25519 release key or an arbitrary Cosign cert.
Ops owns the inventory schema/publisher/verifier extension. The image inventory v1
contains no NEXT trust assets and therefore cannot authorize NEXT pins by itself.
The [release-linked trust inventory](next-trust-release.md) binds its immutable
bytes to a separately signed LAB asset using the same existing publisher identity.

After authenticating the manifest, pass its digest and independently expected
release/environment/origin/source context to `validateNextTrustPayload`. Never
construct the expectation from a server reply, an unverified JSON envelope or
its own self-computed digest. `encodeNextTrustPayload` is structural/certificate
validation for the publisher; calling it alone is **not release authentication**.

Ship the verified canonical asset in the signed daemon. The daemon either uses
that authenticated embedded asset, or implements the same complete pinned
Sigstore verification for an external bundle. A boolean/build flag or local file
is not verification. Missing authenticated pins deny synced admission in every
environment, including LAB/staging. No runtime server fetch, TOFU, root-file
fallback, wildcard policy pins, environment override or caller-supplied anchor.

## Payload and canonical bytes

All fields are mandatory. Environment is exactly `lab`, `staging`, or
`production`; `control_plane_origin` and `log_origin` are exact canonical HTTPS
origins without path, credentials, query or fragment. They must match the
reviewed environment's expected origins, signed-in CP origin and `sync.json` v2
log URL origin. `source` is `{repository:"mdbase-dev/mdbase-connect", commit,
version}`. Commit is lowercase full 40-hex; times are safe unsigned integer UTC
milliseconds. `issued_at` cannot be in the future at validation.

Roots contain `key_id` and raw 32-byte Ed25519 `public_key`; policy pins contain
`key_id` and `certificate` in the existing `CpCertJson` shape. IDs are exactly the
first **16 bytes of SHA-256(raw public key)** (`policy-wire.keyId`), not a tagged
hash or full 32-byte fingerprint. Bytes are lowercase hex. Roots and online
policy keys are distinct principals. Both root and policy signing points must
pass the same small-order/noncanonical rejection as registered devices
(`devices.weakSigningKey`); certificate verification alone is insufficient.
Certificates must verify under an included root and have increasing safe integer
validity windows. At least one policy
certificate is valid at issue time; historical certificates may remain for
history. A later presented certificate is never a new policy-key trust source:
require its policy public key/ID and root ID to match a published pin, verify its
root signature and validity at the policy item's signed time.

Canonicalization: recursively sort object keys lexically (all schema keys and
validated strings are ASCII), preserve arrays, serialize safe integers normally,
UTF-8 JSON with no whitespace/BOM/newline. Arrays are strictly ascending by
`key_id`; duplicates fail. Maximum asset 65536 bytes, 1..8 roots, 1..32 policies.
Reject unknown/missing fields, invalid UTF-8, duplicate JSON keys, noncanonical
bytes and mismatching authenticated digest/context. The JSON schema alone does
not enforce certificate crypto, ordering, origin normalization or source binding.

Trust pins authenticate candidate genesis/certificates; they do not establish
membership, deliver an epoch key, or make a replica Ready. Compare expected
genesis to the actual log, verify actual ordered policy/current membership and
keying/catch-up/freshness/lease dependencies separately. Expired historical
certificates do not become current credentials. The schema/vector/reference
validator alone publish no authenticated NEXT trust asset.
