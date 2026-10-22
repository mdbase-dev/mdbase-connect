# Hosted own-collection migration claim read

The existing hosted inbound role credential is not proof of a collection. These post-bootstrap routes additionally require possession of CP's current hosted service signing key for that exact current SHADOW target. They never accept the operator migration credential, escrow/app/session credentials, caller keys, or a caller-selected owner/runtime/audience.

The routes are mounted alongside configured migration routes only when the existing hosted role credential and an explicit HTTPS `publicUrl` are configured. The audience is that owned configuration's canonical origin, not a request Host header or body. The native signer must use the same immutable owned origin. DNS/IPv4 canonical HTTPS origins are supported; IPv6 refuses in this initial profile. The migration and hosted credentials must differ.

## Exchange

Both POSTs require the hosted bearer, empty query, canonical lowercase nonnil collection/device UUIDs and an exact JSON body bounded to 1024 bytes. Authentication runs before JSON parsing. Replies are noncacheable.

1. `POST /internal/v1/next/migration/collections/:id/claim/challenge`, body `{ "device_id": "..." }`, returns only `{ "challenge": "..." }` with 32 CSPRNG bytes encoded as 64 lowercase hex characters.
2. The actual native FULL/accepted-original signer rechecks its own Engine and signs its closed read-purpose template. This server change does not implement the actual host/native bridge.
3. `POST .../:id/claim/read`, body `{ "device_id": "...", "challenge": "...", "sig": "..." }`; signature is 64 bytes encoded as 128 lowercase hex characters. Success uses `mdbase-migration-claim/1`, retaining the existing exact string `started_us` and public SHADOW tuple. Unlike the operator read, the target must be present.

Signed digest: existing `H(tag,m) = SHA256(u8(len(UTF8(tag))) || UTF8(tag) || m)`, with exact 40-byte domain `mdbase/v1/cp-hosted-migration-claim-read`. `m` is the canonical CBOR array:

```
[1, configuredAudience, "POST", fixedReadPath,
 collectionUUID16, hostedDeviceUUID16, genesisRootId16,
 signPublicKey32, kemPublicKey32, noisePublicKey32, challenge32]
```

`fixedReadPath` is `/internal/v1/next/migration/collections/<canonical collection UUID>/claim/read`. CP constructs the template from its current authoritative target, not submitted keys. The shared public deterministic fixture pins CBOR, digest, derived public keys and Ed25519 signature.

## Nonce state and currentness

Migration 0068 extends `next_device_challenges` with exactly one genuine connector OR service subject. Existing connector enrollment cannot consume service challenges. Service queries discriminate collection/device/purpose/audience; the purpose is fixed `migration-claim-read/v1`. A server-side fingerprint binds the actual owner/exact start and immutable full target tuple, not an invented CP version or lease.

Nonce issuance/consumption and bounded expiry cleanup are authentication housekeeping—the only new writes. One outstanding unused challenge per service/purpose/audience, fixed ten-second lifetime, no overwrite or renewal of a live challenge, and a persistent bound of twenty recent challenges per subject. The old connector behavior remains separate. Expiry is checked with actual database time after lock waits, not frozen transaction-start time.

The same canonical source/target reader from the operator route runs inside the transaction, with owner-before-collection locks, current service-row share lock and canonical revocation checks. Consumption and the final source/target/revocation read must commit together. Replacement, replay, expiry, foreign nonce, lifecycle drift, missing target or unknown COMMIT produces no successful claim. A lost response can follow a landed consume; never infer no effect or blindly retry/renew.

## Limits

Success is bounded public CP DATA, not native FULL, physical namespace admission, a migration lease, a pending-action witness, settled competing effects, durable host commit or H1 permission. The actual private host adapter still must bind its HTTPS/no-redirect channel and outstanding call, recheck native/physical/pending/settlement after awaits and refuse stale/unknown outcomes. Prekey/bootstrap authorization and positive H1 serving/completion remain separate. No provider drain, fence, restore, rollback, cutover, policy/audit emission or key generation occurs here.
