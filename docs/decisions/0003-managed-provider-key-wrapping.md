# ADR 0003: Managed hosted-provider key wrapping

- Status: accepted
- Date: 2026-08-02

## Context

Each hosted collection has a random 256-bit data-encryption key (DEK). The DEK
encrypts collection resources, records, history, operation receipts, and file
metadata. The current provider wraps every DEK with one 256-bit deployment
master key supplied through Render. PostgreSQL contains only wrapped DEKs and
ciphertext, but the deployment key cannot be rotated without rewriting every
collection and a lost key makes a restored database unreadable.

The managed service needs online rotation, an auditable use boundary, explicit
recovery behavior, and an idempotent migration from the existing local wrapper.
KMS must never receive record payloads or local-collection data.

## Decision

### Separate content encryption from key wrapping

`ProviderCrypto` continues to perform local authenticated content encryption.
Key wrapping is an asynchronous interface with two implementations:

- `local-aes-256-gcm-v1`, retained only to read and migrate existing values;
- `aws-kms-v1`, the managed-service writer and normal reader.

The active writer is configured explicitly. A deployment may have both readers
during migration, but it has exactly one active writer. A KMS deployment fails
closed if its KMS key ID, region, credentials, or legacy fallback required by
stored rows is missing.

### Self-describing wrap envelope

New wrapped values use a bounded, versioned binary envelope containing:

- a fixed mdbase key-envelope marker and envelope version;
- the wrapping scheme;
- the immutable KMS key ARN returned by KMS, never only an alias;
- the KMS ciphertext blob.

Existing AES-GCM envelopes are recognized only by their exact legacy format.
Unknown markers, versions, schemes, duplicate fields, oversized fields, and
malformed base64 are rejected. The envelope is not secret; it contains no
plaintext DEK or credential. Keeping the key reference with the ciphertext
makes inventory and recovery deterministic without adding wrapping columns to
every query that reads `wrapped_data_key`.

### KMS operation and context

The provider generates each DEK locally with the operating-system CSPRNG and
calls KMS `Encrypt`. Unwrap calls KMS `Decrypt` and supplies the complete
encryption context. Rotation tooling may use `ReEncrypt` only when both source
and destination contexts are preserved exactly; otherwise it decrypts a DEK in
bounded memory and immediately wraps it with the active writer.

The authenticated KMS encryption context contains:

- `mdbase:service = hosted-provider`;
- `mdbase:environment = staging` or `production`;
- `mdbase:purpose = collection-data-key` or `provider-key-check`;
- `mdbase:collection-id = <UUID>` for collection keys;
- `mdbase:envelope-version = 1`.

The same canonical purpose/collection identity remains authenticated by the
legacy wrapper's associated data. A ciphertext cannot be moved between
environments, purposes, or collections and still decrypt.

KMS calls have an explicit operation timeout, use the AWS SDK's bounded retry
policy, and map access denial, disabled/not-found keys, invalid ciphertext,
throttling, timeout, and unavailable-service failures to stable internal error
categories. Errors and tracing may include operation, environment, scheme, and
key ARN, but never plaintext keys, ciphertext blobs, credentials, record data,
or collection contents.

### Key hierarchy and identities

The managed account owns separate customer-managed keys and aliases:

- `alias/mdbase/hosted-provider/staging`;
- `alias/mdbase/hosted-provider/production`.

Singapore (`ap-southeast-1`) is primary because the Render services run there.
Keys are created as multi-Region-capable so a deliberately provisioned Sydney
(`ap-southeast-2`) replica can recover matching ciphertext. Staging receives a
replica for the recovery drill; production does not rely on one until its
policy and drill have been reviewed.

Human administration uses the MFA-backed IAM Identity Center role. Render uses
separate staging and production IAM workload users because Render currently has
no native AWS workload-identity federation and IAM Roles Anywhere would add a
CA, workload certificate, and credential helper to this small deployment. Each
user can use only its environment's key and exact encryption context. Access
keys are created outside infrastructure state, stored only in the matching
Render environment, and rotated with two overlapping keys. IAM Roles Anywhere
remains the preferred later replacement when its PKI lifecycle is justified.

### Provider key check and cache

The database provider-key check is wrapped by the same active wrapper and uses
the dedicated `provider-key-check` context. During migration the provider can
verify a legacy check with the legacy reader while writing KMS collection
envelopes. The migration switches the check only after inventory proves all
collection DEKs use the active managed key.

Successful DEK unwraps are cached only in process memory by collection ID,
envelope digest, and key reference. The cache is bounded by entry count and
time, never serialized, zeroizes evicted key bytes, and is discarded on restart.
The envelope digest prevents a stale cached DEK from surviving a database
rewrap. Administrative rewrap clears the affected entry.

### Migration and rotation

The administrative tool has read-only `inspect` and mutating `rewrap` modes.
It reports counts by envelope version/scheme/key reference and never prints
collection IDs, ciphertext, or plaintext keys. Rewrap:

1. locks one collection row with `FOR UPDATE SKIP LOCKED`;
2. unwraps using the envelope-selected reader and exact context;
3. wraps using the configured active writer;
4. updates only when the original envelope still matches;
5. commits that row before continuing;
6. records aggregate success, skipped, concurrent-change, and failure counts.

The command is idempotent, accepts a batch limit, supports dry-run, and can
resume after interruption. It refuses to migrate the provider-key check or
declare completion while any active/importing/deleting collection requires a
different reader. Legacy key access is removed only after a cold restart and a
full semantic staging exercise prove the inventory is entirely managed.

Alias rotation is deliberately not treated as DEK rotation. Moving an alias
changes only new writes. Existing envelopes retain the immutable old key ARN
until the rewrap tool migrates them. The old key is disabled only for a bounded
drill after inventory reaches zero, then retained according to the recovery
policy; deletion is never part of an online rotation.

## Failure and recovery behavior

- New collection creation fails without writing partial collection state when
  KMS wrapping fails.
- A cache miss fails closed when KMS cannot decrypt; cached DEKs may serve only
  until their short configured TTL and never make readiness claim KMS healthy.
- Readiness performs a bounded managed key-check decrypt, so a cold deployment
  cannot become ready solely from a warm cache.
- Wrong environment/context, revoked credentials, a disabled key, and a
  different multi-Region key all fail authentication.
- Database recovery uses the exact key ARN in each envelope. A recovery-region
  replica is accepted only when it shares the same multi-Region key ID and the
  recovery deployment supplies the original encryption context.
- Key deletion has a 30-day waiting period and is prohibited while any retained
  backup manifest references the key.

## Verification

The implementation requires:

- deterministic envelope parsing and legacy compatibility tests;
- fake-wrapper tests for denied, throttled, timed-out, disabled, missing,
  malformed, wrong-context, partial-migration, concurrency, and cache cases;
- database migration and idempotent rewrap tests;
- actual staging KMS encrypt/decrypt, audit, alias rotation, full rewrap,
  disabled-old-key, credential rotation, cold restart, and hosted semantic
  exercises;
- an isolated recovery using the Sydney replica and restored database/object
  set before the production key hierarchy is considered complete.

## Consequences

The provider gains an asynchronous dependency at DEK wrap/unwrap boundaries
and a small bounded memory cache. This is more complex than one local master
key, but it makes key identity, rotation, audit, and recovery explicit. KMS cost
is proportional to cache misses and collection creation/rotation rather than
record operations. The existing Render master key remains a temporary migration
secret and is removed from each environment only after live evidence proves no
stored envelope needs it.
