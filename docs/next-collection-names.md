# Cloud-copy collection names

A next cloud copy has one shared control-plane catalog label. Its UUID remains its identity. Names are display-only: they do not authorize content access, prove enrollment/readiness, change grants or keys, or rename local folders/files. Duplicate names are allowed. Device-local registry aliases are separate.

## Initial name

Both `POST /v1/next/collections/cloud-copy` (device proof) and `POST /v1/next/collections/cloud-copy/service` (account session) accept optional `display_name` alongside their existing fields. Omission uses `New collection`. The label is stored with the first registration and genesis transaction. Existing-collection retries never update it, including after a subsequent rename. Bootstrap response shapes and cryptographic create digests are unchanged.

Clients must capture the normalized initial-name intent in their original durable create outcome before any await/HTTP work. Omitted and explicitly supplied names are distinct intents, even if their displayed text is equal. A pending/unknown operation cannot change its name or collection target. Preserve older omitted-name outcomes and key custody. A separate explicit fresh create after completion may start a new operation/target.

## Rename

`PATCH /v1/next/collections/:id/name`

```json
{"display_name":"Research"}
```

Response (metadata only, `Cache-Control: no-store`):

```json
{"collection_id":"11111111-1111-4111-8111-111111111111","display_name":"Research"}
```

Only the current owning account may rename. The original ordinary desktop/CLI or dedicated installation credential must still be current; the exact registered device must have acknowledged, nonlost enrollment and current owner membership. An installation additionally needs explicit approval for this collection. Create consent alone does not authorize arbitrary renames. Revocation, removal, suspension, permanent deletion, a noncurrent/shadow/left collection and a frozen legacy migration refuse the mutation. No provider call is made; retained legacy/provider/archive labels are not renamed.

Writes serialize per collection and **last committed rename wins**. There is no CAS, revision, request-ID replay ledger or automatic retry. A lost/uncertain response remains UNKNOWN: refresh the authorized catalog and show the observed current name. Equality with the requested name is not proof that that request committed. An already-inflight request can commit after another rename; commit order, not user-intent time, determines the label. Any subsequent mutation needs a fresh explicit user intent.

The existing approved-collection list keeps exactly `collection_id`, `display_name`, `role`. Its cloud-copy label source is now the canonical CP column rather than a live legacy/device alias. Cached offline names are display-only, not authority or a committed offline rename.

## Validation and privacy

For new writes, reject nonstrings, malformed UTF-16, U+0000–001F/U+007F–009F controls and U+2028/U+2029 separators **before** trimming. Apply JavaScript `String.trim()`, require 1–200 UTF-16 code units (`length`), and perform no case/Unicode/path normalization. Render names as text and bind consequential selection/consent to the UUID, not a mutable label. Never automatically upload a local path/alias as a shared name.

Names are cleartext CP metadata. New private-sync (E2E) names and private rename are not enabled. Migration 0064 preserves already-cleartext legacy labels verbatim, including private/suspended-owner rows, without widening readers; a private row without a previous label remains NULL. Backfill prefers the same owner's hosted label, then the stable first nonremoved same-owner local registration. New cloud-copy registration supplies an explicit/default label; old unnamed cloud-copy writers have the same presentation default during a rolling upgrade. This is not an encrypted replicated settings record or a second synchronized name source.
