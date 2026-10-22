# Prearchive source authorization

Dedicated migration-token-only paths for the fixed LAB, staging and production environments:

- `POST /internal/v1/next/migration/cohorts/:name/capture/collections/:ordinal/fence`
- `POST /internal/v1/next/migration/cohorts/:name/capture/collections/:ordinal/drain`
- `POST /internal/v1/next/migration/cohorts/:name/capture/collections/:ordinal/unfence`

Fence accepts exactly `{binding,inventory_sha256}`. Drain additionally requires
`expected_run:{migration_id,started_at}` from the ORIGINAL fence reply. Binding is
exactly the four-field archive binding. Ordinal is zero-based in the complete
sorted account/collection export union resolved by CP; it is not a caller subset.
No URL, database, SQL, source-role, account, collection or readiness selectors.

Inventory SHA256 is `mdbase-prearchive-inventory/v1\n` followed by canonical compact
ASCII JSON of `{binding,members}`. Each original sorted member contributes
`{account_id,hosted_collections,terminal_excluded_at,export_collections}`. All
membership is included, terminal exports are empty. Freeze and observation time
are excluded from the digest: the original scope remains stable across freeze.
Bounds are 850 accounts, 1000 held collections and 1MiB, never truncated.

A fresh bounded CP transaction checks the full scope before source reads,
immediately before the fence effect and after the provider response. It checks
all nonterminal held collections, not filtered eligible rows: released cohort,
legacy backend, active settled authority, no quarantine/deletion/cutover/account
flip. Parent/member/held locks precede the cohort lock; no SQL locks cross provider
awaits. No global pause, account-start, accepted archive or target readiness gate
is introduced. Existing migration claim/witness paths still require account start.

The fence refuses an already migrating/retained source instead of adopting it.
It calls the existing provider fence with one bounded deadline and returns its
exact strictly decoded run identity. Drain calls the existing source/watermark
reader, requires that exact original run/start string, migrating/no retention and
zero in-flight work. Native H6 decides how retained unresolved/applied receipts
and external-I/O blockers settle; this API preserves their counts unchanged.
It does not replace native timer, key custody, external-I/O or readiness checks.

A failed/lost fence reply or post-effect CP drift returns
`migration_prearchive_effect_unknown`. It must stop the original Ops journal;
there is no automatic retry, replay, abort, route-back or replacement run.
A provider state reply alone is not an original-effect receipt. The caller saves
its original intent/BOOTTIME/boot identity before the first request and retains
both exact replies. Concurrency and the original archive/migration clock remain
owned by the ONE Ops frontdoor. Cross-database atomicity is not claimed.

## Unfence after a failed archive

A pre-archive fence puts the provider collection in `migrating`, where all
legacy I/O returns 409 `collection_migrating`. When the archive fails before
acceptance the account has no start claim, so the started-claim unfence and
rollback cannot return it. Unfence is that path, and only that path.

It accepts exactly `{binding,inventory_sha256}`, the CURRENT capture binding and
inventory digest (re-read `archive-binding?view=capture-v1` after freeze), and
resolves the ordinal and checks the full cohort scope exactly like fence/drain.
The run is never caller input: it is Connect's own latest
`next_migration.prearchive_fence` audit for the collection. Fences audited from
this version on also record the run's `started_at`; older audits carry only the
provider-minted `migration_id`, which then identifies the run alone.

Refusals, each before any provider effect (409 unless noted):

- `migration_prearchive_archive_accepted`: the cohort has any accepted archive.
- `migration_prearchive_account_started`: the member started, the account left
  the legacy backend or flipped, the collection cut over or has a queued
  `migration-cutover` policy. (A terminally excluded member leaves the export
  union, so its ordinal no longer resolves: `migration_prearchive_inventory_changed`.)
- `migration_prearchive_run_not_current`: no recorded pre-archive fence, a later
  started-account `next_migration.fence`, or the provider is not `migrating` on
  that `migration_id`/`started_at` without retention (or is `active` with no
  recorded unfence intent for the run).
- `migration_prearchive_replicas_revoked`: the run owns replica revocations,
  which `active` cannot restore.
- `migration_prearchive_authority_not_current`: `hosted_collections.authority_state`
  is not `active`, or the epoch differs from the one recorded with the intent.
- `migration_prearchive_inventory_changed`: binding, digest, ordinal or full scope.
- 503 `migration_prearchive_busy`: another migration step holds the collection's
  session lock (the same lock as the started-claim unfence/rollback/revocations),
  or a bounded database lock timed out.
- 503 `migration_prearchive_unavailable`: no environment/provider/source result.

The authority epoch is never changed and must be identical before and after.
Connect records `next_migration.prearchive_unfence_intent`
`{migration_id,started_at,authority_epoch,...}` before the provider call, calls
the provider's pre-cutover `migrating` to `active` transition once, rechecks and
records `next_migration.prearchive_unfence` `{migration_id,...}`. A lost reply or
post-effect drift is 503 `migration_prearchive_effect_unknown`. A later request
that finds the source still `migrating` on the same run reuses the intent and
dispatches again; one that finds it `active` with the intent recorded answers
done. Neither event is a started-account rollback step, so the account's
"postponed" copy (`migration-rollback-state.ts`) ignores both.

Success is 200:

```json
{"schema":"mdbase-migration-prearchive-unfence/1","binding":{...},"inventory_sha256":"...",
 "ordinal":0,"account_id":"...","collection_id":"...","outcome":"unfenced",
 "run":{"migration_id":"...","started_at":"..."},"authority_epoch":"1",
 "source":{"collection_id":"...","state":"active","migration_id":null,"started_at":null,"retain_until":null,"restored":[]}}
```

The idempotent answer is identical except `"outcome":"already_unfenced"`.

No archive acceptance/start/flip, grants, user sessions, new migration SQL or
new timer implementation is added. Nonempty archive capture
still requires its separate qualified producer and ONE verifier.
