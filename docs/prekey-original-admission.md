# CP-only pre-key original admission

This fixed-run source produces authenticated admission **data**, not a native caller witness, serving permission, physical authority or migration authorization. It does not open any required actor. The native consumer must independently authenticate the actual request with LOG `VerifiedCaller`, verify exact originals with `bind_original_caller`, and retain a one-shot challenge bound to its own actor, wake, request and purpose before SQL, keys, custody or Engine access.

## HTTP source

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

## Evidence boundaries

The public synthetic vector in `services/server/src/features/next/fixtures/prekey-original-admission-v1.json` is generated independently with canonical CBOR and Ed25519 reference code, not release trust. Tests exercise real crypto, private production helpers without production exports, the actual HTTP route with substituted SQL, held COMMIT, and refusal paths. They do not qualify managed databases, a native actor bridge, device originals, nil admission, all-five coherence or operations.
