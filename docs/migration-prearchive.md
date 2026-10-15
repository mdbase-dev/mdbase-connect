# Prearchive source authorization

Dedicated migration-token-only, LAB/staging-only paths:

- `POST /internal/v1/next/migration/cohorts/:name/capture/collections/:ordinal/fence`
- `POST /internal/v1/next/migration/cohorts/:name/capture/collections/:ordinal/drain`

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

No archive acceptance/start/flip, source restore, grants, user sessions, new
migration SQL or new timer implementation is added. Nonempty archive capture
still requires its separate qualified producer and ONE verifier.
