# Current hosted migration claim

`GET /internal/v1/next/migration/collections/:id/claim` uses the existing dedicated migration token, canonical nonnil collection UUID and empty query/body contract. It is wired only with the existing migration routes. Ordinary sessions, app and hosted-service tokens cannot use it.

The bounded SQL transaction reads the same current started legacy owner used by source/fence/SHADOW bootstrap, preserves its exact microsecond `started_us`, and reads the existing immutable cloud-copy tuple under the canonical collection lock. It rechecks source/deletion/cutover eligibility after the target SQL awaits. No provider, key generation, outbox emission, activation or audit mutation occurs.

The versioned `mdbase-migration-claim/1` response contains `collection_id`, `owner_account`, `started_us` and `target`. The collection UUID is preserved for source and target. Before bootstrap, `target` is null; that is missing-target DATA, not permission. A present target contains `runtime: "shadow"`, the 16-byte `root_key_id` as lowercase hex, and `hosted: { device_id, sign_pk, kem_pk, noise_pk }`. Private wrapped material/KMS labels are not returned. Missing hosted data refuses; foreign owner, NEXT/private/left-sync target, malformed root or noncurrent source refuses rather than becoming a missing target. No escrow or app-grant proof is added.

`started_us` is the account's existing start claim, not an invented version, lease, provider migration UUID or Driver UUID. No timestamp is renewed. The response is noncacheable current CP DATA: it does not certify log append, accepted signed lineage, FULL key delivery, namespace admission, physical DO identity, settled effects or durable host commit.

## Hosted-role challenge/read transaction

The hosted role separately uses `POST …/claim/challenge` and `POST …/claim/read`.
The signed one-use nonce binds the configured audience and locked current public
identity. Each HTTP operation owns one bounded SQL transaction; a pair remains
**two transactions**, with separate `BEGIN`, `SET LOCAL lock_timeout='5s'`,
`SET LOCAL statement_timeout='5s'`, and acknowledged `COMMIT`. The original 10s
DB-clock expiry, one-outstanding unique index, aggregate 20 guard and exact
single consume remain unchanged. Unknown COMMIT never produces claim success.

A private transaction-scoped reader acquires h/u/m locks before the canonical
collection advisory lock. The lock is acquired once per transaction, not once
per observation. It re-reads the source/parent/root/device/revocation facts before
and after the nonce operation: **four full observations per challenge/read pair**,
each retaining its own before/after source query. This is not a fact cache or a
caller-supplied `alreadyLocked` flag. The closure never escapes its transaction.

The SHADOW root is projected from the existing `FOR UPDATE` parent. The hosted
key and exact current-parent context are read together under `FOR SHARE OF
device, parent`, after the parent lock. The existing canonical permanent
revocation relation (including historical enrolments and same-row ordinal member
removal) is reused unchanged. Missing-target DATA and conflicting/corrupt-target
refusals also remain distinct for the operator GET; no parallel target reader or
new public representation is introduced.

With a complete target, static real-PG query fingerprints pin 38/40/42 client
SQL calls per pair for standard/CSV/DB-cohort routing, down from 48/50/52 on the
parent main. The 10 fewer calls are transport reductions, not fewer currentness
observations or a proven production latency saving. The single revocation query
already existed on that parent main and is not counted as new savings.

Qualification lives in `migration-claim-auth.postgres.test.ts`: all three routing
modes, real concurrent issue/consume, independent deletion/cutover insertion at
retained phases, same-transaction target/policy fault injection, real key/policy
writer exclusion, bounded lock failure and actual 40P01 deadlock, expiry and
unknown COMMIT read-back. A later authorized writer is serialized after the
transaction; these current facts are not a lease covering future writes.

A native H1 consumer must independently authenticate its actual fresh CPP channel, match the actual saved run/pending context, compare these facts to this Engine's native accepted originals/FULL observation, verify the actual physical target, and recheck currentness/settlement after awaits. This source slice implements no positive H1 factory, completion, rollback or serving front. No operational migration authorization follows from a response.
