# Migration-source witness issuance

Source-only contract. This issuer is **not activation, native admission or raw-sealer permission**. The native current-revocation getter, authenticated actual-native admission observation, opaque native proof/Engine boundary, source checkpoint verification and durable deletion/rollback fences must qualify independently. Missing/denied peers fail closed; app sessions and application tokens are never accepted.

## Control-plane route

`POST /internal/v1/next/migration/collections/:id/source-witness`, authenticated by the existing dedicated migration token only. Use a canonical lowercase non-nil collection UUID and no body (or `{}`). Any caller-selected epoch, wake, source head, start claim, device, public key, origin or URL is rejected. Response `{witness:<canonical base64 CBOR>,expires_at:<Unix ms>}` is non-cacheable. No record payload, local path or private service key is returned or persisted.

The CP derives the legacy owner and immutable #652 account start claim from current rows. An account must still be active and legacy, started and not flipped; pause after start does not strand it. The preserved target is a current cloud copy, with the exact current hosted service device's nonzero public keys and a non-lost acknowledged enrolment. Pending device/CP-key revocation denies. Recheck account, collection, claim, device and keys under locks after network awaits, before signing. Successful issuance has a metadata-only audit event.

The trusted provider's existing authenticated `GET /internal/v1/collections/:id/legacy-migration` supplies a single-snapshot identity/head/state/drain result. This dedicated tiny response is streamed with a 4096-byte bound **before** JSON parsing, cancelling on overflow; redirects are refused. Other provider response limits are unchanged. Require exact source UUID, `migrating`, `in_flight==0`, valid timestamps and nonnegative safe-integer head/counts. Never round numeric JSON; unsupported unsafe numbers refuse. **Do not require `unresolved==0` or `applied_unreceipted==0`: expired unresolved writes cannot apply and applied writes are already in head.** Re-read after native observation and reject source head/start/run drift. Optional provider `migration_id` is rollback provenance, distinct from the CP account claim and not an eleventh signed field.

Launch is fence-first: H6 fence/drain precedes H2/H3, so `S0==S_final`. The H10 CP cutover table cannot supply a pre-H3 head. The issuer derives the frozen head from the current trusted provider; the bridge must compare its actual checkpoint `S_final`, and native `LegacySource` must verify the same source/head/state in its read transaction before effects.

## Native observation transport

Reuse the configured outgoing `cloudCopyBootstrap.hosted` URL/token, not an app/driver URL or the CP inbound service token. HTTPS only; redirects refused; bounded timeout/body. `POST /internal/v1/migration-admission` sends `{collection,challenge}` where challenge is fresh canonical base64 of 32 random bytes.

The proposed native endpoint returns `{schema:"mdbn-migration-admission/1",collection,device_id,epoch,wake,fault_generation,applied_head,authenticated_head,control_chain,challenge}`. Counters and head positions are canonical decimal u64 strings; chains are lowercase 32-byte hex; each head is `{seq,chain}`. Require exact target/device/challenge and applied/authenticated head equality. Values must originate from fresh actual `VerifiedHostedAdmission`, not SQL/batch IDs, cached labels or request fields. Log `head` key2 is retained-from, **not epoch**; CP batch IDs are **not native wake**. No response public key or root changes the release pins.

## Signed bytes

Outer canonical CBOR: `[1,claims_bytes,existingCpCert_map,sig_bstr64]`, at most4096 bytes. Exact ten claims:

`[1,target_uuid_bstr16,hosted_device_uuid_bstr16,epoch_u64,legacy_uuid_bstr16,S_final_u64,started_at_ms_i64,native_wake_u64,issued_at_ms_i64,expires_at_ms_i64]`

`started_at_ms` is floor(#652 database timestamp in Unix milliseconds), matching the existing start response. Signature is strict Ed25519 over existing `H("mdbase-next/migration-source/v1",claims_bytes) = SHA256(u8(len(label)) || ASCIIlabel || claims_bytes)`. It is not plain SHA, JSON, raw claims or log tokenSig. Existing policy signer and CpCert/root domain are unchanged; no new key custody. Positive TTL<=900000ms, within the certificate window; native requires `issued<=now<expiry` and current root/policy key release pins/revocation checks, even if a witness predates a revocation.

The public synthetic producer vector is `services/server/src/features/next/fixtures/migration-source-witness-v1.json`. Seeds are explicitly test-only, not credentials/pins. It covers maximum-u64 wake and exact cert/claims/digest/signature/envelope bytes. Producer tests and mocked authenticated-peer PostgreSQL tests do **not** qualify native authority or cross-runtime integration.

## Terminal boundaries

Signing or a SQL epoch alone cannot revoke an issued witness. Native captures/rechecks actual target head/chain/fault generation/epoch/wake/device at every effect. Deletion and rollback must commit native admission invalidation, and the permanent CP deletion registry must deny same-UUID revival, stale callbacks and restored rows. No production activation or serving permission is implied until these independent gates are qualified. Deleted status is not inferred from an absent row/404; the terminal registry/fence is a separate owned implementation.
