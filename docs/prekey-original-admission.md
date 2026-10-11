# CP-only pre-key original admission

This fixed-run source produces authenticated admission **data**, not a native caller witness, serving permission, physical authority or migration authorization. It does not open any required actor. The native consumer must independently authenticate the actual request with LOG `VerifiedCaller`, verify exact originals with `bind_original_caller`, and retain a one-shot challenge bound to its own actor, wake, request and purpose before SQL, keys, custody or Engine access.

## HTTP source (v1)

`POST /internal/v1/next/lab-pitr/original-cp-admission` is mounted only with the existing fixed LAB mapping and separate PITR authority credential. The bearer gates this metadata source; it does not prove an original caller. Request body is exactly `{ "collection": "<canonical admitted A or D UUID>", "challenge": "<nonzero 32-byte lowercase hex>" }`, at most 1024 bytes, with no query. No caller-selected owner, root, key, hash, run, role or purpose is accepted.

Success is exactly `{ "admission": "<base64 canonical envelope>", "expires_at": <integer milliseconds> }` with `cache-control: no-store`. Missing source is unavailable, not an ordinary fallback. Authentication failure is 401; malformed input 400; current-authority refusal 409; unavailable/unknown outcomes 503. Device and nil subjects are not admitted by this route.

The source uses the already-loaded public token issuer and Ed25519 CP transport observation, configured root/run/audience, and the live CP database outside actor rollback. The issuer is distinct from the policy signer; transport is not Noise or KEM. Existing public identity and ordinary token/PoP paths retain their previous shapes.

Under the existing collection/security locks, discovery counts all original seq1 candidates before loss/state filtering (limit two; 64 KiB per raw original). Exactly one sending or appended, nonlost original must match the admitted owner/root. Sending is not an append acknowledgment. Local certificate/item crypto checks require one CloudCopy Genesis and original certificate policy key equal to actual CP transport. Current owner/run/floor/root/security/deletion checks and pending owner/key denial apply; both current signing-key and original transport-policy-key revocations refuse. Native validation remains independent.

A signature is returned only after the actual COMMIT succeeds and its freshness is rechecked. Failure, unknown COMMIT, original drift, issuer drift, expired or backward clock returns no signed success. A successful read does not prove a later effect settled.

## Exact byte contract

Existing canonical framing is `[1, bstr(claims_bytes), CpCert, bstr(signature64)]`; certificate fields and digest are unchanged. Ed25519 signs `H("mdbase/v1/prekey-original-admission", claims_bytes)`, where `H` is SHA256 of u8 UTF-8 tag length, tag, and message. Migration-source, token and policy-item domains are not interchangeable.

Claims are exactly:

```
[1, audience, run, "original-caller-prekey",
 collection16, owner16, root_pk32, issuer_pk32, transport_pk32,
 genesis_sha256_32, 1, null, null, null,
 challenge32, issued_at_ms, expires_at_ms]
```

Collection/owner are nonnil UUID bytes; keys/hashes/challenge are nonzero 32-byte strings. Audience is the immutable configured canonical ASCII HTTPS CP origin, at most 255 bytes. Run is the exact configured fixed run. The three null fields are enrollment hash, enrollment position and device tuple: CP-only, never device absence fallback. The device branch is reserved and must refuse until separately composed.

Claims are at most 2048 bytes; envelope at most 4096. Timestamps are nonnegative safe integers, certificate-bounded, with `0 < expiry - issuance <= 10000`. Native acceptance requires `issued <= fresh_now < expiry`, with no future grace. The independently trusted public root must authenticate the certificate before any response-provided key is trusted; the declared root cannot bootstrap trust.

Native decoding must require canonical bytes, exact arities/lengths, no trailing data and no unknown fields. A locally retained challenge must match audience/run/collection and the actual verified CP request; abort, output loss or restart must not recreate it. This source has no portable permit or generic signing endpoint.

## Versioned replay source (v2)

The same endpoint additionally accepts exactly
`{v:2,collection,challenge,http_nonce,transcript_hash}`. Byte selectors are
nonzero canonical lowercase 32-byte hex; the body remains at most 1024 bytes.
They are registration DATA, not authenticated caller facts. V1 remains a separate
source contract and cannot satisfy a positive v2 witness.

V2 uses `[2,bstr(claims_bytes),CpCert,bstr(signature64)]`, domain
`mdbase/v2/prekey-original-admission`, and exactly nineteen claims: the old
seventeen positions with version 2, followed by nonce32 and transcript32.
The native consumer must match these SIGNED bytes to its retained, genuinely
MAC/token/PoP-authenticated request and existing HTTP digest, not an HTTP-verb
substitute or reconstructed JSON. It independently checks the actual token
issuer, original binder and this-instance context; neither a bearer nor a CP
signature creates an opaque native caller or witness.

V2 issuance uses PostgreSQL `now()` inside the admission transaction as its
single authorization time. A fresh PostgreSQL transaction-time observation after
actual COMMIT must still be within the signed interval; elapsed process time
bounds the five-second request budget only. Unknown or failed COMMIT, timeout,
clock reversal, output loss and duplicates never reissue an old result. Timeout
does not settle pending database work or release its in-flight accounting.

Outside actor rollback, `next_prekey_http_nonce_uses` has primary key
`(collection_id,http_nonce)`; owner, transcript and challenge are immutable
registration values, not uniqueness partitions. It has no deletion cascade.
A separate persistent per-collection cutoff row first commits without signing;
subsequent issuance must be strictly after cutoff + 60000 ms + the named 5000 ms
future-tolerance bound. The floor row is NOT an old-writer drain acknowledgement.
Loss of clock/authority continuity or an unqualified transition remains a
positive-serving blocker, including the reverse transition to ordinary mode.

A distinct account advisory-lock namespace precedes the existing collection
lock across replicas. Indexed bounded live counts include nonce expiry equality:
4096 per collection and 8192 per immutable owner. Local admission permits at most
four pending calls per process and two per collection, before pool checkout;
these are not distributed RPS guarantees. Under the same locks, at most 64 rows
are garbage-collected strictly when nonce expiry is older than transaction time
minus 60000 + 5000 + 24-hour margin. Unexpired rows and cutoff rows are untouched.
There is no automatic quota expansion or capacity qualification.

Required actors still return 503. Actual old-writer/shared-key issuer fencing,
drain, clock continuity and native receive/current freshness remain independently
required; topology freeze and stored cutoff data do not prove physical drain.

## Evidence boundaries

The public synthetic vectors in `services/server/src/features/next/fixtures/prekey-original-admission-v1.json` and `prekey-original-admission-v2.json` are generated independently with canonical CBOR and Ed25519 reference code, not release trust. Tests exercise real crypto, private production helpers without production exports, the actual HTTP route with substituted SQL, held/late COMMIT, timeout and refusal paths. A separately opted-in dedicated local PostgreSQL fixture exercises the actual migration and private replay SQL with concurrent connections, account/collection locking, persistent floor refusal, commit/rollback, inclusive live quotas and strict bounded GC. This local fixture is not a managed CP clock or recovery qualification. None of these tests qualify a native actor bridge, device originals, nil admission, all-five coherence or operations.
