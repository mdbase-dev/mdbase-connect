# Current hosted migration claim

`GET /internal/v1/next/migration/collections/:id/claim` uses the existing dedicated migration token, canonical nonnil collection UUID and empty query/body contract. It is wired only with the existing migration routes. Ordinary sessions, app and hosted-service tokens cannot use it.

The bounded SQL transaction reads the same current started legacy owner used by source/fence/SHADOW bootstrap, preserves its exact microsecond `started_us`, and reads the existing immutable cloud-copy tuple under the canonical collection lock. It rechecks source/deletion/cutover eligibility after the target SQL awaits. No provider, key generation, outbox emission, activation or audit mutation occurs.

The versioned `mdbase-migration-claim/1` response contains `collection_id`, `owner_account`, `started_us` and `target`. The collection UUID is preserved for source and target. Before bootstrap, `target` is null; that is missing-target DATA, not permission. A present target contains `runtime: "shadow"`, the 16-byte `root_key_id` as lowercase hex, and `hosted: { device_id, sign_pk, kem_pk, noise_pk }`. Private wrapped material/KMS labels are not returned. Missing hosted data refuses; foreign owner, NEXT/private/left-sync target, malformed root or noncurrent source refuses rather than becoming a missing target. No escrow or app-grant proof is added.

`started_us` is the account's existing start claim, not an invented version, lease, provider migration UUID or Driver UUID. No timestamp is renewed. The response is noncacheable current CP DATA: it does not certify log append, accepted signed lineage, FULL key delivery, namespace admission, physical DO identity, settled effects or durable host commit.

A native H1 consumer must independently authenticate its actual fresh CPP channel, match the actual saved run/pending context, compare these facts to this Engine's native accepted originals/FULL observation, verify the actual physical target, and recheck currentness/settlement after awaits. This source slice implements no positive H1 factory, completion, rollback or serving front. No operational migration authorization follows from a response.
