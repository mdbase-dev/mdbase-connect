# Original invitation continuity after account migration

Only acceptance of an existing emailed invitation has a migration-specific sharing lock. Creation, management and global topology/archive/source freeze checks are unchanged. Acceptance remains an authenticated SQL transaction with no provider IO.

The acceptance lock first uses the original account/cohort locks, then requires actual NEXT authority and rechecks the same owner/authority under the collection lock. A migrating collection refuses with HTTP409, `Retry-After: 5`, `Cache-Control: no-store` and the shared canonical error body:

```json
{"error":{"code":"collection_migrating","message":"This collection is being upgraded, which usually takes a few minutes. Changes made while it's upgrading may not be saved. When it's finished, check your recent changes and make them again if they're missing.","details":{"retry_after_seconds":5}}}
```

For an archived completed cohort the read-only guard requires the original account flip ledger, complete current owned collection set, recomputed original cutover digest, NEXT/cloud-copy registry, original flip audit readback and completed cohort revision matching its accepted archive. It also recomputes the original entire cohort/account inventory digest. Labels, omitted/foreign collection IDs, changed digests and arbitrary unfreeze reasons do not authorize acceptance. Bounded inventory overflow refuses; it does not silently truncate.

The existing native-aware acceptance path consumes the same invitation ID/token/expiry and writes its exact immutable role/preset/actions/operations/record scope/file ceiling through the normal membership policy and outbox functions. It issues no replacement invite or email.

An account created on the next backend (`MDBASE_NEW_ACCOUNT_BACKEND=next`) has a flip record with no collections and no cohort membership. It never migrated, so its invitations are accepted normally. A flip record naming collections without a cohort membership is not treated as such an account and still refuses.

Tiny LAB fixtures have no archive acceptance. Their genuine original native verify/recovery completion producer is not implemented here, so even a guarded CP flip or audited unfreeze remains retryable. No new schema, caller completion flag or generic audit event substitutes for that producer.

## Evidence boundary

Isolated PostgreSQL/HTTP tests use public synthetic archive-verifier and cutover DATA through original guarded CP start/cutover/flip/completion APIs. They verify refusal/no side effects, original link/policy continuity, unchanged global freeze, target/expiry checks, forged terminal labels, altered cutover digest and freeform unfreeze refusal. They do not establish archive bytes, recovery, native H1, complete policy representability, timer import/delivery, serving authority or a live account migration.
